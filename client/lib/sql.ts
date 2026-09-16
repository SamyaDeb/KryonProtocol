/**
 * Database driver — a Neon-compatible `sql` client backed by open-source
 * PostgreSQL.
 *
 * WHY THIS EXISTS
 * ---------------
 * The stack was bound to Neon's serverless HTTP driver. Neon bills *compute
 * time*, and an always-on trading backend never lets the compute autosuspend:
 * the matcher, indexer and reconciler poll continuously, so the database runs
 * ~730 h/month against a 191.9 h/month free allowance. It therefore blew the
 * quota (HTTP 402) roughly a week into every billing cycle, and stayed dead
 * from 2026-07-10 — a 21-day silent outage — because nothing alerted.
 *
 * Self-hosted Postgres has no compute meter, so that failure mode disappears.
 *
 * The API surface below is deliberately identical to `neon()`'s, so call sites
 * did not have to change beyond their import specifier:
 *
 *   sql`SELECT ...`          → Promise<Row[]>          (tagged template)
 *   sql.query(text, params)  → Promise<Row[]>          (rows directly, NOT { rows })
 *   sql.unsafe(str)          → raw SQL spliced into a template, not parameterised
 *
 * A `*.neon.tech` URL still routes to the real Neon driver, so pointing
 * DATABASE_URL back at Neon keeps working unchanged.
 */

import { neon as neonHttp, neonConfig as neonHttpConfig } from "@neondatabase/serverless";
import { Pool, type PoolConfig } from "pg";

/** Marker for raw SQL that must be spliced literally rather than parameterised. */
class RawSql {
  constructor(public readonly text: string) {}
}

// Deliberately `any`, not `unknown`: this mirrors Neon's own row type. Call
// sites already do `new Date(r.createdAt)` and `Number(r.rank)` against it, so
// tightening this here would mean casting at ~100 unrelated call sites for no
// safety the driver ever actually provided.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export interface SqlClient {
  // Generic in the row type, like the Neon driver this stands in for. Call
  // sites written as `sql<JobRow[]>` were not typechecking at all — not because
  // they were wrong, but because `scripts/` was excluded from tsconfig, so the
  // dropped generic went unnoticed and every such query silently degraded to
  // `Row[]` (`Record<string, any>`), erasing the row shape the caller declared.
  <T = Row[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  query<T = Row[]>(text: string, params?: unknown[]): Promise<T>;
  unsafe(text: string): RawSql;
  end(): Promise<void>;
}

/**
 * Neon-compatible alias so call sites keep their existing type annotations.
 * The two type parameters are Neon's (arrayMode, fullResults); they are part of
 * the signature we are standing in for, not something this driver varies on.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type NeonQueryFunction<_A extends boolean = false, _B extends boolean = false> = SqlClient;

function isNeonUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".neon.tech");
  } catch {
    return false;
  }
}

// One pool per connection string per process. The services are long-lived, so
// pooling matters: a fresh connection per query would swamp a small box.
const pools = new Map<string, Pool>();

/** `pg` marks a pool `ending`/`ended`; neither is in the published typings. */
function poolIsDead(pool: Pool): boolean {
  const p = pool as unknown as { ending?: boolean; ended?: boolean };
  return p.ending === true || p.ended === true;
}

function getPool(url: string): Pool {
  let pool = pools.get(url);
  // A pool that has been ended can never serve another query ("Cannot use a
  // pool after calling end on the pool"). Because pools are shared per URL, one
  // caller ending it — matcher-service.ts does exactly that to recover from
  // repeated tick errors — would otherwise poison every other module holding a
  // client over the same instance, permanently, until the process restarted.
  // Treat an ended pool as absent so the next query transparently rebuilds it.
  if (pool && !poolIsDead(pool)) return pool;
  if (pool) pools.delete(url);

  const cfg: PoolConfig = {
    connectionString: url,
    // The VM is a 945MB shared-core box also running seven Node services, so
    // keep the footprint small: Postgres allocates work_mem per connection.
    max: Number(process.env.PG_POOL_MAX ?? "6"),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? "30000"),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? "10000"),
  };
  // Local/VM Postgres over loopback has no TLS; anything remote must keep it.
  if (/\bsslmode=disable\b/.test(url)) cfg.ssl = false;
  else if (!/localhost|127\.0\.0\.1/.test(url)) cfg.ssl = { rejectUnauthorized: false };

  pool = new Pool(cfg);
  // A pool that emits 'error' with no listener crashes the process — these are
  // idle-client errors (server restart, network blip); the pool reconnects.
  pool.on("error", (err) => {
    console.error(`pg pool error: ${err.message}`);
  });
  pools.set(url, pool);
  return pool;
}

/**
 * Build a parameterised query from a tagged template, splicing RawSql values
 * literally and turning everything else into $1..$n placeholders.
 */
function buildQuery(strings: TemplateStringsArray, values: unknown[]): { text: string; params: unknown[] } {
  let text = "";
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v instanceof RawSql) text += v.text;
      else {
        params.push(v);
        text += `$${params.length}`;
      }
    }
  }
  return { text, params };
}

/**
 * `neon()`-compatible factory. Returns the real Neon HTTP driver for a
 * *.neon.tech URL, and a pg-backed equivalent for any other Postgres.
 */
export function neon(url: string): SqlClient {
  if (isNeonUrl(url)) return neonHttp(url) as unknown as SqlClient;

  // Resolve the pool per query rather than capturing it here. Capturing meant a
  // client built before someone else called .end() kept querying the dead pool
  // forever; going through getPool() each time lets a rebuilt pool be picked up
  // transparently by every existing client.
  getPool(url); // fail fast on a malformed URL at construction time

  const client = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { text, params } = buildQuery(strings, values);
    const res = await getPool(url).query(text, params as never[]);
    return res.rows as Row[];
  }) as SqlClient;

  // Neon's .query resolves to the rows array itself, not a QueryResult.
  // Generic to match the interface: the caller declares the row shape, exactly
  // as it does for the tagged-template form.
  client.query = async <T = Row[]>(text: string, params: unknown[] = []) => {
    const res = await getPool(url).query(text, params as never[]);
    return res.rows as T;
  };
  client.unsafe = (text: string) => new RawSql(text);
  client.end = async () => {
    const pool = pools.get(url);
    pools.delete(url);
    if (pool) await pool.end();
  };

  return client;
}

/**
 * No-op stand-in for Neon's global config. `fetchConnectionCache` was a
 * Neon-HTTP concern and has no analogue for a real connection pool; assigning
 * to it stays harmless so call sites need no conditional.
 */
export const neonConfig: Record<string, unknown> = new Proxy(
  {},
  {
    get: (_t, prop) => (neonHttpConfig as unknown as Record<string | symbol, unknown>)[prop],
    set: (_t, prop, value) => {
      try {
        (neonHttpConfig as unknown as Record<string | symbol, unknown>)[prop] = value;
      } catch {
        /* not applicable to the pg path */
      }
      return true;
    },
  }
);
