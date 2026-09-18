/**
 * Incremental reads for the WebSocket server (`lib/ws/**`): "what changed
 * since the last poll", as opposed to the REST helpers' "what is there now".
 *
 * Two cursors, because the two streams change in different ways:
 *
 *  - The trade tape only ever GROWS, in chain order. A SETTLED fill has a
 *    `(blockNumber, logIndex)` from the indexer, so the tape's cursor is that
 *    pair — exact, and immune to clock skew. PENDING and REJECTED fills never
 *    appear on the tape (see `lib/queries/fills.ts`).
 *
 *  - An account's fills CHANGE IN PLACE: PENDING → SETTLED | REJECTED, or a
 *    PENDING row picking up a `rejectReason`. The only thing that moves on every
 *    such write is `updatedAt`, so that is the cursor. A timestamp cursor can
 *    miss a row whose transaction commits after a later-stamped one, so the
 *    caller re-reads a trailing overlap window and de-duplicates by
 *    `(fillId, status, rejectReason)`.
 *
 * Server-side only.
 */

import type { ArcNetworkId } from "@/lib/network";
import type { Queryable } from "./client";
import { fillFromRow, type FillView } from "./fills";

/** A settled fill's position in chain order. */
export interface TradeKey {
  blockNumber: bigint;
  logIndex: number;
}

const FILL_COLUMNS = `"fillId", "status", "rejectReason", "marketId", "maker", "taker",
  "makerOrderHash", "takerOrderHash", "takerIsBuy",
  "size"::text AS "size", "price"::text AS "price",
  "makerFee"::text AS "makerFee", "takerFee"::text AS "takerFee",
  "txHash", "blockNumber"::text AS "blockNumber", "logIndex", "createdAt", "updatedAt"`;

export interface StreamFill extends FillView {
  logIndex: number | null;
  updatedAt: Date;
}

function streamFillFromRow(r: Record<string, unknown>): StreamFill {
  return {
    ...fillFromRow(r),
    logIndex: r.logIndex === null || r.logIndex === undefined ? null : Number(r.logIndex),
    updatedAt: new Date(r.updatedAt as string),
  };
}

/** The newest settled print in a market, or null for an empty tape. */
export async function latestTradeKey(
  q: Queryable,
  network: ArcNetworkId,
  marketId: number
): Promise<TradeKey | null> {
  const rows = await q.query(
    `SELECT "blockNumber"::text AS "blockNumber", "logIndex" FROM "Fill"
     WHERE "network" = $1 AND "marketId" = $2 AND "status" = 'SETTLED'
     ORDER BY "blockNumber" DESC, "logIndex" DESC
     LIMIT 1`,
    [network, marketId]
  );
  if (rows.length === 0) return null;
  return { blockNumber: BigInt(String(rows[0].blockNumber)), logIndex: Number(rows[0].logIndex) };
}

/** Settled prints strictly after `after` in chain order, oldest first. */
export async function listTradesAfter(
  q: Queryable,
  network: ArcNetworkId,
  marketId: number,
  after: TradeKey | null,
  limit: number
): Promise<StreamFill[]> {
  const rows = await q.query(
    `SELECT ${FILL_COLUMNS} FROM "Fill"
     WHERE "network" = $1 AND "marketId" = $2 AND "status" = 'SETTLED'
       AND ($3::bigint IS NULL OR ("blockNumber", "logIndex") > ($3::bigint, $4::int))
     ORDER BY "blockNumber" ASC, "logIndex" ASC
     LIMIT $5`,
    [network, marketId, after ? after.blockNumber.toString() : null, after ? after.logIndex : 0, limit]
  );
  return rows.map(streamFillFromRow);
}

/**
 * Fills touching any of `addresses` (as maker or taker) whose row changed at or
 * after `since`, oldest change first. Every status: this is an account's own
 * view, where a PENDING fill is shown and labelled, never a public print.
 */
export async function listFillChanges(
  q: Queryable,
  network: ArcNetworkId,
  addresses: readonly string[],
  since: Date,
  limit: number
): Promise<StreamFill[]> {
  if (addresses.length === 0) return [];
  // Two indexed branches, as in `listFillsForAccount`.
  const rows = await q.query(
    `SELECT ${FILL_COLUMNS} FROM (
       SELECT * FROM "Fill" WHERE "network" = $1 AND "maker" = ANY($2::text[]) AND "updatedAt" >= $3
       UNION
       SELECT * FROM "Fill" WHERE "network" = $1 AND "taker" = ANY($2::text[]) AND "updatedAt" >= $3
     ) f
     ORDER BY "updatedAt" ASC, "fillId" ASC
     LIMIT $4`,
    [network, addresses, since, limit]
  );
  return rows.map(streamFillFromRow);
}
