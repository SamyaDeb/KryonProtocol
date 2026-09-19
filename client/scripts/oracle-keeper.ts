#!/usr/bin/env tsx
/**
 * oracle-keeper — one oracle publisher. Run two, with distinct keys on
 * distinct hosts: the adapter needs `minPublishers` (2 on mainnet) fresh
 * observations before it will update a price.
 *
 * Sources → aggregation → guards → publish; see lib/oracle/publisher.ts.
 *
 * Environment:
 *   KRYON_NETWORK                     arc-mainnet | arc-testnet | arc-local
 *   DATABASE_URL                      Postgres (TxJob, KeeperAction)
 *   ARC_RPC_URLS                      comma-separated, paid providers first (optional)
 *   KRYON_DEPLOYMENT_FILE             deployment record, or all CONTRACT_* variables
 *   ORACLE_PUBLISHER_PRIVATE_KEY      this publisher's key (PUBLISHER_ROLE); unique per process
 *   ORACLE_INTERVAL_MS                tick period (default 1000)
 *   ORACLE_START_OFFSET_MS            initial delay, to stagger publishers (default 0; use ~500 on the second)
 *   ORACLE_PUSH_DEVIATION_BPS         publish on a move of at least this (default 5)
 *   ORACLE_HEARTBEAT_SECS             ...or when our observation is this old (default 5; on-chain maxAge is 15)
 *   ORACLE_MIN_SOURCES                live venues required per feed (default 2, never lower)
 *   ORACLE_MAX_SOURCE_DEVIATION_BPS   drop a venue this far from the median (default 50)
 *   ORACLE_SOURCES                    venues to use (default binance,coinbase,kraken)
 *   ORACLE_SOURCE_TIMEOUT_MS          per-request timeout (default 1500)
 *   ORACLE_MAX_QUOTE_AGE_MS           ignore quotes older than this (default 5000)
 *   ORACLE_BACKDATE_SECS              publishTime margin behind chain time (default 1)
 *   ORACLE_INCLUSION_MARGIN_SECS      maxAge reserved for inclusion (default 3)
 *   ORACLE_MAX_REF_DIVERGENCE_BPS     stricter-than-chain Chainlink bound; 0 = on-chain (default 0)
 *   ORACLE_ALERT_AFTER_SECS           alert when a feed is this stale (default 30)
 *   ORACLE_USDC_REFERENCE             Chainlink USDC/USD aggregator (mainnet: 0x84EA90AC252Dc437031461836DB5164219147905)
 *   USDC_DEPEG_HALT_BPS               halt everything beyond this USDC de-peg (default 100)
 *   USDC_DEPEG_FAIL_CLOSED            halt when no USDC reading exists at all (default true)
 *   LOG_LEVEL                         debug | info | warn | error (default info)
 *
 * Usage: npm run dev:oracle
 */

import { getAddress } from "viem";

import { neon } from "@/lib/sql";
import {
  bootstrap,
  createSender,
  envBool,
  envInt,
  envList,
  recoverOpenJobs,
  runLoop,
  systemClock,
} from "@/lib/keepers/runtime";
import { viemOracleChain } from "@/lib/oracle/chain";
import { OraclePublisher } from "@/lib/oracle/publisher";
import { binanceSource, coinbaseSource, krakenSource, type PriceSource } from "@/lib/oracle/sources";
import { assertServiceConfig } from "@/lib/config-check";

const SERVICE = "oracle-publisher";

async function main() {
  // Every configuration problem at once, before anything connects or signs.
  assertServiceConfig("oracle-keeper");
  const env = process.env;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = neon(databaseUrl);

  const ctx = await bootstrap({ service: SERVICE, sql, env });
  const sender = await createSender({
    ctx,
    service: SERVICE,
    keyEnvVar: "ORACLE_PUBLISHER_PRIVATE_KEY",
    env,
    // A push is only valid for maxAge (15s) after its publishTime. Get it in
    // fast or let it go; the next tick signs a fresh one.
    overrides: { pollMs: 250, rebroadcastAfterMs: 1_000, replaceAfterMs: 3_000, waitTimeoutMs: 12_000 },
  });

  const timeoutMs = envInt(env, "ORACLE_SOURCE_TIMEOUT_MS", 1_500);
  const all: Record<string, PriceSource> = {
    binance: binanceSource({ timeoutMs }),
    coinbase: coinbaseSource({ timeoutMs }),
    kraken: krakenSource({ timeoutMs }),
  };
  const names = envList(env, "ORACLE_SOURCES");
  const sources = (names.length ? names : ["binance", "coinbase", "kraken"]).map((n) => {
    const s = all[n];
    if (!s) throw new Error(`ORACLE_SOURCES: unknown venue ${n}`);
    return s;
  });

  const minSources = envInt(env, "ORACLE_MIN_SOURCES", 2);
  if (minSources < 2) throw new Error("ORACLE_MIN_SOURCES below 2 would publish from a single venue");
  const usdcRef = env.ORACLE_USDC_REFERENCE ? getAddress(env.ORACLE_USDC_REFERENCE) : null;
  if (ctx.network.id === "arc-mainnet" && !usdcRef) {
    throw new Error("ORACLE_USDC_REFERENCE is required on mainnet (Chainlink USDC/USD)");
  }

  const publisher = new OraclePublisher({
    chain: viemOracleChain({
      client: ctx.client,
      oracle: ctx.contracts.oracleAdapter,
      self: sender.address,
      usdcReference: usdcRef,
    }),
    sender,
    oracle: ctx.contracts.oracleAdapter,
    sources,
    log: ctx.log,
    metrics: ctx.metrics,
    actions: ctx.actions,
    aggregate: { minSources, maxSourceDeviationBps: BigInt(envInt(env, "ORACLE_MAX_SOURCE_DEVIATION_BPS", 50)) },
    policy: {
      deviationBps: BigInt(envInt(env, "ORACLE_PUSH_DEVIATION_BPS", 5)),
      heartbeatSecs: envInt(env, "ORACLE_HEARTBEAT_SECS", 5),
      inclusionMarginSecs: envInt(env, "ORACLE_INCLUSION_MARGIN_SECS", 3),
      maxRefDivergenceBps: envInt(env, "ORACLE_MAX_REF_DIVERGENCE_BPS", 0),
    },
    maxQuoteAgeMs: envInt(env, "ORACLE_MAX_QUOTE_AGE_MS", 5_000),
    usdcDepegHaltBps: BigInt(envInt(env, "USDC_DEPEG_HALT_BPS", 100)),
    depegFailClosed: envBool(env, "USDC_DEPEG_FAIL_CLOSED", true),
    backdateSecs: envInt(env, "ORACLE_BACKDATE_SECS", 1),
    alertAfterSecs: envInt(env, "ORACLE_ALERT_AFTER_SECS", 30),
  });

  const tickMs = envInt(env, "ORACLE_INTERVAL_MS", 1_000);
  ctx.log.info("oracle publisher starting", {
    publisher: sender.address,
    oracle: ctx.contracts.oracleAdapter,
    sources: sources.map((s) => s.name),
    tickMs,
  });

  await recoverOpenJobs(sender, ctx.log);
  await systemClock.sleep(envInt(env, "ORACLE_START_OFFSET_MS", 0), ctx.shutdown.signal);

  await runLoop({ tickMs, signal: ctx.shutdown.signal, log: ctx.log, metrics: ctx.metrics }, async () => {
    await publisher.tick();
  });

  ctx.log.info("oracle publisher stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), level: "error", service: SERVICE, msg: "fatal", error: String(err) })
  );
  process.exit(1);
});
