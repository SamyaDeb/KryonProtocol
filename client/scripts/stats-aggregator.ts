#!/usr/bin/env tsx
/**
 * stats-aggregator — rolls the indexer's projections into `TraderStat`,
 * `AccountAnalytics` and `LeaderboardSnapshot`, which is what
 * `/api/leaderboard` and `/api/portfolio/[address]` read.
 *
 * See lib/stats/aggregator.ts for the cursor and the incremental rule, and
 * lib/stats/metrics.ts for every metric's definition, scale and sign.
 *
 * Environment:
 *   KRYON_NETWORK               arc-mainnet | arc-testnet | arc-local — REQUIRED, no default
 *   DATABASE_URL[_MAINNET|_TESTNET|_LOCAL]   Postgres for that network (see lib/db.ts)
 *   STATS_INTERVAL_MS           incremental pass period (default 30000)
 *   STATS_SNAPSHOT_MS           leaderboard snapshot period (default 300000)
 *   STATS_SNAPSHOT_LIMIT        traders per snapshot (default 100)
 *   STATS_BATCH_SIZE            addresses recomputed per transaction (default 200)
 *   STATS_REBUILD_HOUR_UTC      hour of the nightly full recompute (default 0)
 *   LOG_LEVEL                   debug | info | warn | error (default info)
 *
 * Usage:
 *   npm run dev:stats                            # run forever
 *   npx tsx scripts/stats-aggregator.ts --once   # one pass, then exit
 *   npx tsx scripts/stats-aggregator.ts --rebuild  # full recompute from the projections, then exit
 *
 * Reads the indexer's tables and writes only the analytics tables. It holds no
 * key and sends no transaction.
 */

import { pgDb } from "@/lib/indexer/db";
import { createLogger, envInt, Metrics, shutdownSignal, systemClock, runLoop, type LogLevel } from "@/lib/keepers/runtime";
import { isArcNetworkId } from "@/lib/network";
import { indexedHead } from "@/lib/queries/analytics";
import { StatsAggregator } from "@/lib/stats/aggregator";

const SERVICE = "stats";

function databaseUrl(network: string): string {
  const explicit =
    network === "arc-mainnet"
      ? process.env.DATABASE_URL_MAINNET
      : network === "arc-testnet"
        ? process.env.DATABASE_URL_TESTNET
        : process.env.DATABASE_URL_LOCAL;
  const url = explicit ?? process.env.DATABASE_URL;
  if (!url) throw new Error(`No database configured for network "${network}"`);
  return url;
}

async function main() {
  const env = process.env;
  const log = createLogger(SERVICE, (env.LOG_LEVEL as LogLevel | undefined) ?? "info");

  // Explicit, never defaulted: these tables are per-venue, and aggregating one
  // network's events into another's leaderboard would be silent and wrong.
  const network = env.KRYON_NETWORK;
  if (!isArcNetworkId(network)) throw new Error(`KRYON_NETWORK must be set to an Arc network id; got "${network ?? ""}"`);

  const metrics = new Metrics();
  const db = pgDb(databaseUrl(network));
  const aggregator = new StatsAggregator({
    db,
    network,
    log,
    metrics,
    clock: systemClock,
    batchSize: envInt(env, "STATS_BATCH_SIZE", 200),
    snapshotEveryMs: envInt(env, "STATS_SNAPSHOT_MS", 300_000),
    snapshotLimit: envInt(env, "STATS_SNAPSHOT_LIMIT", 100),
    rebuildHourUtc: envInt(env, "STATS_REBUILD_HOUR_UTC", 0),
  });

  if (process.argv.includes("--rebuild")) {
    const now = new Date();
    const result = await aggregator.rebuild(now, "requested", await indexedHead(db, network));
    await aggregator.snapshot(now);
    log.info("rebuild finished", { ...result });
    await db.end();
    return;
  }

  if (process.argv.includes("--once")) {
    log.info("single pass", { ...(await aggregator.tick()) });
    await db.end();
    return;
  }

  const tickMs = envInt(env, "STATS_INTERVAL_MS", 30_000);
  const shutdown = shutdownSignal(log);
  log.info("stats aggregator starting", { network, tickMs });
  await runLoop({ tickMs, signal: shutdown.signal, log, metrics }, async () => {
    await aggregator.tick();
  });
  await db.end();
  log.info("stats aggregator stopped", metrics.snapshot());
  process.exit(0);
}

main().catch((err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", service: SERVICE, msg: "fatal", error: String(err) }));
  process.exit(1);
});
