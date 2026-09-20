#!/usr/bin/env tsx
/**
 * The matcher: one shard (plan §4.2.7, roadmap Phase 3 step 4).
 *
 * Matches the resting book off-chain and settles the fills on Arc through
 * `OrderGateway.settleFillsSigned`. The engine is `lib/market/matching-engine`,
 * the runtime is `lib/matcher/`; this file is configuration, logging, health
 * and signals, and nothing else.
 *
 * One process, one operator key, one set of markets. `TxSender` owns the nonce
 * for its key, so two processes must never share one: a second shard gets its
 * own key and its own `MATCHER_MARKETS`.
 *
 * Environment:
 *   KRYON_NETWORK            arc-mainnet | arc-testnet | arc-local
 *   DATABASE_URL             Postgres for that network (migrated baseline)
 *   KRYON_DEPLOYMENT_FILE    deployment record, or the CONTRACT_* variables
 *   KRYON_SIGNER_MATCHER_OPERATOR  where the OPERATOR_ROLE key lives: kms:<keyId> |
 *                            keystore | env (arc-local only); see lib/chain/signer.ts
 *   MATCHER_OPERATOR_KEY     raw hex key, env mode only
 *   MATCHER_MARKETS          market ids this shard matches, comma separated
 *   MATCHER_SHARD            shard name for logs (default: the market list)
 *   MATCHER_INTERVAL_MS      tick interval (default 1000)
 *   MATCHER_MIN_BATCH_FILLS  gas-resize floor (default 1)
 *   MATCHER_ORPHAN_GRACE_MS  age before recovery judges an unlinked fill (default 60000)
 *   MATCHER_REJECT_BACKOFF_MS      wait after a retryable rejection, doubling (default 2000)
 *   MATCHER_REJECT_BACKOFF_MAX_MS  ceiling on that wait (default 60000)
 *   MATCHER_REJECT_PARK_AFTER      strikes before an order is parked (default 5)
 *   MATCHER_REJECT_FORGET_MS       how long a strike record survives (default 300000)
 *   MATCHER_HEALTH_PORT      health/metrics endpoint; unset disables it
 *   ARC_RPC_URLS             paid providers, comma separated (public RPC last)
 *
 * Usage:
 *   npm run dev:matcher
 *   MATCHER_MARKETS=2,3 npx tsx scripts/matcher-service.ts
 */

import { createServer, type Server } from "node:http";

import { assertChainId, createArcPublicClient, serviceAccount } from "../lib/chain/clients";
import { serverContracts } from "../lib/chain/contracts-env";
import { arcNetwork, serverNetworkId } from "../lib/chain/networks";
import { TxSender } from "../lib/chain/tx-sender";
import { PgTxJobStore } from "../lib/chain/tx-store-pg";
import { pgDb, txStoreSql } from "../lib/matcher/db";
import { Matcher, type Logger } from "../lib/matcher/loop";
import { newMetrics, snapshot, type MatcherMetrics } from "../lib/matcher/metrics";
import { assertServiceConfig } from "../lib/config-check";

const SERVICE = "matcher";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The markets this shard owns. Required, never defaulted: a shard that quietly
 * matched every market would compete with its siblings for the same orders and
 * both would reserve the same size.
 */
function marketIds(): number[] {
  const ids = required("MATCHER_MARKETS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const id = Number(s);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`MATCHER_MARKETS has a bad market id "${s}"`);
      return id;
    });
  if (ids.length === 0) throw new Error("MATCHER_MARKETS is empty");
  if (new Set(ids).size !== ids.length) throw new Error("MATCHER_MARKETS repeats a market id");
  return ids;
}

/** One JSON object per line, so the fields survive log aggregation. */
function jsonLogger(shard: string): Logger {
  const emit = (level: string, event: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify(
      { ts: new Date().toISOString(), level, service: SERVICE, shard, event, ...fields },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v)
    );
    if (level === "error") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

/** `GET /health` → the metrics snapshot. Nothing else is served. */
function startHealthServer(metrics: MatcherMetrics, shard: string, operator: string): Server | null {
  const port = Number(process.env.MATCHER_HEALTH_PORT ?? "0");
  if (!port) return null;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: SERVICE, shard, operator, ...snapshot(metrics) }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  server.unref();
  return server;
}

async function main() {
  // Every configuration problem at once, before anything connects or signs.
  assertServiceConfig("matcher");
  const network = arcNetwork(serverNetworkId());
  const contracts = serverContracts(network);
  const markets = marketIds();
  const shard = process.env.MATCHER_SHARD ?? markets.join(",");
  const log = jsonLogger(shard);

  const db = pgDb(required("DATABASE_URL"));
  const client = createArcPublicClient(network);
  const signer = await serviceAccount("MATCHER_OPERATOR_KEY", network);

  await assertChainId(client, network);

  const sender = new TxSender({
    network,
    service: SERVICE,
    chain: client,
    signer,
    store: new PgTxJobStore(txStoreSql(db)),
  });

  const metrics = newMetrics();
  const matcher = new Matcher({
    db,
    network,
    contracts,
    chain: client,
    sender,
    marketIds: markets,
    pollMs: Number(process.env.MATCHER_INTERVAL_MS ?? "1000"),
    minBatchFills: Number(process.env.MATCHER_MIN_BATCH_FILLS ?? "1"),
    orphanGraceMs: Number(process.env.MATCHER_ORPHAN_GRACE_MS ?? "60000"),
    // An order the chain refuses waits before being offered again, longer
    // each time. Without this the same fill is re-offered every tick and the
    // operator pays gas for every rejection.
    cooldown: {
      baseMs: Number(process.env.MATCHER_REJECT_BACKOFF_MS ?? "2000"),
      maxMs: Number(process.env.MATCHER_REJECT_BACKOFF_MAX_MS ?? "60000"),
      parkAfter: Number(process.env.MATCHER_REJECT_PARK_AFTER ?? "5"),
      forgetAfterMs: Number(process.env.MATCHER_REJECT_FORGET_MS ?? "300000"),
    },
    log,
    metrics,
  });

  const health = startHealthServer(metrics, shard, signer.address);
  log.info("starting", {
    network: network.id,
    chainId: network.chainId,
    operator: signer.address,
    gateway: contracts.orderGateway,
    markets,
  });

  // A shutdown signal stops the loop after the current batch. A second one is
  // someone who means it, and leaves the in-flight batch to recovery.
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (stopping) {
        log.warn("forced_exit", { signal: sig });
        process.exit(1);
      }
      stopping = true;
      log.info("shutdown_requested", { signal: sig });
      void matcher.stop();
    });
  }

  try {
    await matcher.run();
  } finally {
    health?.close();
    await db.end();
    log.info("stopped", snapshot(metrics));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
