"use client";

/**
 * Market id → display metadata, from the chain (via `/api/markets`), not from
 * a hardcoded table.
 *
 * History rows carry only a market id. The previous chain's config answered
 * "what is market 2?" from a static list; on Arc the answer is whatever
 * RiskParams listed, which governance can extend without a client deploy. The
 * API is the source; `lib/markets.ts` only decorates the symbol it returns.
 *
 * A small store holds the resolved directory so synchronous helpers (row
 * formatters) can read it; components that render from it call
 * `useMarketDirectory()` so they re-render when it arrives.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";

import { apiFetch } from "@/lib/api";
import { displayFor, type MarketDisplay } from "@/lib/markets";

export interface MarketEntry extends MarketDisplay {
  marketId: number;
  active: boolean;
}

interface DirectoryState {
  byId: Record<number, MarketEntry>;
  set: (byId: Record<number, MarketEntry>) => void;
}

const useDirectoryStore = create<DirectoryState>((set) => ({
  byId: {},
  set: (byId) => set({ byId }),
}));

interface ApiMarket {
  market_id: number;
  symbol: string;
  active: boolean;
}

export function toDirectory(markets: ApiMarket[]): Record<number, MarketEntry> {
  const out: Record<number, MarketEntry> = {};
  for (const m of markets) out[m.market_id] = { ...displayFor(m.symbol), marketId: m.market_id, active: m.active };
  return out;
}

/** Load (once, then rarely) and subscribe to the market directory. */
export function useMarketDirectory(): Record<number, MarketEntry> {
  const setDirectory = useDirectoryStore((s) => s.set);
  const { data } = useQuery({
    queryKey: ["market-directory"],
    queryFn: async () => {
      const res = await apiFetch("/api/markets");
      if (!res.ok) throw new Error(`markets ${res.status}`);
      return toDirectory(((await res.json()) as { markets: ApiMarket[] }).markets);
    },
    // Listings change by governance action, not by the second.
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });
  useEffect(() => {
    if (data) setDirectory(data);
  }, [data, setDirectory]);
  return useDirectoryStore((s) => s.byId);
}

/** Synchronous lookup for row formatters; undefined until the directory loads. */
export function marketById(marketId: number): MarketEntry | undefined {
  return useDirectoryStore.getState().byId[marketId];
}

/** Display symbol for a market id, falling back to "#<id>". */
export function marketSymbol(marketId: number): string {
  return marketById(marketId)?.symbol ?? `#${marketId}`;
}
