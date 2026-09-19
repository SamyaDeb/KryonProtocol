#!/usr/bin/env tsx
/**
 * funding-keeper — advances each active market's funding indexes a little
 * under every hour. See lib/keepers/funding.ts for why the cadence must stay
 * under an hour and why a duplicate call is not a no-op.
 *
 * Environment:
 *   KRYON_NETWORK                 arc-mainnet | arc-testnet | arc-local
 *   DATABASE_URL                  Postgres (TxJob, KeeperAction)
 *   ARC_RPC_URLS                  comma-separated, paid providers first (optional)
 *   KRYON_DEPLOYMENT_FILE         deployment record, or all CONTRACT_* variables
 *   FUNDING_KEEPER_PRIVATE_KEY    the KEEPER_ROLE key; used by this process only
 *   FUNDING_INTERVAL_MS           tick period (default 30000)
 *   FUNDING_DUE_AFTER_SECS        update once this old, in chain seconds (default 3300; must be < 3600)
 *   FUNDING_MAX_PER_TICK          updates per tick, most overdue first (default 1: staggers markets)
 *   LOG_LEVEL                     debug | info | warn | error (default info)
 *
 * Usage: npm run dev:funding
 */

import { neon } from "@/lib/sql";
import { FundingKeeper, viemFundingChain } from "@/lib/keepers/funding";
import { bootstrap, createSender, envInt, recoverOpenJobs, runLoop } from "@/lib/keepers/runtime";
import { assertServiceConfig } from "@/lib/config-check";

const SERVICE = "funding-keeper";

async function main() {
  // Every configuration problem at once, before anything connects or signs.
  assertServiceConfig("funding-keeper");
  const env = process.env;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = neon(databaseUrl);

  const ctx = await bootstrap({ service: SERVICE, sql, env });
  const sender = await createSender({ ctx, service: SERVICE, keyEnvVar: "FUNDING_KEEPER_PRIVATE_KEY", env });

  const keeper = new FundingKeeper({
    chain: viemFundingChain({
      client: ctx.client,
      engine: ctx.contracts.engine,
      riskParams: ctx.contracts.riskParams,
      self: sender.address,
    }),
    sender,
    engine: ctx.contracts.engine,
    log: ctx.log,
    metrics: ctx.metrics,
    actions: ctx.actions,
    dueAfterSecs: envInt(env, "FUNDING_DUE_AFTER_SECS", 3_300),
    maxPerTick: envInt(env, "FUNDING_MAX_PER_TICK", 1),
  });

  const tickMs = envInt(env, "FUNDING_INTERVAL_MS", 30_000);
  ctx.log.info("funding keeper starting", { keeper: sender.address, engine: ctx.contracts.engine, tickMs });

  await recoverOpenJobs(sender, ctx.log);
  await runLoop({ tickMs, signal: ctx.shutdown.signal, log: ctx.log, metrics: ctx.metrics }, async () => {
    await keeper.tick();
  });

  ctx.log.info("funding keeper stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), level: "error", service: SERVICE, msg: "fatal", error: String(err) })
  );
  process.exit(1);
});
