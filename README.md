# pg-rls-context

[![CI](https://github.com/jvsm2204/pg-rls-context/actions/workflows/ci.yml/badge.svg)](https://github.com/jvsm2204/pg-rls-context/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Safe multi-tenant Row-Level Security context for [node-postgres](https://github.com/brianc/node-postgres). It runs your queries inside a transaction with the tenant setting applied as `is_local`, so the context never leaks across a connection pool.

## The problem

Postgres Row-Level Security is a great way to isolate tenants. You write the policy once and the database enforces it on every query. The common pattern reads the tenant from a session setting:

```sql
CREATE POLICY tenant_isolation ON notes
  USING (tenant_id = current_setting('app.current_tenant', true));
```

The catch is how you set that value. A plain `SET app.current_tenant = '...'` sticks to the connection. With a pool, or a pooler like PgBouncer in transaction mode, that connection goes back to the pool still holding the last tenant's value, and the next request can read the wrong tenant's rows. I hit this the hard way on a multi-tenant app, and this is the small helper I wish I had at the time.

The fix is to set the value transaction-local, with `set_config(name, value, true)`, and keep the whole unit of work in a single transaction on a single connection. That is all this library does, carefully and with tests.

## Install

```bash
npm install github:jvsm2204/pg-rls-context pg
```

`pg` is a peer dependency, so you bring your own version.

## Usage

```ts
import { Pool } from "pg";
import { createRlsScope } from "pg-rls-context";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const rls = createRlsScope(pool, { tenantSetting: "app.current_tenant" });

// everything in here runs as tenant "acme" and only sees acme's rows
const notes = await rls.withTenant("acme", async (client) => {
  const res = await client.query("SELECT * FROM notes");
  return res.rows;
});
```

Need more than one setting, like tenant plus user? Use `withContext`:

```ts
await rls.withContext(
  { "app.current_tenant": "acme", "app.current_user": "42" },
  async (client) => {
    // ...
  },
);
```

If the callback throws, the transaction rolls back. If it returns, the transaction commits and you get its return value.

## Your RLS policy

This library sets the context, you still write the policy. A minimal example:

```sql
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON notes
  USING (tenant_id = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true));
```

`current_setting(name, true)` returns NULL when nothing is set, so a query outside any tenant scope sees no rows. That is fail-closed, which is what you want.

## API

- `createRlsScope(pool, options)` returns a scope bound to a `pg.Pool`.
  - `options.tenantSetting`: the setting name used by `withTenant`, for example `"app.current_tenant"`.
  - `options.readOnly`: run the transaction as READ ONLY. Defaults to false.
- `scope.withContext(context, fn)`: runs `fn(client)` in a transaction with each entry of `context` applied transaction-local.
- `scope.withTenant(tenantId, fn)`: shortcut for the single-tenant case. Requires `tenantSetting`.

## Tests

These are real integration tests against a Postgres instance, not mocks. They create a table with an RLS policy and check the things that actually matter: each tenant sees only its own rows, writes for the wrong tenant are rejected, the transaction rolls back on error, and the setting does not leak onto a reused connection. CI runs them against a Postgres service on every push.

To run them locally, point `DATABASE_URL` at a Postgres you can write to:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/rls_test
npm test
```

## License

MIT
