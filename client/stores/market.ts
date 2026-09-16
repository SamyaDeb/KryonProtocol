"use client";

import { create } from "zustand";
import type { OrderBook, RecentTrade } from "@/lib/market/matcher";

interface MarketState {
  // Oracle/mark price by marketId — 1e18 precision
  markPrices: Record<number, bigint>;
  setMarkPrice: (marketId: number, price: bigint) => void;

  // Orderbook snapshot by marketId (null = not yet received)
  orderBooks: Record<number, OrderBook | null>;
  setOrderBook: (marketId: number, book: OrderBook | null) => void;

  // Recent trades by marketId (newest first, capped at 100)
  recentTrades: Record<number, RecentTrade[]>;
  setTrades: (marketId: number, trades: RecentTrade[]) => void;
  prependTrade: (marketId: number, trade: RecentTrade) => void;

  // Indexer market stats (last fill price, 24h volume)
  marketStats: Record<number, { lastPrice: bigint; volume: bigint; longOI: bigint; shortOI: bigint } | null>;
  setMarketStats: (marketId: number, stats: { lastPrice: bigint; volume: bigint; longOI: bigint; shortOI: bigint }) => void;

  // 24h ticker data by marketId, sourced from the configured external market feed.
  priceChangePct: Record<number, number>;
  setPriceChangePct: (marketId: number, pct: number) => void;
  ticker24h: Record<number, { highPrice: bigint; lowPrice: bigint; changePct: number }>;
  setTicker24h: (
    marketId: number,
    ticker: { highPrice: bigint; lowPrice: bigint; changePct: number }
  ) => void;

  // WebSocket connection status
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;

  // Price picked from the order book / trades feed → prefills the order ticket
  selectedPrice: Record<number, number | null>;
  setSelectedPrice: (marketId: number, price: number) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  markPrices: {},
  setMarkPrice: (marketId, price) =>
    set((s) => ({ markPrices: { ...s.markPrices, [marketId]: price } })),

  orderBooks: {},
  setOrderBook: (marketId, book) =>
    set((s) => ({ orderBooks: { ...s.orderBooks, [marketId]: book } })),

  recentTrades: {},
  setTrades: (marketId, trades) =>
    set((s) => ({ recentTrades: { ...s.recentTrades, [marketId]: trades } })),
  prependTrade: (marketId, trade) =>
    set((s) => ({
      recentTrades: {
        ...s.recentTrades,
        [marketId]: [trade, ...(s.recentTrades[marketId] ?? []).slice(0, 99)],
      },
    })),

  marketStats: {},
  setMarketStats: (marketId, stats) =>
    set((s) => ({ marketStats: { ...s.marketStats, [marketId]: stats } })),

  priceChangePct: {},
  setPriceChangePct: (marketId, pct) =>
    set((s) => ({ priceChangePct: { ...s.priceChangePct, [marketId]: pct } })),
  ticker24h: {},
  setTicker24h: (marketId, ticker) =>
    set((s) => ({ ticker24h: { ...s.ticker24h, [marketId]: ticker } })),

  wsConnected: false,
  setWsConnected: (wsConnected) => set({ wsConnected }),

  selectedPrice: {},
  setSelectedPrice: (marketId, price) =>
    set((s) => ({ selectedPrice: { ...s.selectedPrice, [marketId]: price } })),
}));
