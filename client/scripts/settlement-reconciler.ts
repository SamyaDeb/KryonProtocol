#!/usr/bin/env tsx
/**
 * settlement-reconciler — drives every service key's open TxJobs to a terminal
 * state, rolls up gas, and reports fills the matcher left stranded.
 *
 * It is the safety net behind every other keeper: each TxSender persists a job
 * row *before* it broadcasts, so a process that dies mid-send leaves a durable
 * record, and this service finishes it.
 *
 * What it will not do is re-send business intent. It rebroadcasts byte-identical
 * signed transactions (same nonce, same hash — not a new transaction) and it
 * records outcomes. Re-deciding whether a liquidation, a funding update or a
 * settlement batch should be sent again belongs to the keeper that owns that
 * decision. See docs/engineering/KEEPER_IDEMPOTENCY.md.
 *
 * Environment:
 *   KRYON_NETWORK                   arc-mainnet | arc-testnet | arc-local
 *   DATABASE_URL                    Postgres holding TxJob / Fill / KeeperAction / GasSpend
 *   ARC_RPC_URLS                    comma-separated, paid providers first (optional)
 *   KRYON_DEPLOYMENT_FILE           deployment record, or all CONTRACT_* variables
 *   RECONCILER_INTERVAL_MS          tick period (default 15000)
 *   RECONCILER_STUCK_AFTER_MS       age at which an unmined job is reported stuck (default 60000)
 *   RECONCILER_FILL_MIN_AGE_MS      age at which a PENDING fill is a mismatch (default 120000)
 *   LOG_LEVEL                       debug | info | warn | error (default info)
 *
 * It holds NO signing key: every action it takes is a read or a rebroadcast of
 * bytes another process already signed.
 *
 * Usage: npm run dev:reconciler
 */

import { neon } from "@/lib/sql";
import { bootstrap, envInt, runLoop } from "@/lib/keepers/runtime";
import { reconcileOnce } from "@/lib/reconciler";

const SERVICE = "reconciler";

async function main() {
  const env = process.env;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = neon(databaseUrl);

  const ctx = await bootstrap({ service: SERVICE, sql, env });
  const tickMs = envInt(env, "RECONCILER_INTERVAL_MS", 15_000);
  const stuckAfterMs = envInt(env, "RECONCILER_STUCK_AFTER_MS", 60_000);
  const fillMinAgeMs = envInt(env, "RECONCILER_FILL_MIN_AGE_MS", 120_000);

  ctx.log.info("reconciler starting", {
    tickMs,
    stuckAfterMs,
    fillMinAgeMs,
    contracts: { orderGateway: ctx.contracts.orderGateway },
  });

  // No startup recovery step of its own: the first tick *is* the recovery, and
  // it covers every key rather than only this process's.
  await runLoop({ tickMs, signal: ctx.shutdown.signal, log: ctx.log, metrics: ctx.metrics }, async () => {
    await reconcileOnce({
      chain: ctx.client,
      sql: ctx.sql,
      network: ctx.network.id,
      log: ctx.log,
      metrics: ctx.metrics,
      gas: ctx.gas,
      actions: ctx.actions,
      stuckAfterMs,
      fillMinAgeMs,
    });
  });

  ctx.log.info("reconciler stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", service: SERVICE, msg: "fatal", error: String(err) }));
  process.exit(1);
});
