import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createRlsScope } from "../src/index";

const baseUrl = process.env.DATABASE_URL;

// Superusers (and BYPASSRLS roles) ignore RLS, so the app has to connect as a
// plain, unprivileged role for the policies to actually kick in. That is also
// how you run it in production: the app role never has BYPASSRLS. The admin
// pool (whatever DATABASE_URL points at) is only used to set the schema up.
function appConnectionString(): string {
  const u = new URL(baseUrl!);
  u.username = "rls_app";
  u.password = "rls_app_pw";
  return u.toString();
}

describe("pg-rls-context", () => {
  let admin: Pool;
  let app: Pool;

  beforeAll(async () => {
    if (!baseUrl) {
      throw new Error("Set DATABASE_URL to a Postgres instance to run the tests.");
    }
    admin = new Pool({ connectionString: baseUrl });

    await admin.query("DROP TABLE IF EXISTS notes");
    await admin.query("DROP ROLE IF EXISTS rls_app");
    await admin.query("CREATE ROLE rls_app LOGIN PASSWORD 'rls_app_pw' NOSUPERUSER NOBYPASSRLS");

    await admin.query(`
      CREATE TABLE notes (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        tenant_id text NOT NULL,
        body text NOT NULL
      )
    `);
    await admin.query("ALTER TABLE notes ENABLE ROW LEVEL SECURITY");
    await admin.query("ALTER TABLE notes FORCE ROW LEVEL SECURITY");
    await admin.query(`
      CREATE POLICY tenant_isolation ON notes
        USING (tenant_id = current_setting('app.current_tenant', true))
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true))
    `);
    await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO rls_app");

    app = new Pool({ connectionString: appConnectionString(), max: 4 });

    // Seed inside each tenant context. The WITH CHECK clause means the insert
    // only succeeds when tenant_id matches the active tenant.
    const scope = createRlsScope(app, { tenantSetting: "app.current_tenant" });
    await scope.withTenant("acme", (c) =>
      c.query("INSERT INTO notes (tenant_id, body) VALUES ('acme', 'a1'), ('acme', 'a2')"),
    );
    await scope.withTenant("globex", (c) =>
      c.query("INSERT INTO notes (tenant_id, body) VALUES ('globex', 'g1')"),
    );
  });

  afterAll(async () => {
    if (app) await app.end();
    if (admin) {
      await admin.query("DROP TABLE IF EXISTS notes");
      await admin.query("DROP ROLE IF EXISTS rls_app");
      await admin.end();
    }
  });

  it("shows each tenant only its own rows", async () => {
    const scope = createRlsScope(app, { tenantSetting: "app.current_tenant" });
    const acme = await scope.withTenant("acme", (c) => c.query("SELECT * FROM notes"));
    const globex = await scope.withTenant("globex", (c) => c.query("SELECT * FROM notes"));
    expect(acme.rowCount).toBe(2);
    expect(globex.rowCount).toBe(1);
    expect(globex.rows[0].body).toBe("g1");
  });

  it("returns no rows when no tenant is set (fail closed)", async () => {
    const res = await app.query("SELECT * FROM notes");
    expect(res.rowCount).toBe(0);
  });

  it("does not leak the setting across pooled connections", async () => {
    // this is the test I actually care about. a pool of size 1 forces the next
    // query onto the same physical connection, which is exactly where a leaked
    // session setting would show up.
    const single = new Pool({ connectionString: appConnectionString(), max: 1 });
    try {
      const scope = createRlsScope(single, { tenantSetting: "app.current_tenant" });
      const inside = await scope.withTenant("acme", (c) =>
        c.query("SELECT current_setting('app.current_tenant', true) AS t"),
      );
      expect(inside.rows[0].t).toBe("acme");

      const outside = await single.query(
        "SELECT current_setting('app.current_tenant', true) AS t",
      );
      expect(outside.rows[0].t ?? "").toBe("");
    } finally {
      await single.end();
    }
  });

  it("enforces WITH CHECK on writes for the wrong tenant", async () => {
    const scope = createRlsScope(app, { tenantSetting: "app.current_tenant" });
    await expect(
      scope.withTenant("acme", (c) =>
        c.query("INSERT INTO notes (tenant_id, body) VALUES ('globex', 'x')"),
      ),
    ).rejects.toThrow();
  });

  it("rolls back when the callback throws", async () => {
    const scope = createRlsScope(app, { tenantSetting: "app.current_tenant" });
    await expect(
      scope.withTenant("acme", async (c) => {
        await c.query("INSERT INTO notes (tenant_id, body) VALUES ('acme', 'temp')");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const after = await scope.withTenant("acme", (c) =>
      c.query("SELECT count(*)::int AS n FROM notes"),
    );
    expect(after.rows[0].n).toBe(2);
  });

  it("treats a hostile tenant id as data, not SQL", async () => {
    // if the tenant id were pasted into SQL instead of bound as a parameter,
    // this string would break out and drop the table. it must not. a security
    // helper with a SQL injection hole would be a bad joke.
    const scope = createRlsScope(app, { tenantSetting: "app.current_tenant" });
    const evil = "acme'; DROP TABLE notes; --";
    const res = await scope.withContext({ "app.current_tenant": evil }, (c) =>
      c.query("SELECT current_setting('app.current_tenant', true) AS t"),
    );
    // the value round-trips verbatim, so it went in as data, not code
    expect(res.rows[0].t).toBe(evil);
    // and the table is obviously still there
    const still = await app.query("SELECT to_regclass('public.notes')::text AS t");
    expect(still.rows[0].t).toBe("notes");
  });

  it("isolates concurrent tenant scopes", async () => {
    const scope = createRlsScope(app, { tenantSetting: "app.current_tenant" });
    const [acme, globex] = await Promise.all([
      scope.withTenant("acme", (c) => c.query("SELECT count(*)::int AS n FROM notes")),
      scope.withTenant("globex", (c) => c.query("SELECT count(*)::int AS n FROM notes")),
    ]);
    expect(acme.rows[0].n).toBe(2);
    expect(globex.rows[0].n).toBe(1);
  });
});
