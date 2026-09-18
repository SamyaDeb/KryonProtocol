/**
 * Typed read helpers for the `Fill` table. The API never writes `Fill`.
 *
 * A fill is PENDING from the moment the matcher commits it until the indexer
 * sees `FillSettled` (→ SETTLED) or `FillRejected` (→ REJECTED). A PENDING fill
 * may still reject, so:
 *
 *  - an account's own fill history returns every status and labels it;
 *  - anything public and market-wide — prints, candles, volume — counts
 *    SETTLED fills only, because a print that later rejects never happened.
 *
 * Server-side only.
 */

import type { ArcNetworkId } from "@/lib/network";
import type { Queryable } from "./client";
import { big } from "./scalars";

export type FillStatus = "PENDING" | "SETTLED" | "REJECTED";

export interface FillView {
  fillId: string;
  status: FillStatus;
  /** Set when the chain rejected the fill (on a PENDING row until the indexer catches up). */
  rejectReason: string | null;
  marketId: number;
  maker: string;
  taker: string;
  makerOrderHash: string;
  takerOrderHash: string;
  takerIsBuy: boolean;
  /** 1e18. */
  size: bigint;
  /** 1e18. */
  price: bigint;
  /** 1e18, signed (negative = rebate). */
  makerFee: bigint;
  takerFee: bigint;
  txHash: string | null;
  blockNumber: bigint | null;
  createdAt: Date;
}

const COLUMNS = `"fillId", "status", "rejectReason", "marketId", "maker", "taker",
  "makerOrderHash", "takerOrderHash", "takerIsBuy",
  "size"::text AS "size", "price"::text AS "price",
  "makerFee"::text AS "makerFee", "takerFee"::text AS "takerFee",
  "txHash", "blockNumber"::text AS "blockNumber", "createdAt"`;

export function fillFromRow(r: Record<string, unknown>): FillView {
  return {
    fillId: String(r.fillId),
    status: String(r.status) as FillStatus,
    rejectReason: r.rejectReason === null || r.rejectReason === undefined ? null : String(r.rejectReason),
    marketId: Number(r.marketId),
    maker: String(r.maker),
    taker: String(r.taker),
    makerOrderHash: String(r.makerOrderHash),
    takerOrderHash: String(r.takerOrderHash),
    takerIsBuy: r.takerIsBuy === true,
    size: big(r.size),
    price: big(r.price),
    makerFee: big(r.makerFee),
    takerFee: big(r.takerFee),
    txHash: r.txHash === null || r.txHash === undefined ? null : String(r.txHash),
    blockNumber: r.blockNumber === null || r.blockNumber === undefined ? null : big(r.blockNumber),
    createdAt: new Date(r.createdAt as string),
  };
}

/** An account's fills on either side, every status, newest first. */
export async function listFillsForAccount(
  q: Queryable,
  network: ArcNetworkId,
  address: string,
  since: Date,
  limit: number
): Promise<FillView[]> {
  // Two indexed branches rather than `maker = $2 OR taker = $2`, which cannot
  // use the (network, maker, createdAt) / (network, taker, createdAt) indexes.
  const rows = await q.query(
    `SELECT ${COLUMNS} FROM (
       SELECT * FROM "Fill" WHERE "network" = $1 AND "maker" = $2 AND "createdAt" > $3
       UNION
       SELECT * FROM "Fill" WHERE "network" = $1 AND "taker" = $2 AND "createdAt" > $3
     ) f
     ORDER BY "createdAt" DESC, "id" DESC
     LIMIT $4`,
    [network, address, since, limit]
  );
  return rows.map(fillFromRow);
}

/** A market's settled prints, newest first by chain order. */
export async function listTrades(
  q: Queryable,
  network: ArcNetworkId,
  marketId: number,
  limit: number
): Promise<FillView[]> {
  const rows = await q.query(
    `SELECT ${COLUMNS} FROM "Fill"
     WHERE "network" = $1 AND "marketId" = $2 AND "status" = 'SETTLED'
     ORDER BY "blockNumber" DESC, "logIndex" DESC
     LIMIT $3`,
    [network, marketId, limit]
  );
  return rows.map(fillFromRow);
}

export interface Candle {
  /** Bucket start, unix seconds. */
  time: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  /** Σ size, 1e18. */
  volume: bigint;
}

/** OHLCV over settled fills in `tfSec` buckets, oldest first. */
export async function listCandles(
  q: Queryable,
  network: ArcNetworkId,
  marketId: number,
  tfSec: number,
  limit: number
): Promise<Candle[]> {
  const rows = await q.query(
    `SELECT * FROM (
       SELECT
         (floor(extract(epoch FROM "createdAt") / $3::int)::bigint * $3::int) AS "time",
         ((array_agg("price" ORDER BY "blockNumber", "logIndex"))[1])::text AS "open",
         MAX("price")::text AS "high",
         MIN("price")::text AS "low",
         ((array_agg("price" ORDER BY "blockNumber" DESC, "logIndex" DESC))[1])::text AS "close",
         SUM("size")::text AS "volume"
       FROM "Fill"
       WHERE "network" = $1 AND "marketId" = $2 AND "status" = 'SETTLED'
       GROUP BY 1
       ORDER BY 1 DESC
       LIMIT $4
     ) c ORDER BY "time" ASC`,
    [network, marketId, tfSec, limit]
  );
  return rows.map((r) => ({
    time: Number(r.time),
    open: big(r.open),
    high: big(r.high),
    low: big(r.low),
    close: big(r.close),
    volume: big(r.volume),
  }));
}

export interface MarketVolume {
  /** Σ size, 1e18 base units. */
  size: bigint;
  /** Σ size × price / 1e18, 1e18 USDC. */
  notional: bigint;
  trades: number;
}

/** Settled volume per market since `since`. Markets with no fills are absent. */
export async function marketVolumes(
  q: Queryable,
  network: ArcNetworkId,
  since: Date
): Promise<Map<number, MarketVolume>> {
  const rows = await q.query(
    `SELECT "marketId",
            SUM("size")::text AS "size",
            TRUNC(SUM("size" * "price") / 1000000000000000000)::text AS "notional",
            COUNT(*)::int AS "trades"
     FROM "Fill"
     WHERE "network" = $1 AND "status" = 'SETTLED' AND "createdAt" > $2
     GROUP BY "marketId"`,
    [network, since]
  );
  const out = new Map<number, MarketVolume>();
  for (const r of rows) {
    out.set(Number(r.marketId), { size: big(r.size), notional: big(r.notional), trades: Number(r.trades) });
  }
  return out;
}
