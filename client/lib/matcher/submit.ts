/**
 * Persisting and broadcasting one batch (plan §4.2.4).
 *
 * The intent is written before the transaction exists: the PENDING `Fill` rows
 * for a batch go in inside one database transaction, and only then is the
 * batch signed and broadcast. A crash anywhere after that leaves a durable
 * record of exactly what this process meant to settle, which is what makes
 * recovery possible without ever guessing.
 *
 * The rows are the matcher's reservation ledger (see book.ts), so writing them
 * first also means a restart mid-batch cannot match the same size twice. They
 * are written PENDING and nothing here ever writes SETTLED or REJECTED: those
 * come from the logs, through the indexer.
 *
 * Server-side only.
 */

import type { Address, Hex } from "viem";

import { encodeSettleFills } from "@/lib/chain/settlement";
import type { TxSender } from "@/lib/chain/tx-sender";
import type { TxJob } from "@/lib/chain/tx-store";
import type { Db, Query } from "./db";
import type { PlannedFill } from "./batch";

export interface PersistResult {
  /** Fills newly reserved by this call. */
  inserted: Hex[];
  /** Fills a previous attempt had already reserved; the batch still settles them. */
  existing: Hex[];
}

/**
 * Reserve a batch. One transaction, `ON CONFLICT DO NOTHING` on
 * `(network, fillId)` so a replay of the same batch is a no-op rather than a
 * double reservation.
 */
export async function persistPendingFills(
  db: Db,
  network: string,
  fills: readonly PlannedFill[]
): Promise<PersistResult> {
  if (fills.length === 0) return { inserted: [], existing: [] };
  return db.transaction(async (q) => {
    const inserted: Hex[] = [];
    for (const f of fills) {
      const rows = await q.query(
        `INSERT INTO "Fill" (
           "network", "fillId", "status", "marketId", "maker", "taker",
           "makerOrderHash", "takerOrderHash", "takerIsBuy", "size", "price", "updatedAt"
         ) VALUES ($1, $2, 'PENDING', $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT ("network", "fillId") DO NOTHING
         RETURNING "fillId"`,
        [
          network,
          lower(f.fillId),
          f.marketId,
          lower(f.maker.owner),
          lower(f.taker.owner),
          lower(f.makerOrderHash),
          lower(f.takerOrderHash),
          f.takerIsBuy,
          f.size.toString(),
          f.price.toString(),
        ]
      );
      if (rows.length > 0) inserted.push(f.fillId);
    }
    const insertedSet = new Set(inserted.map((id) => id.toLowerCase()));
    const existing = fills.map((f) => f.fillId).filter((id) => !insertedSet.has(id.toLowerCase()));
    return { inserted, existing };
  });
}

/** Point the batch's fills at the job that carries them, for the reconciler. */
export async function linkFillsToJob(
  q: Query,
  network: string,
  fillIds: readonly Hex[],
  txJobId: string
): Promise<void> {
  if (fillIds.length === 0) return;
  await q.query(
    `UPDATE "Fill" SET "txJobId" = $3, "updatedAt" = now()
     WHERE "network" = $1 AND "fillId" = ANY($2::text[]) AND "status" = 'PENDING'`,
    [network, fillIds.map(lower), txJobId]
  );
}

/**
 * Give the reserved size back. Only ever called for fills that are known not
 * to have settled — a batch that never reached the node, or a fill the chain
 * rejected. Deleting the row rather than marking it frees the size for the
 * next tick, and the deterministic fill id means the indexer can still
 * recreate the row from a log if one somehow arrives.
 */
export async function releasePendingFills(
  q: Query,
  network: string,
  fillIds: readonly Hex[]
): Promise<number> {
  if (fillIds.length === 0) return 0;
  const rows = await q.query(
    `DELETE FROM "Fill"
     WHERE "network" = $1 AND "fillId" = ANY($2::text[]) AND "status" = 'PENDING'
     RETURNING "fillId"`,
    [network, fillIds.map(lower)]
  );
  return rows.length;
}

export interface SubmittedBatch {
  job: TxJob;
  fills: PlannedFill[];
  gas: bigint;
}

export interface SubmitOptions {
  db: Db;
  network: string;
  sender: TxSender;
  gateway: Address;
  /** `settleFillsSigned:<SYMBOL>`. */
  label: string;
}

/**
 * Reserve, then broadcast. The reservation is committed before the transaction
 * is signed, so the failure modes are:
 *
 *   - crash after the commit, before the broadcast → PENDING fills with no
 *     `txJobId`; recovery reconciles them against `OrderGateway.filled`.
 *   - crash after the broadcast, before the link → same shape, same recovery,
 *     and the open `TxJob` is found by `openJobs()` regardless.
 *   - the broadcast throws → the reservation is released here and now.
 */
export async function submitBatch(
  options: SubmitOptions,
  fills: readonly PlannedFill[],
  gas: bigint
): Promise<SubmittedBatch> {
  const { db, network, sender, gateway, label } = options;
  await persistPendingFills(db, network, fills);

  let job: TxJob;
  try {
    job = await sender.submit({ to: gateway, data: encodeSettleFills(fills), gas, label });
  } catch (err) {
    // Nothing was broadcast, so nothing can settle: take the reservation back
    // rather than leave the size stranded until a reconciler notices.
    await releasePendingFills(db, network, fills.map((f) => f.fillId));
    throw err;
  }

  await linkFillsToJob(db, network, fills.map((f) => f.fillId), job.id);
  return { job, fills: [...fills], gas };
}

function lower<T extends string>(v: T): T {
  return v.toLowerCase() as T;
}
