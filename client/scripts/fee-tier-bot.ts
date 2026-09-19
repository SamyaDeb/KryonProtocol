#!/usr/bin/env tsx
/**
 * fee-tier-bot — assigns accounts to fee tiers by 30-day volume.
 * See lib/keepers/fee-tier.ts.
 *
 * DRY RUN BY DEFAULT: it logs the changes it would make and sends nothing until
 * FEE_TIER_BOT_ENABLED=true. The key needs FEE_TIER_ROLE on the FeeRouter, and
 * every tier in the schedule must already be defined by governance
 * (`FeeRouter.defineTier`); otherwise the bot idles and says why.
 *
 * Environment:
 *   KRYON_NETWORK                  arc-mainnet | arc-testnet | arc-local
 *   DATABASE_URL                   Postgres (AccountAnalytics, Account, BlockCursor, KeeperAction, TxJob)
 *   ARC_RPC_URLS                   comma-separated, paid providers first (optional)
 *   KRYON_DEPLOYMENT_FILE          deployment record, or all CONTRACT_* variables
 *   KRYON_SIGNER_FEE_TIER_BOT      where the FEE_TIER_ROLE key lives (kms:<keyId> | keystore;
 *                                  env with FEE_TIER_BOT_PRIVATE_KEY on arc-local); lib/chain/signer.ts
 *   FEE_TIER_SCHEDULE              tier:minUsd30d,... e.g. 1:1000000,2:10000000,3:50000000 (required)
 *   FEE_TIER_BOT_ENABLED           true to send; anything else is a dry run (default false)
 *   FEE_TIER_MAX_CHANGES_PER_TICK  setAccountTier calls per tick (default 20)
 *   FEE_TIER_MAX_STATS_AGE_MS      idle if the stats aggregator is older than this (default 7200000)
 *   FEE_TIER_INTERVAL_MS           tick period (default 300000)
 *   LOG_LEVEL                      debug | info | warn | error (default info)
 */

import { neon } from "@/lib/sql";
import { FeeTierBot, parseSchedule, pgFeeTierData, viemFeeTierChain } from "@/lib/keepers/fee-tier";
import { bootstrap, createSender, envBool, envInt, recoverOpenJobs, runLoop } from "@/lib/keepers/runtime";
import { assertServiceConfig } from "@/lib/config-check";

const SERVICE = "fee-tier-bot";

async function main() {
  // Every configuration problem at once, before anything connects or signs.
  assertServiceConfig("fee-tier-bot");
  const env = process.env;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = neon(databaseUrl);
  const schedule = parseSchedule(env.FEE_TIER_SCHEDULE);
  const enabled = envBool(env, "FEE_TIER_BOT_ENABLED", false);

  const ctx = await bootstrap({ service: SERVICE, sql, env });
  const sender = await createSender({ ctx, service: SERVICE, keyEnvVar: "FEE_TIER_BOT_PRIVATE_KEY", env });
  const { feeRouter } = ctx.contracts;

  const bot = new FeeTierBot({
    chain: viemFeeTierChain({ client: ctx.client, feeRouter }),
    data: pgFeeTierData(sql, ctx.network.id),
    sender,
    feeRouter,
    schedule,
    enabled,
    maxChangesPerTick: envInt(env, "FEE_TIER_MAX_CHANGES_PER_TICK", 20),
    maxStatsAgeMs: envInt(env, "FEE_TIER_MAX_STATS_AGE_MS", 2 * 3_600_000),
    log: ctx.log,
    metrics: ctx.metrics,
    actions: ctx.actions,
  });

  const tickMs = envInt(env, "FEE_TIER_INTERVAL_MS", 300_000);
  ctx.log.info("fee tier bot starting", {
    bot: sender.address,
    mode: enabled ? "ENABLED" : "dry run (FEE_TIER_BOT_ENABLED is off)",
    schedule: schedule.map((s) => `${s.tier}:${s.minVolume / 1_000_000n}`),
    tickMs,
  });

  if (enabled) await recoverOpenJobs(sender, ctx.log);
  await runLoop({ tickMs, signal: ctx.shutdown.signal, log: ctx.log, metrics: ctx.metrics }, async () => {
    await bot.tick();
  });

  ctx.log.info("fee tier bot stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), level: "error", service: SERVICE, msg: "fatal", error: String(err) })
  );
  process.exit(1);
});
