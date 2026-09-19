#!/usr/bin/env tsx
/**
 * liquidation-keeper — liquidates under-water accounts, runs ADL while the
 * insurance fund has an unfunded shortfall, and settles closed-out bad debt.
 * See lib/keepers/liquidation.ts.
 *
 * `liquidate`, `adl` and `settleBadDebt` are permissionless; the key needs no
 * role. Liquidation rewards accrue to this key's vault account.
 *
 * Environment:
 *   KRYON_NETWORK                   arc-mainnet | arc-testnet | arc-local
 *   DATABASE_URL                    Postgres (Position, Account, KeeperAction, TxJob)
 *   ARC_RPC_URLS                    comma-separated, paid providers first (optional)
 *   KRYON_DEPLOYMENT_FILE           deployment record, or all CONTRACT_* variables
 *   LIQUIDATOR_PRIVATE_KEY          this process's key; used by nothing else
 *   LIQUIDATION_INTERVAL_MS         tick period (default 2000)
 *   LIQUIDATION_MAX_ACCOUNTS        accounts acted on per tick, most under water first (default 25)
 *   LIQUIDATION_MAX_STEPS           liquidation steps per account per tick (default 10)
 *   LIQUIDATION_INDEXER_GRACE_MS    report confirmed actions the indexer has not written after this (default 120000)
 *   ADL_MIN_SHORTFALL_USDC          skip ADL below this unfunded shortfall; dust cannot be cleared (default 1)
 *   LOG_LEVEL                       debug | info | warn | error (default info)
 *
 * Usage: npm run dev:liquidator
 */

import { neon } from "@/lib/sql";
import { LiquidationKeeper, viemLiquidationChain } from "@/lib/keepers/liquidation";
import { bootstrap, createSender, envInt, recoverOpenJobs, runLoop } from "@/lib/keepers/runtime";

const SERVICE = "liquidator";

async function main() {
  const env = process.env;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = neon(databaseUrl);

  const ctx = await bootstrap({ service: SERVICE, sql, env });
  const sender = await createSender({ ctx, service: SERVICE, keyEnvVar: "LIQUIDATOR_PRIVATE_KEY", env });
  const { engine, liquidation, insurance, vault } = ctx.contracts;

  const keeper = new LiquidationKeeper({
    chain: viemLiquidationChain({ client: ctx.client, engine, liquidation, insurance, vault }),
    sender,
    sql,
    network: ctx.network.id,
    contracts: { engine, liquidation, insurance },
    log: ctx.log,
    metrics: ctx.metrics,
    actions: ctx.actions,
    maxAccountsPerTick: envInt(env, "LIQUIDATION_MAX_ACCOUNTS", 25),
    maxStepsPerAccount: envInt(env, "LIQUIDATION_MAX_STEPS", 10),
    indexerGraceMs: envInt(env, "LIQUIDATION_INDEXER_GRACE_MS", 120_000),
    adlMinShortfall: BigInt(envInt(env, "ADL_MIN_SHORTFALL_USDC", 1)) * 10n ** 18n,
  });

  const tickMs = envInt(env, "LIQUIDATION_INTERVAL_MS", 2_000);
  ctx.log.info("liquidation keeper starting", { liquidator: sender.address, tickMs });

  await recoverOpenJobs(sender, ctx.log);
  await runLoop({ tickMs, signal: ctx.shutdown.signal, log: ctx.log, metrics: ctx.metrics }, async () => {
    await keeper.tick();
  });

  ctx.log.info("liquidation keeper stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), level: "error", service: SERVICE, msg: "fatal", error: String(err) })
  );
  process.exit(1);
});
