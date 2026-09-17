/**
 * Database access for the matcher.
 *
 * The matcher needs real transactions — the pending `Fill` rows for a batch go
 * in together or not at all — so it uses the pooled `Db` from the indexer's
 * `db.ts` rather than `lib/sql.ts`, which is per-query and cannot hold one
 * open. That module is plain `pg` plumbing with no indexer logic in it; it is
 * re-exported here so matcher code has one import for its database types.
 *
 * `PgTxJobStore` takes the `SqlClient` shape instead, so `txStoreSql` adapts a
 * `Query` to it. Server-side only.
 */

import { pgDb, type Db, type Query, type Row } from "@/lib/indexer/db";
import type { SqlClient } from "@/lib/sql";

export { pgDb };
export type { Db, Query, Row };

/**
 * A `SqlClient` façade over one `Query`, for `PgTxJobStore`.
 *
 * The store only ever calls `.query(text, params)`. The tagged-template and
 * `unsafe` halves of the interface exist to satisfy the type; reaching them
 * means a caller this adapter was not written for, so they throw rather than
 * quietly do something different from what `lib/sql.ts` would.
 */
export function txStoreSql(q: Query): SqlClient {
  const unsupported = (what: string) => () => {
    throw new Error(`txStoreSql does not support ${what}; use query(text, params)`);
  };
  const sql = unsupported("tagged templates") as unknown as SqlClient;
  sql.query = (<T = Row[]>(text: string, params: unknown[] = []) =>
    q.query(text, params) as unknown as Promise<T>) as SqlClient["query"];
  sql.unsafe = unsupported("unsafe()") as SqlClient["unsafe"];
  sql.end = async () => {};
  return sql;
}
