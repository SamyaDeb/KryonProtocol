/**
 * The one database capability the query helpers need: run a parameterised
 * statement and get rows back.
 *
 * Both `db(network)` (the per-query `lib/sql.ts` client the routes use) and a
 * transaction handle from `pgDb().transaction` (what order intake and the
 * matcher use) satisfy it structurally, so a helper written against this runs
 * unchanged inside or outside a transaction.
 */

export type Rows = Record<string, unknown>[];

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<Rows>;
}
