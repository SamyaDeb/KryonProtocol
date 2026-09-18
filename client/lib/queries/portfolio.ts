/**
 * Typed read helpers for one account's portfolio page.
 *
 * Two scales meet here, and mixing them up is the easy mistake:
 *  - event tables (`PnlEvent`, `BalanceChange.internalAmount`) are 1e18,
 *    exactly as the contracts emitted them;
 *  - analytics tables (`AccountAnalytics`, `PortfolioSnapshot`) are 1e6 USDC,
 *    because they are rollups for display.
 * Each view below states its scale on every field.
 *
 * Server-side only.
 */

import type { ArcNetworkId } from "@/lib/network";
import type { Queryable } from "./client";
import { big } from "./scalars";

export interface AccountAnalyticsView {
  /** 1e6, signed. */
  realizedPnlAll: bigint;
  /** 1e6. */
  volumeAll: bigint;
  tradeCountAll: number;
  /** 0..1. */
  winRateAll: number;
  /** 1e6. */
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  /** 1e6, signed. */
  totalFundingPaid: bigint;
  totalFeesPaid: bigint;
  liquidationCount: number;
  firstTradeAt: Date | null;
  lastTradeAt: Date | null;
}

export interface PnlEventView {
  kind: string;
  marketId: number;
  /** 1e18, signed (positive = credit). */
  amount: bigint;
  /** 1e18. */
  size: bigint;
  /** 1e18. */
  price: bigint;
  txHash: string;
  createdAt: Date;
}

export interface BalanceChangeView {
  kind: string;
  counterparty: string | null;
  /** 1e18, always positive; `kind` gives the direction. */
  internalAmount: bigint;
  txHash: string;
  createdAt: Date;
}

export interface PortfolioSnapshotView {
  /** 1e6. */
  equity: bigint;
  /** 1e6, signed. */
  unrealizedPnl: bigint;
  realizedPnlCum: bigint;
  freeCollateral: bigint;
  initialMargin: bigint;
  maintenanceMargin: bigint;
  openPositionCount: number;
  capturedAt: Date;
}

const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));

export async function getAccountAnalytics(
  q: Queryable,
  network: ArcNetworkId,
  address: string
): Promise<AccountAnalyticsView | null> {
  const rows = await q.query(
    `SELECT "realizedPnlAll"::text AS "realizedPnlAll", "volumeAll"::text AS "volumeAll",
            "tradeCountAll", "winRateAll"::text AS "winRateAll",
            "totalDeposited"::text AS "totalDeposited", "totalWithdrawn"::text AS "totalWithdrawn",
            "totalFundingPaid"::text AS "totalFundingPaid", "totalFeesPaid"::text AS "totalFeesPaid",
            "liquidationCount", "firstTradeAt", "lastTradeAt"
     FROM "AccountAnalytics" WHERE "network" = $1 AND "address" = $2`,
    [network, address]
  );
  const a = rows[0];
  if (!a) return null;
  return {
    realizedPnlAll: big(a.realizedPnlAll),
    volumeAll: big(a.volumeAll),
    tradeCountAll: Number(a.tradeCountAll),
    winRateAll: Number(a.winRateAll),
    totalDeposited: big(a.totalDeposited),
    totalWithdrawn: big(a.totalWithdrawn),
    totalFundingPaid: big(a.totalFundingPaid),
    totalFeesPaid: big(a.totalFeesPaid),
    liquidationCount: Number(a.liquidationCount),
    firstTradeAt: date(a.firstTradeAt),
    lastTradeAt: date(a.lastTradeAt),
  };
}

export async function listPnlEvents(
  q: Queryable,
  network: ArcNetworkId,
  address: string,
  limit: number
): Promise<PnlEventView[]> {
  const rows = await q.query(
    `SELECT "kind", "marketId", "amount"::text AS "amount", "size"::text AS "size",
            "price"::text AS "price", "txHash", "createdAt"
     FROM "PnlEvent" WHERE "network" = $1 AND "address" = $2
     ORDER BY "createdAt" DESC, "id" DESC LIMIT $3`,
    [network, address, limit]
  );
  return rows.map((r) => ({
    kind: String(r.kind),
    marketId: Number(r.marketId),
    amount: big(r.amount),
    size: big(r.size),
    price: big(r.price),
    txHash: String(r.txHash),
    createdAt: new Date(r.createdAt as string),
  }));
}

export async function listBalanceChanges(
  q: Queryable,
  network: ArcNetworkId,
  address: string,
  limit: number
): Promise<BalanceChangeView[]> {
  const rows = await q.query(
    `SELECT "kind", "counterparty", "internalAmount"::text AS "internalAmount", "txHash", "createdAt"
     FROM "BalanceChange" WHERE "network" = $1 AND "address" = $2
     ORDER BY "createdAt" DESC, "id" DESC LIMIT $3`,
    [network, address, limit]
  );
  return rows.map((r) => ({
    kind: String(r.kind),
    counterparty: r.counterparty === null || r.counterparty === undefined ? null : String(r.counterparty),
    internalAmount: big(r.internalAmount),
    txHash: String(r.txHash),
    createdAt: new Date(r.createdAt as string),
  }));
}

/** Most recent snapshots, oldest first (an equity curve). */
export async function listPortfolioSnapshots(
  q: Queryable,
  network: ArcNetworkId,
  address: string,
  limit: number
): Promise<PortfolioSnapshotView[]> {
  const rows = await q.query(
    `SELECT * FROM (
       SELECT "equity"::text AS "equity", "unrealizedPnl"::text AS "unrealizedPnl",
              "realizedPnlCum"::text AS "realizedPnlCum", "freeCollateral"::text AS "freeCollateral",
              "initialMargin"::text AS "initialMargin", "maintenanceMargin"::text AS "maintenanceMargin",
              "openPositionCount", "capturedAt", "id"
       FROM "PortfolioSnapshot" WHERE "network" = $1 AND "address" = $2
       ORDER BY "capturedAt" DESC, "id" DESC LIMIT $3
     ) s ORDER BY "capturedAt" ASC, "id" ASC`,
    [network, address, limit]
  );
  return rows.map((r) => ({
    equity: big(r.equity),
    unrealizedPnl: big(r.unrealizedPnl),
    realizedPnlCum: big(r.realizedPnlCum),
    freeCollateral: big(r.freeCollateral),
    initialMargin: big(r.initialMargin),
    maintenanceMargin: big(r.maintenanceMargin),
    openPositionCount: Number(r.openPositionCount),
    capturedAt: new Date(r.capturedAt as string),
  }));
}
