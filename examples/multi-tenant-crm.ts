/**
 * Runnable example: a multi-tenant CRM with pg-rls-context.
 *
 * It creates a small `leads` table protected by Row-Level Security, seeds two
 * companies, and shows that each company only ever sees its own leads, with the
 * tenant context applied transaction-local so nothing leaks across the pool.
 *
 * Run it against a throwaway Postgres:
 *   export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
 *   npx tsx examples/multi-tenant-crm.ts
 *
 * Note: superusers bypass RLS, so the app connects as a plain unprivileged role.
 * That is also how you run it in production: your app role never has BYPASSRLS.
 */
import { Pool } from "pg";
import { createRlsScope } from "../src/index";

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) {
  console.error("Set DATABASE_URL to a Postgres you can write to.");
  process.exit(1);
}

// the app connects as this unprivileged role, so RLS actually applies to it
function appUrl(): string {
  const u = new URL(adminUrl!);
  u.username = "crm_app";
  u.password = "crm_app_pw";
  return u.toString();
}

async function main(): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl });

  // Schema setup. In a real app this lives in a migration, not in the handler.
  await admin.query("DROP TABLE IF EXISTS leads");
  await admin.query("DROP ROLE IF EXISTS crm_app");
  await admin.query("CREATE ROLE crm_app LOGIN PASSWORD 'crm_app_pw' NOSUPERUSER NOBYPASSRLS");
  await admin.query(`
    CREATE TABLE leads (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      company_id text NOT NULL,
      name text NOT NULL,
      stage text NOT NULL DEFAULT 'new'
    )
  `);
  await admin.query("ALTER TABLE leads ENABLE ROW LEVEL SECURITY");
  await admin.query("ALTER TABLE leads FORCE ROW LEVEL SECURITY");
  await admin.query(`
    CREATE POLICY company_isolation ON leads
      USING (company_id = current_setting('app.current_company', true))
      WITH CHECK (company_id = current_setting('app.current_company', true))
  `);
  await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON leads TO crm_app");

  // The app: one scope bound to the pool, using company_id as the tenant key.
  const pool = new Pool({ connectionString: appUrl() });
  const rls = createRlsScope(pool, { tenantSetting: "app.current_company" });

  // Seed each company's leads inside its own scope.
  await rls.withTenant("acme", (db) =>
    db.query("INSERT INTO leads (company_id, name) VALUES ('acme', 'Ada'), ('acme', 'Alan')"),
  );
  await rls.withTenant("globex", (db) =>
    db.query("INSERT INTO leads (company_id, name) VALUES ('globex', 'Grace')"),
  );

  // Each company sees only its own leads.
  const acme = await rls.withTenant("acme", (db) => db.query("SELECT name FROM leads"));
  const globex = await rls.withTenant("globex", (db) => db.query("SELECT name FROM leads"));
  console.log("acme sees:  ", acme.rows.map((r) => r.name)); // [ 'Ada', 'Alan' ]
  console.log("globex sees:", globex.rows.map((r) => r.name)); // [ 'Grace' ]

  // Outside any tenant scope, the policy returns nothing. Fail closed.
  const nobody = await pool.query("SELECT name FROM leads");
  console.log("no tenant set sees:", nobody.rows.map((r) => r.name)); // []

  // Cleanup.
  await pool.end();
  await admin.query("DROP TABLE IF EXISTS leads");
  await admin.query("DROP ROLE IF EXISTS crm_app");
  await admin.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
