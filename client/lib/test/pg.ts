/**
 * A disposable, migrated Postgres schema for database-backed tests.
 *
 * WHY A SCRATCH SCHEMA
 * --------------------
 * The API routes issue raw SQL, which `tsc` cannot check, so the only proof a
 * route matches the schema is running it against the schema. This harness
 * applies the real baseline migration (`kryon-protocol/prisma/migrations`) to a
 * fresh schema per test file and points both the test's own pool and the
 * routes' `db("arc-local")` client at it through `search_path`.
 *
 * A private schema rather than `public` because the runner starts test files in
 * parallel, and the matcher and indexer suites truncate the trading tables in
 * `public` (under a shared advisory lock). This harness never touches `public`:
 * it truncates and finally drops only the schema it created.
 *
 * Needs `KRYON_TEST_DATABASE_URL` pointing at a DISPOSABLE database — never a
 * shared or production one. Without it, `TEST_DATABASE_URL` is undefined and
 * suites skip themselves (`describe(..., { skip: !TEST_DATABASE_URL })`), as
 * the other database suites do.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";

import type { Queryable, Rows } from "@/lib/queries/client";

export const TEST_DATABASE_URL = process.env.KRYON_TEST_DATABASE_URL;

/** The network every fixture is written under; routes resolve to it via `?network=`. */
export const TEST_NETWORK = "arc-local" as const;

const MIGRATIONS_DIR = join(process.cwd(), "..", "kryon-protocol", "prisma", "migrations");

/** Every migration's SQL, in order. Today that is the Arc baseline alone. */
export function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((dir) => readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"))
    .join("\n");
}

/**
 * `search_path` routes every unqualified name to the scratch schema.
 * `TimeZone=UTC` because the Arc schema's timestamps are `TIMESTAMP(3)` without
 * a zone: node-postgres writes a JS `Date` in the process's local time, and
 * `extract(epoch …)` reads the stored value as UTC. The services run in UTC; a
 * developer laptop does not, so the tests pin both sides (see `createScratchDb`).
 */
function withSearchPath(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set("options", `-c search_path=${schema} -c TimeZone=UTC`);
  return u.toString();
}

export interface ScratchDb extends Queryable {
  schema: string;
  /** Connection string whose `search_path` is this schema. */
  url: string;
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Empty every table in this schema. */
  reset(): Promise<void>;
  /** Drop the schema and close the pool. */
  drop(): Promise<void>;
}

/**
 * Create `kryon_t_<label>_<pid>_<rand>`, apply the migrations to it, and return
 * a handle. Call `drop()` in `after`.
 */
export async function createScratchDb(label: string): Promise<ScratchDb> {
  if (!TEST_DATABASE_URL) throw new Error("KRYON_TEST_DATABASE_URL is not set");
  // Match production, where every service runs in UTC; see `withSearchPath`.
  process.env.TZ = "UTC";
  const schema = `kryon_t_${label.replace(/\W/g, "_")}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const c = await admin.connect();
    try {
      // Unqualified CREATE TYPE / CREATE TABLE land in the first schema on the
      // path, so the migration builds a private copy of the whole database.
      await c.query(`SET search_path TO "${schema}"`);
      await c.query(migrationSql());
    } finally {
      c.release();
    }
  } finally {
    await admin.end();
  }

  const url = withSearchPath(TEST_DATABASE_URL, schema);
  const pool = new Pool({ connectionString: url, max: 4 });
  pool.on("error", () => {});
  const wrap = (c: Pool | PoolClient): Queryable => ({
    async query(text: string, params: unknown[] = []): Promise<Rows> {
      return (await c.query(text, params as never[])).rows as Rows;
    },
  });

  return {
    schema,
    url,
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
    async reset() {
      const rows = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1`, [schema]);
      const tables = rows.rows.map((r) => `"${schema}"."${r.tablename}"`);
      if (tables.length > 0) await pool.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
    },
    async drop() {
      await pool.end();
      const a = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
      try {
        await a.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await a.end();
      }
    },
  };
}

/**
 * Point the app's own database client at `scratch` for the `arc-local`
 * network. Must run BEFORE any route (or `@/lib/network`) is imported:
 * `AVAILABLE_NETWORKS` is fixed at module load, so import routes dynamically
 * after calling this.
 */
