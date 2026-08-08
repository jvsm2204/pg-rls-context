import type { Pool, PoolClient } from "pg";

/**
 * A map of Postgres settings (GUCs) to apply for the scope, for example
 * { "app.current_tenant": "acme", "app.current_user": "42" }.
 */
export type RlsContext = Record<string, string>;

export interface RlsScopeOptions {
  /**
   * The setting name your RLS policies read for the tenant, for example
   * "app.current_tenant". Required to use withTenant().
   */
  tenantSetting?: string;
  /**
   * Run the scoped transaction as READ ONLY. Defaults to false.
   */
  readOnly?: boolean;
}

export interface RlsScope {
  /**
   * Runs `fn` inside a transaction with `context` applied as
   * transaction-local settings. The settings are set with is_local = true,
   * so Postgres discards them when the transaction ends. They can never
   * leak to another query that reuses the same pooled connection.
   */
  withContext<T>(context: RlsContext, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /**
   * Convenience for the common single-tenant case. Requires the
   * `tenantSetting` option to be configured.
   */
  withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

/**
 * Creates a helper that runs work inside a tenant-scoped transaction, so
 * your Postgres Row-Level Security policies see the right tenant context
 * and nothing leaks across a connection pool.
 */
export function createRlsScope(pool: Pool, options: RlsScopeOptions = {}): RlsScope {
  const { tenantSetting, readOnly = false } = options;

  async function withContext<T>(
    context: RlsContext,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      // one client, one transaction. the context and the queries have to stay
      // on the same connection, otherwise the whole thing is pointless.
      await client.query("BEGIN");
      if (readOnly) {
        await client.query("SET TRANSACTION READ ONLY");
      }
      // is_local = true is the part that matters. the setting only lives for
      // this transaction, so Postgres drops it on commit/rollback. skip that
      // and a connection going back to the pool keeps the last tenant's value,
      // and the next request happily reads someone else's rows. been there.
      // bonus: set_config takes name and value as bind params, so there is no
      // string building and no injection surface.
      for (const [name, value] of Object.entries(context)) {
        await client.query("SELECT set_config($1, $2, true)", [name, value]);
      }
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore a rollback failure so the original error is what surfaces.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  function withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!tenantSetting) {
      throw new Error(
        "withTenant requires the 'tenantSetting' option, for example 'app.current_tenant'.",
      );
    }
    return withContext({ [tenantSetting]: tenantId }, fn);
  }

  return { withContext, withTenant };
}
