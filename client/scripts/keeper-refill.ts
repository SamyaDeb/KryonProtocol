#!/usr/bin/env tsx
/**
 * keeper-refill — tops up service keys' gas (native USDC on Arc) from one
 * funder key. See lib/keepers/refill.ts for the caps and the safety model.
 *
 * Dry run unless --execute. --loop keeps running every REFILL_INTERVAL_MS
 * (the pm2 entry runs with both).
 *
 * Environment:
 *   KRYON_NETWORK                      arc-mainnet | arc-testnet | arc-local
 *   DATABASE_URL                       Postgres (KeeperAction, TxJob)
 *   ARC_RPC_URLS                       comma-separated, paid providers first (optional)
 *   KRYON_DEPLOYMENT_FILE              deployment record, or all CONTRACT_* variables
 *   REFILL_FUNDER_PRIVATE_KEY          the funder; holds the gas float, used by nothing else
 *   REFILL_TARGETS                     name:0xaddress,... (e.g. oracle-1:0x..,oracle-2:0x..,funding:0x..,liquidator:0x..,matcher:0x..)
 *   REFILL_FLOOR_USDC                  top up below this (default 5)
 *   REFILL_TARGET_USDC                 ...to this (default 25)
 *   REFILL_MAX_PER_RUN_USDC            cap per run across all targets (default 100)
 *   REFILL_MAX_PER_TARGET_DAY_USDC     cap per target per UTC day (default 50)
 *   REFILL_FUNDER_ALERT_USDC           alert when the funder is below this (default 100)
 *   REFILL_INTERVAL_MS                 --loop period (default 60000)
 *   LOG_LEVEL                          debug | info | warn | error (default info)
 *
 * Usage:
 *   npx tsx scripts/keeper-refill.ts                    # dry run, once
 *   npx tsx scripts/keeper-refill.ts --execute --loop   # the service
 */

import { neon } from "@/lib/sql";
import { USDC18, parseTargets, refillOnce } from "@/lib/keepers/refill";
import { bootstrap, createSender, envInt, recoverOpenJobs, runLoop } from "@/lib/keepers/runtime";
import { assertServiceConfig } from "@/lib/config-check";

const SERVICE = "keeper-refill";
const EXECUTE = process.argv.includes("--execute");
const LOOP = process.argv.includes("--loop");

async function main() {
  // Every configuration problem at once, before anything connects or signs.
  assertServiceConfig("keeper-refill");
  const env = process.env;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = neon(databaseUrl);

  const ctx = await bootstrap({ service: SERVICE, sql, env });
  const sender = await createSender({ ctx, service: SERVICE, keyEnvVar: "REFILL_FUNDER_PRIVATE_KEY", env });
  const targets = parseTargets(env.REFILL_TARGETS);
  if (targets.length === 0) throw new Error("REFILL_TARGETS is empty");
  if (targets.some((t) => t.address.toLowerCase() === sender.address.toLowerCase())) {
    throw new Error("the funder cannot be one of its own targets");
  }
  const usdc = (name: string, fallback: number) => BigInt(envInt(env, name, fallback)) * USDC18;
  const policy = {
    floor: usdc("REFILL_FLOOR_USDC", 5),
    target: usdc("REFILL_TARGET_USDC", 25),
    maxPerRun: usdc("REFILL_MAX_PER_RUN_USDC", 100),
    maxPerTargetPerDay: usdc("REFILL_MAX_PER_TARGET_DAY_USDC", 50),
    funderAlert: usdc("REFILL_FUNDER_ALERT_USDC", 100),
  };
  ctx.log.info("keeper refill starting", { funder: sender.address, targets, execute: EXECUTE, loop: LOOP });

  const once = () =>
    refillOnce({
      client: ctx.client,
      sender,
      sql,
      network: ctx.network.id,
      targets,
      policy,
      execute: EXECUTE,
      log: ctx.log,
      metrics: ctx.metrics,
      actions: ctx.actions,
    });

  if (EXECUTE) await recoverOpenJobs(sender, ctx.log);
  if (!LOOP) {
    const { plans } = await once();
    for (const p of plans) ctx.log.info("plan", { ...p });
    process.exit(0);
  }
  await runLoop(
    { tickMs: envInt(env, "REFILL_INTERVAL_MS", 60_000), signal: ctx.shutdown.signal, log: ctx.log, metrics: ctx.metrics },
    async () => {
      await once();
    }
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), level: "error", service: SERVICE, msg: "fatal", error: String(err) })
  );
  process.exit(1);
});
