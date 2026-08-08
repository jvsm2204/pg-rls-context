import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createRlsScope } from "../src/index";

const connectionString = process.env.DATABASE_URL;

describe("pg-rls-context", () => {
  let pool: Pool;

  beforeAll(async () => {
    if (!connectionString) {
      throw new Error("Set DATABASE_URL to a Postgres instance to run the tests.");
    }
    pool = new Pool({ connectionString, max: 4 });

    await pool.query("DROP TABLE IF EXISTS notes");
    await pool.query(`
      CREATE TABLE notes (
        id serial PRIMARY KEY,
        tenant_id text NOT NULL,
        body text NOT NULL
      )
    `);
    await pool.query("ALTER TABLE notes ENABLE ROW LEVEL SECURITY");
    // FORCE makes the table owner subject to the policy too, so the test
    // does not need a separate unprivileged role.
    await pool.query("ALTER TABLE notes FORCE ROW LEVEL SECURITY");
    await pool.query(`
      CREATE POLICY tenant_isolation ON notes
        USING (tenant_id = current_setting('app.current_tenant', true))
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true))
    `);

    // Seed rows inside each tenant context. The WITH CHECK clause means the
    // insert only succeeds when tenant_id matches the active tenant.
    const scope = createRlsScope(pool, { tenantSetting: "app.current_tenant" });
    await scope.withTenant("acme", (c) =>
      c.query("INSERT INTO notes (tenant_id, body) VALUES ('acme', 'a1'), ('acme', 'a2')"),
    );
    await scope.withTenant("globex", (c) =>
      c.query("INSERT INTO notes (tenant_id, body) VALUES ('globex', 'g1')"),
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DROP TABLE IF EXISTS notes");
      await pool.end();
    }
  });

  it("shows each tenant only its own rows", async () => {
    const scope = createRlsScope(pool, { tenantSetting: "app.current_tenant" });
    const acme = await scope.withTenant("acme", (c) => c.query("SELECT * FROM notes"));
    const globex = await scope.withTenant("globex", (c) => c.query("SELECT * FROM notes"));
    expect(acme.rowCount).toBe(2);
    expect(globex.rowCount).toBe(1);
    expect(globex.rows[0].body).toBe("g1");
  });

  it("returns no rows when no tenant is set (fail closed)", async () => {
    const res = await pool.query("SELECT * FROM notes");
    expect(res.rowCount).toBe(0);
  });

  it("does not leak the setting across pooled connections", async () => {
    // this is the test I actually care about. a pool of size 1 forces the next
    // query onto the same physical connection, which is exactly where a leaked
    // session setting would show up.
    const single = new Pool({ connectionString: connectionString!, max: 1 });
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
    const scope = createRlsScope(pool, { tenantSetting: "app.current_tenant" });
    await expect(
      scope.withTenant("acme", (c) =>
        c.query("INSERT INTO notes (tenant_id, body) VALUES ('globex', 'x')"),
      ),
    ).rejects.toThrow();
  });

  it("rolls back when the callback throws", async () => {
    const scope = createRlsScope(pool, { tenantSetting: "app.current_tenant" });
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

  it("isolates concurrent tenant scopes", async () => {
    const scope = createRlsScope(pool, { tenantSetting: "app.current_tenant" });
    const [acme, globex] = await Promise.all([
      scope.withTenant("acme", (c) => c.query("SELECT count(*)::int AS n FROM notes")),
      scope.withTenant("globex", (c) => c.query("SELECT count(*)::int AS n FROM notes")),
    ]);
    expect(acme.rows[0].n).toBe(2);
    expect(globex.rows[0].n).toBe(1);
  });
});