export function routeEnv(scratch: ScratchDb): void {
  process.env.NEXT_PUBLIC_KRYON_NETWORK = TEST_NETWORK;
  process.env.NEXT_PUBLIC_KRYON_NETWORKS = TEST_NETWORK;
  process.env.DATABASE_URL_LOCAL = scratch.url;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

/** Close the routes' pooled client so the test process can exit. */
export async function closeRouteDb(): Promise<void> {
  const { db } = await import("@/lib/db");
  await db(TEST_NETWORK).end();
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// Each seeds one row with defaults valid under every CHECK in the baseline
// (lowercase addresses, 0x-hex hashes, NUMERIC as strings). Overrides take
// the column names verbatim, so a fixture that names a column the schema does
// not have fails the INSERT — the same drift this harness exists to catch.

export const E18 = 10n ** 18n;

export const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
export const b32 = (n: number | bigint): string => `0x${n.toString(16).padStart(64, "0")}`;

type Values = Record<string, unknown>;

async function insert(q: Queryable, table: string, values: Values): Promise<Rows> {
  const cols = Object.keys(values);
  const params = cols.map((c) => {
    const v = values[c];
    if (typeof v === "bigint") return v.toString();
    if (v !== null && typeof v === "object" && !(v instanceof Date)) return JSON.stringify(v);
    return v;
  });
  return q.query(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
    params
  );
}

export const DEFAULT_MARKET_PARAMS = {
  oracleId: b32(0xb7c),
  initialMarginBps: 1000,
  maintenanceMarginBps: 500,
  liquidationFeeBps: 50,
  maxExecutionDeviationBps: 75,
  maxOracleConfidenceBps: 100,
  maxOracleAge: 120,
  maxLeverageBps: 100000,
  active: true,
  listed: true,
  maxOpenInterest: (1_000n * E18).toString(),
  minFillNotional: (10n * E18).toString(),
};

export function seedMarket(q: Queryable, v: Values = {}): Promise<Rows> {
  return insert(q, "Market", {
    network: TEST_NETWORK,
    id: 2,
    symbol: "BTC-PERP",
    oracleId: b32(0xb7c),
    active: true,
    params: DEFAULT_MARKET_PARAMS,
    lastMark: 100_000n * E18,
    lastIndex: 100_000n * E18,
    updatedAt: new Date(),
    ...v,
  });
}

export function seedAccount(q: Queryable, v: Values = {}): Promise<Rows> {
  return insert(q, "Account", { network: TEST_NETWORK, address: addr(0xa11ce), updatedAt: new Date(), ...v });
}

let orderSeq = 0;
export function seedOrder(q: Queryable, v: Values = {}): Promise<Rows> {
  orderSeq += 1;
  return insert(q, "Order", {
    orderHash: b32(0x0de0000n + BigInt(orderSeq)),
    network: TEST_NETWORK,
    owner: addr(0xa11ce),
    marketId: 2,
    isLong: true,
    size: E18,
    limitPrice: 100_000n * E18,
    reduceOnly: false,
    nonce: BigInt(orderSeq),
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature: "0x" + "ab".repeat(65),
    updatedAt: new Date(),
    ...v,
  });
}

let fillSeq = 0;
/** A PENDING fill unless `status: "SETTLED"`, which also fills the chain columns. */
export function seedFill(q: Queryable, v: Values = {}): Promise<Rows> {
  fillSeq += 1;
  const settled = v.status === "SETTLED";
  return insert(q, "Fill", {
    network: TEST_NETWORK,
    fillId: b32(0xf1110000n + BigInt(fillSeq)),
    marketId: 2,
    maker: addr(0xb0b),
    taker: addr(0xa11ce),
    makerOrderHash: b32(1),
    takerOrderHash: b32(2),
    takerIsBuy: true,
    size: E18 / 10n,
    price: 100_000n * E18,
    ...(settled ? { txHash: b32(0x7a0000n + BigInt(fillSeq)), logIndex: 0, blockNumber: BigInt(fillSeq) } : {}),
    updatedAt: new Date(),
    ...v,
  });
}

export function seedPosition(q: Queryable, v: Values = {}): Promise<Rows> {
  return insert(q, "Position", {
    network: TEST_NETWORK,
    trader: addr(0xa11ce),
    marketId: 2,
    size: 2n * E18,
    openNotional: 200_000n * E18,
    lastPrice: 100_000n * E18,
    lastBlockNumber: 1n,
    lastLogIndex: 0,
    updatedAt: new Date(),
    ...v,
  });
}

export function seedRow(q: Queryable, table: string, v: Values): Promise<Rows> {
  return insert(q, table, v);
}
