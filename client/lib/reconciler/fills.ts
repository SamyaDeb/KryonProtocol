/**
 * Unaccounted fills: rows the matcher left PENDING whose batch has long since
 * reached a terminal state.
 *
 * REPORT, DO NOT RE-SETTLE. The reconciler never re-sends a settlement batch.
 * `OrderGateway.settleFillsSigned` settles each fill in its own try/catch and
 * rejects a duplicate `fillId` rather than reverting the batch, so a blind
 * resend is *usually* harmless — but "usually" is not an argument to bet a
 * balance sheet on, and the orders behind those fills may since have expired,
 * been cancelled or been re-matched elsewhere. Deciding what a stranded fill
 * means is the matcher's job; this module's job is to make sure no such fill
 * goes unnoticed.
 *
 * The indexer is the only writer of `Fill.status`. A PENDING row whose batch
 * confirmed means one of three things, and the mismatch kind says which:
 *
 *   - `indexer-lag`    the batch confirmed and the indexer has not caught up.
 *                      Self-healing; only alarming if it persists.
 *   - `not-in-receipt` the batch confirmed and the indexer *has* passed that
 *                      block, so the fill was neither settled nor rejected in
 *                      the receipt. This is the real "unaccounted fill": the
 *                      batch that landed is not the batch we think we sent.
 *   - `batch-failed`   the batch reverted, dropped or failed, so the fill will
 *                      never settle. The matcher must re-match or expire it.
 *   - `never-submitted` PENDING with no batch at all, past the age threshold.
 */

import type { SqlClient } from "@/lib/sql";
import type { KeeperActions, Logger, Metrics } from "@/lib/keepers/runtime";

export type MismatchKind = "indexer-lag" | "not-in-receipt" | "batch-failed" | "never-submitted";

export interface FillMismatch {
  fillId: string;
  marketId: number;
  kind: MismatchKind;
  txJobId: string | null;
  jobStatus: string | null;
  jobBlockNumber: bigint | null;
  ageMs: number;
}

export interface FillScanOptions {
  sql: SqlClient;
  network: string;
  log: Logger;
  metrics: Metrics;
  actions: KeeperActions;
  /** A PENDING fill younger than this is simply in flight. */
  minAgeMs?: number;
  maxRows?: number;
  now?: () => number;
}

const DEFAULT_MIN_AGE_MS = 120_000;
const DEFAULT_MAX_ROWS = 500;

/**
 * `indexer-lag` vs `not-in-receipt` turns on how far the indexer has projected.
 * The high-water mark is the highest block it has written a Fill for; if that
 * is at or past the batch's block, the indexer has seen the block and simply
 * did not find this fill in it.
 */
async function indexerHighWater(sql: SqlClient, network: string): Promise<bigint | null> {
  const rows = await sql.query(
    `SELECT MAX("blockNumber") AS "high" FROM "Fill" WHERE "network" = $1 AND "blockNumber" IS NOT NULL`,
    [network]
  );
  const high = rows[0]?.high;
  return high === null || high === undefined ? null : BigInt(high);
}

export async function scanUnaccountedFills(o: FillScanOptions): Promise<FillMismatch[]> {
  const now = o.now ?? Date.now;
  const minAge = o.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const cutoff = new Date(now() - minAge);
  const highWater = await indexerHighWater(o.sql, o.network);

  const rows = await o.sql.query(
    `SELECT f."fillId", f."marketId", f."txJobId", f."createdAt",
            j."status"::text AS "jobStatus", j."blockNumber" AS "jobBlockNumber"
     FROM "Fill" f
     LEFT JOIN "TxJob" j ON j."id" = f."txJobId"
     WHERE f."network" = $1
       AND f."status" = 'PENDING'
       AND f."createdAt" < $2
       AND (j."id" IS NULL OR j."status"::text NOT IN ('PENDING', 'SUBMITTED', 'REPLACED'))
     ORDER BY f."createdAt" ASC
     LIMIT $3`,
    [o.network, cutoff, o.maxRows ?? DEFAULT_MAX_ROWS]
  );

  const mismatches: FillMismatch[] = rows.map((r): FillMismatch => {
    const jobStatus = (r.jobStatus ?? null) as string | null;
    const jobBlockNumber = r.jobBlockNumber === null || r.jobBlockNumber === undefined ? null : BigInt(r.jobBlockNumber);
    let kind: MismatchKind;
    if (jobStatus === null) {
      kind = "never-submitted";
    } else if (jobStatus !== "CONFIRMED") {
      kind = "batch-failed";
    } else if (jobBlockNumber !== null && highWater !== null && highWater >= jobBlockNumber) {
      kind = "not-in-receipt";
    } else {
      kind = "indexer-lag";
    }
    return {
      fillId: r.fillId,
      marketId: Number(r.marketId),
      kind,
      txJobId: r.txJobId ?? null,
      jobStatus,
      jobBlockNumber,
      ageMs: now() - new Date(r.createdAt).getTime(),
    };
  });

  for (const kind of ["indexer-lag", "not-in-receipt", "batch-failed", "never-submitted"] as const) {
    const of = mismatches.filter((m) => m.kind === kind);
    if (of.length === 0) continue;
    o.metrics.inc(`reconciler_fill_${kind.replace(/-/g, "_")}_total`, of.length);

    // `not-in-receipt` means the chain disagrees with our record of what we
    // sent. That is a bug, not a delay, so it is an error and it is durable.
    const level = kind === "indexer-lag" ? "warn" : "error";
    o.log[level]("unaccounted fills", {
      kind,
      count: of.length,
      oldestMs: Math.max(...of.map((m) => m.ageMs)),
      sample: of.slice(0, 10).map((m) => ({ fillId: m.fillId, marketId: m.marketId, txJobId: m.txJobId })),
    });

    if (kind !== "indexer-lag") {
      await o.actions.record({
        kind: "reconcile.fill_mismatch",
        // SKIPPED, not FAILED: the reconciler deliberately took no action.
        status: "SKIPPED",
        payload: {
          mismatchKind: kind,
          count: of.length,
          fills: of.slice(0, 100).map((m) => ({
            fillId: m.fillId,
            marketId: m.marketId,
            txJobId: m.txJobId,
            jobStatus: m.jobStatus,
            ageMs: m.ageMs,
          })),
          note: "reported only; the reconciler never re-sends a settlement batch",
        },
      });
    }
  }

  return mismatches;
}
