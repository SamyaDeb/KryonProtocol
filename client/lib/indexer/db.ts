/**
 * The indexer's database access: real transactions on one pooled connection.
 * (`lib/sql.ts` is per-query and cannot hold a transaction open.) Server-side
 * only; the indexer is a long-lived process on a plain Postgres URL.
 */

import { Pool, type PoolClient } from "pg";

export type Row = Record<string, unknown>;

export interface Query {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Query {
  transaction<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export function pgDb(connectionString: string, max = 4): Db {
  const pool = new Pool({ connectionString, max });
  pool.on("error", (err) => console.error(`indexer pg pool error: ${err.message}`));
  const wrap = (c: Pool | PoolClient): Query => ({
    async query<T extends Row = Row>(text: string, params: unknown[] = []) {
      return (await c.query(text, params as never[])).rows as T[];
    },
  });
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client));
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}
