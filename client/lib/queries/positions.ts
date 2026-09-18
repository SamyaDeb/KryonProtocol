/**
 * Typed read helpers for the `Position` projection (from `Engine.PositionUpdated`).
 *
 * Arc positions are one signed row per (trader, market) in a cross-margined
 * account: there is no per-position id, margin or mode, and direction is the
 * sign of `size`. The entry price is derived, not stored.
 *
 * Server-side only.
 */

import type { ArcNetworkId } from "@/lib/network";
import type { Queryable } from "./client";
import { big } from "./scalars";

const E18 = 10n ** 18n;

export interface PositionView {
  trader: string;
  marketId: number;
  /** 1e18, signed: positive long, negative short. */
  size: bigint;
  /** 1e18, signed like `size`: the cost basis of the open size. */
  openNotional: bigint;
  /** |openNotional| / |size|, 1e18. Zero for a flat position. */
  entryPrice: bigint;
  /** Price of the last fill that touched the position, 1e18. */
  lastPrice: bigint;
  /** 1e18, signed. */
  realizedPnlCum: bigint;
  updatedAt: Date;
}

const abs = (x: bigint) => (x < 0n ? -x : x);

export function entryPrice(size: bigint, openNotional: bigint): bigint {
  return size === 0n ? 0n : (abs(openNotional) * E18) / abs(size);
}

export function positionFromRow(r: Record<string, unknown>): PositionView {
  const size = big(r.size);
  const openNotional = big(r.openNotional);
  return {
    trader: String(r.trader),
    marketId: Number(r.marketId),
    size,
    openNotional,
    entryPrice: entryPrice(size, openNotional),
    lastPrice: big(r.lastPrice),
    realizedPnlCum: big(r.realizedPnlCum),
    updatedAt: new Date(r.updatedAt as string),
  };
}

/** An account's open (non-zero) positions, by market. */
export async function listOpenPositions(
  q: Queryable,
  network: ArcNetworkId,
  trader: string,
  marketId: number | null
): Promise<PositionView[]> {
  const rows = await q.query(
    `SELECT "trader", "marketId", "size"::text AS "size", "openNotional"::text AS "openNotional",
            "lastPrice"::text AS "lastPrice", "realizedPnlCum"::text AS "realizedPnlCum", "updatedAt"
     FROM "Position"
     WHERE "network" = $1 AND "trader" = $2 AND "size" <> 0
       AND ($3::int IS NULL OR "marketId" = $3::int)
     ORDER BY "marketId" ASC`,
    [network, trader, marketId]
  );
  return rows.map(positionFromRow);
}
