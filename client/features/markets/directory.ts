"use client";

/**
 * Markets as the chain lists them (via `/api/markets`), decorated for display.
 *
 * Listings are governance's to change: RiskParams can list a market without a
 * client deploy, so there is no static table here. Risk parameters, fees and
 * live state are chain state and arrive as exact 1e18 integers; `lib/markets.ts`
 * adds only how to render the symbol.
 *
 * A small store holds the resolved markets so synchronous helpers (row
 * formatters) can read them. Components that render from them call
 * `useMarkets()` so they re-render when they arrive.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";

import { apiFetch } from "@/lib/api";
import { big } from "@/lib/market/book";
import { canonicalSymbol, displayFor, type MarketDisplay } from "@/lib/markets";

export interface MarketEntry extends MarketDisplay {
  marketId: number;
  active: boolean;
}

/** A market with everything `/api/markets` says about it, exact. */
export interface ArcMarket extends MarketEntry {
  /** Mark TWAP from fills, 1e18; 0 before the first trade. */
  lastPrice: bigint;
  /** Oracle index, 1e18; what margin and liquidation price against. */
  indexPrice: bigint;
  /** 24h settled notional, 1e18 USD. */
  volume24h: bigint;
  trades24h: number;
  longOpenInterest: bigint;
  shortOpenInterest: bigint;
  /** 1e18 fraction per hour, signed. */
  fundingRatePerHour: bigint;
  /** Millionths of notional; the maker rate may be negative (rebate). */
  makerRate: number;
  takerRate: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  liquidationFeeBps: number;
  maxLeverageBps: number;
  maxExecutionDeviationBps: number;
  /** 1e18 base units. */
  maxOpenInterest: bigint;
  /** 1e18 USD: the gateway rejects smaller fills. */
  minFillNotional: bigint;
}

/** The fields `toDirectory` needs; the full shape is `ApiMarket`. */
export interface ApiMarketListing {
  market_id: number;
  symbol: string;
  active: boolean;
}

type ApiMarket = ApiMarketListing & Record<string, unknown>;

const b = (v: unknown) => big(v) ?? 0n;
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function toArcMarket(m: ApiMarket): ArcMarket {
  return {
    ...displayFor(m.symbol),
    marketId: m.market_id,
    active: m.active,
    lastPrice: b(m.last_price),
    indexPrice: b(m.index_price),
    volume24h: b(m.volume),
    trades24h: n(m.trades_24h),
    longOpenInterest: b(m.long_open_interest),
    shortOpenInterest: b(m.short_open_interest),
    fundingRatePerHour: b(m.funding_rate_per_hour),
    makerRate: n(m.maker_rate),
    takerRate: n(m.taker_rate),
    initialMarginBps: n(m.initial_margin_bps),
    maintenanceMarginBps: n(m.maintenance_margin_bps),
    liquidationFeeBps: n(m.liquidation_fee_bps),
    maxLeverageBps: n(m.max_leverage_bps),
    maxExecutionDeviationBps: n(m.max_execution_deviation_bps),
    maxOpenInterest: b(m.max_open_interest),
    minFillNotional: b(m.min_fill_notional),
  };
}

export function toDirectory(markets: ApiMarketListing[]): Record<number, ArcMarket> {
  const out: Record<number, ArcMarket> = {};
  for (const m of markets) out[m.market_id] = toArcMarket(m as ApiMarket);
  return out;
}

/** The price to show for a market: the mark once it has traded, else the index. */
export function displayPrice(m: Pick<ArcMarket, "lastPrice" | "indexPrice">): bigint {
  return m.lastPrice > 0n ? m.lastPrice : m.indexPrice;
}

/** Max leverage as a whole multiple, e.g. 50 for 500_000 bps. */
export function maxLeverage(m: Pick<ArcMarket, "maxLeverageBps">): number {
  return Math.floor(m.maxLeverageBps / 10_000);
}

interface DirectoryState {
  byId: Record<number, ArcMarket>;
  set: (byId: Record<number, ArcMarket>) => void;
}

const useDirectoryStore = create<DirectoryState>((set) => ({
  byId: {},
  set: (byId) => set({ byId }),
}));

export const MARKETS_QUERY_KEY = ["markets"] as const;

async function fetchMarkets(): Promise<Record<number, ArcMarket>> {
  const res = await apiFetch("/api/markets", { cache: "no-store" });
  if (!res.ok) throw new Error(`markets ${res.status}`);
  return toDirectory(((await res.json()) as { markets: ApiMarket[] }).markets);
}

export interface MarketsResult {
  /** Every listed market, by id. Empty until the first load. */
  byId: Record<number, ArcMarket>;
  /** Listed markets, id order. */
  list: ArcMarket[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * Every listed market, refreshed every 15s for its live figures. The trading
 * screen gets faster ticks from the `markets` stream channel on top of this.
 */
export function useMarkets(): MarketsResult {
  const setDirectory = useDirectoryStore((s) => s.set);
  const { data, isLoading, error } = useQuery({
    queryKey: MARKETS_QUERY_KEY,
    queryFn: fetchMarkets,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
  useEffect(() => {
    if (data) setDirectory(data);
  }, [data, setDirectory]);
  const byId = useDirectoryStore((s) => s.byId);
  const list = Object.values(byId).sort((a, b) => a.marketId - b.marketId);
  return { byId, list, isLoading, error: (error as Error | null) ?? null };
}

/** Kept for existing callers: load and subscribe, returning markets by id. */
export function useMarketDirectory(): Record<number, ArcMarket> {
  return useMarkets().byId;
}

/** A market by its URL symbol ("BTC-PERP" or "btc-perp"). */
export function findBySymbol(list: readonly ArcMarket[], symbol: string): ArcMarket | undefined {
  const want = canonicalSymbol(symbol);
  return list.find((m) => m.symbol === want);
}

/** Synchronous lookup for row formatters; undefined until the markets load. */
export function marketById(marketId: number): ArcMarket | undefined {
  return useDirectoryStore.getState().byId[marketId];
}

/** Display symbol for a market id, falling back to "#<id>". */
export function marketSymbol(marketId: number): string {
  return marketById(marketId)?.symbol ?? `#${marketId}`;
}
