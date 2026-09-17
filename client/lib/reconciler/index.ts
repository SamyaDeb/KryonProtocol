/**
 * One reconciler tick: drain every service key's open TxJobs to a terminal
 * state, then scan for fills the matcher left stranded.
 *
 * The reconciler is the only process that looks at *all* service keys. Every
 * other keeper sees only its own.
 */

import type { SqlClient } from "@/lib/sql";
import type { GasSpendRollup, KeeperActions, Logger, Metrics } from "@/lib/keepers/runtime";
import { openKeys, reconcileKey, type KeyReport, type ReconcilerChain } from "./jobs";
import { scanUnaccountedFills, type FillMismatch } from "./fills";

export * from "./jobs";
export * from "./fills";

export interface ReconcilerOptions {
  chain: ReconcilerChain;
  sql: SqlClient;
  network: string;
  log: Logger;
  metrics: Metrics;
  gas: GasSpendRollup;
  actions: KeeperActions;
  stuckAfterMs?: number;
  fillMinAgeMs?: number;
  now?: () => number;
}

export interface TickReport {
  keys: KeyReport[];
  mismatches: FillMismatch[];
}

export async function reconcileOnce(o: ReconcilerOptions): Promise<TickReport> {
  const keys = await openKeys(o.sql, o.network);
  const reports: KeyReport[] = [];

  // Sequential, not parallel: one RPC endpoint, and a key's jobs must be read
  // in nonce order against a single consistent `getTransactionCount`.
  for (const key of keys) {
    reports.push(
      await reconcileKey(
        {
          chain: o.chain,
          sql: o.sql,
          network: o.network,
          log: o.log,
          metrics: o.metrics,
          gas: o.gas,
          now: o.now,
          stuckAfterMs: o.stuckAfterMs,
        },
        key
      )
    );
  }

  const mismatches = await scanUnaccountedFills({
    sql: o.sql,
    network: o.network,
    log: o.log,
    metrics: o.metrics,
    actions: o.actions,
    minAgeMs: o.fillMinAgeMs,
    now: o.now,
  });

  const totals = reports.reduce(
    (acc, r) => {
      for (const [k, v] of Object.entries(r.outcomes)) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    },
    {} as Record<string, number>
  );
  const stuck = reports.flatMap((r) => r.stuck);
  const gaps = reports.filter((r) => r.nonceGaps.length > 0);
  o.metrics.gauge("reconciler_open_keys", keys.length);
  o.metrics.gauge("reconciler_stuck_jobs", stuck.length);
  o.metrics.gauge("reconciler_keys_with_nonce_gaps", gaps.length);
  o.metrics.gauge("reconciler_fill_mismatches", mismatches.length);

  o.log.info("reconcile tick", {
    keys: keys.length,
    ...totals,
    stuck: stuck.length,
    nonceGapKeys: gaps.length,
    fillMismatches: mismatches.length,
  });

  return { keys: reports, mismatches };
}
