"use client";

/**
 * The connected account's data from the API, parsed to exact bigints.
 *
 * One hook per route, shared by every panel that shows it, so the positions
 * table, the chart overlay and the order ticket read the same cached answer
 * rather than polling the same route three times.
 *
 * Query keys carry the network: the same address has unrelated state on
 * testnet and mainnet.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useNetwork } from "@/features/network/NetworkContext";
import { apiFetch } from "@/lib/api";
import { big, type FillStatus } from "@/lib/market/book";
import type { ArcNetworkId } from "@/lib/network";

const b = (v: unknown) => big(v) ?? 0n;
const s = (v: unknown) => (typeof v === "string" ? v : null);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface AccountPosition {
  marketId: number;
  /** Signed, 1e18; negative is short. */
  size: bigint;
  /** Signed cost basis, 1e18 USD. */
  openNotional: bigint;
  entryPrice: bigint;
  /** Realized PnL over the position's life, 1e18 USD. */
  realizedPnlCum: bigint;
  updatedAt: number;
}

export interface AccountOrder {
  orderHash: string;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  /** Settled on chain. */
  filledSize: bigint;
  /** Matched and submitted, not yet final. */
  pendingSize: bigint;
  /** What the matcher can still trade (lib/queries/orders.ts, never recomputed here). */
  remainingSize: bigint;
  reduceOnly: boolean;
  nonce: bigint;
  expiry: bigint;
  status: string;
  expired: boolean;
  nonceInvalidated: boolean;
  createdAt: number;
}

export interface AccountFill {
  id: string;
  status: FillStatus;
  rejectReason: string | null;
  marketId: number;
  isMaker: boolean;
  side: "buy" | "sell";
  price: bigint;
  size: bigint;
  /** 1e18 USD, signed: negative is a rebate. */
  fee: bigint;
  txHash: string | null;
  blockNumber: bigint | null;
  createdAt: number;
}

export interface FundingPayment {
  marketId: number;
  /** 1e18 USD, signed: positive means the account received funding. */
  amount: bigint;
  txHash: string;
  createdAt: number;
}

export const accountKeys = {
  positions: (network: ArcNetworkId, address: string) => ["positions", network, address.toLowerCase()] as const,
  orders: (network: ArcNetworkId, address: string) => ["orders", network, address.toLowerCase()] as const,
  fills: (network: ArcNetworkId, address: string) => ["fills", network, address.toLowerCase()] as const,
  funding: (network: ArcNetworkId, address: string) => ["funding", network, address.toLowerCase()] as const,
};

async function getJson(path: string, network: ArcNetworkId): Promise<unknown> {
  const res = await apiFetch(path, { cache: "no-store" }, network);
  if (!res.ok) throw new Error(`${path.split("?")[0]} ${res.status}`);
  return res.json();
}

export function parsePositions(json: unknown): AccountPosition[] {
  const rows = (json as { positions?: unknown[] } | null)?.positions;
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      marketId: n(r.market_id),
      size: b(r.size),
      openNotional: b(r.open_notional),
      entryPrice: b(r.entry_price),
      realizedPnlCum: b(r.realized_pnl_cum),
      updatedAt: n(r.updated_at),
    };
  });
}

export function parseOrders(json: unknown): AccountOrder[] {
  const rows = (json as { orders?: unknown[] } | null)?.orders;
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      orderHash: s(r.order_hash) ?? "",
      marketId: n(r.market_id),
      isLong: r.is_long === true,
      size: b(r.size),
      limitPrice: b(r.limit_price),
      filledSize: b(r.filled_size),
      pendingSize: b(r.pending_size),
      remainingSize: b(r.remaining_size),
      reduceOnly: r.reduce_only === true,
      nonce: b(r.nonce),
      expiry: b(r.expiry),
      status: s(r.status) ?? "",
      expired: r.expired === true,
      nonceInvalidated: r.nonce_invalidated === true,
      createdAt: n(r.created_at),
    };
  });
}

export function parseFills(json: unknown): AccountFill[] {
  if (!Array.isArray(json)) return [];
  return json.map((raw) => {
    const r = raw as Record<string, unknown>;
    const status = r.status === "SETTLED" || r.status === "REJECTED" ? r.status : "PENDING";
    return {
      id: String(r.id ?? ""),
      status,
      rejectReason: s(r.rejectReason),
      marketId: n(r.marketId),
      isMaker: r.isMaker === true,
      side: r.side === "sell" ? "sell" : "buy",
      price: b(r.priceRaw),
      size: b(r.sizeRaw),
      fee: b(r.feeRaw),
      txHash: s(r.txHash),
      blockNumber: r.blockNumber === null || r.blockNumber === undefined ? null : big(r.blockNumber),
      createdAt: n(r.createdAt),
    };
  });
}

export function parseFunding(json: unknown): FundingPayment[] {
  if (!Array.isArray(json)) return [];
  return json.map((raw) => {
    const r = raw as Record<string, unknown>;
    return { marketId: n(r.marketId), amount: b(r.amountRaw), txHash: s(r.txHash) ?? "", createdAt: n(r.createdAt) };
  });
}

function useAccountQuery<T>(
  key: (network: ArcNetworkId, address: string) => readonly unknown[],
  path: (address: string) => string,
  parse: (json: unknown) => T,
  address: string | null | undefined,
  refetchInterval: number
): UseQueryResult<T> {
  const { network } = useNetwork();
  return useQuery({
    queryKey: address ? key(network, address) : ["account-disabled"],
    queryFn: async () => parse(await getJson(path(address!), network)),
    enabled: !!address,
    refetchInterval,
  });
}

/** Open positions. */
export function usePositions(address: string | null | undefined) {
  return useAccountQuery(accountKeys.positions, (a) => `/api/positions?address=${a}`, parsePositions, address, 5_000);
}

/** Orders the matcher can still trade. */
export function useOpenOrders(address: string | null | undefined) {
  return useAccountQuery(accountKeys.orders, (a) => `/api/orders/list?address=${a}`, parseOrders, address, 5_000);
}

/** Recent fills in every status; the UI keeps PENDING apart from SETTLED. */
export function useFills(address: string | null | undefined) {
  return useAccountQuery(accountKeys.fills, (a) => `/api/fills?address=${a}&limit=50`, parseFills, address, 5_000);
}

/** Funding settlements. */
export function useFunding(address: string | null | undefined) {
  return useAccountQuery(accountKeys.funding, (a) => `/api/funding?address=${a}&limit=100`, parseFunding, address, 30_000);
}

/** Every order in every status, newest first (`status=all`). */
export function useOrderHistory(address: string | null | undefined) {
  return useAccountQuery(
    (network, a) => ["order-history", network, a.toLowerCase()] as const,
    (a) => `/api/orders/list?address=${a}&status=all&limit=200`,
    parseOrders,
    address,
    15_000
  );
}
