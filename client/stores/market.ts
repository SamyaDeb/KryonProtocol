"use client";

import { create } from "zustand";

import type { MarketTicker, OrderBook, Trade } from "@/lib/market/book";

/** 24h figures derived from our own settled fills (hourly candles). */
export interface Stats24h {
  /** First trade price in the window, 1e18; 0 when nothing traded. */
  open: bigint;
  high: bigint;
  low: bigint;
}

interface MarketState {
  /**
   * The price positions are valued at, per market, 1e18: the mark once the
   * market has traded, else the oracle index. Written from the `markets`
   * stream channel or the `/api/markets` poll.
   */
  markPrices: Record<number, bigint>;
  setMarkPrice: (marketId: number, price: bigint) => void;

  /** Live mark, index, funding and OI per market. */
  tickers: Record<number, MarketTicker>;
  setTickers: (tickers: MarketTicker[]) => void;

  /** Order book snapshot per market (null = not yet received). */
  orderBooks: Record<number, OrderBook | null>;
  setOrderBook: (marketId: number, book: OrderBook | null) => void;

  /** Settled prints per market, newest first, capped at 100, one per fill id. */
  recentTrades: Record<number, Trade[]>;
  setTrades: (marketId: number, trades: Trade[]) => void;
  prependTrade: (marketId: number, trade: Trade) => void;

  stats24h: Record<number, Stats24h>;
  setStats24h: (marketId: number, stats: Stats24h) => void;

  /** Whether the WebSocket feed is live (else the provider polls REST). */
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;

  /** A price picked from the book or tape, to prefill the order ticket (1e18). */
  selectedPrice: Record<number, bigint | null>;
  setSelectedPrice: (marketId: number, price: bigint) => void;
}

const MAX_TRADES = 100;

export const useMarketStore = create<MarketState>((set) => ({
  markPrices: {},
  setMarkPrice: (marketId, price) => set((s) => ({ markPrices: { ...s.markPrices, [marketId]: price } })),

  tickers: {},
  setTickers: (tickers) =>
    set((s) => {
      const next = { ...s.tickers };
      const marks = { ...s.markPrices };
      for (const t of tickers) {
        next[t.marketId] = t;
        const price = t.markPrice > 0n ? t.markPrice : t.indexPrice;
        if (price > 0n) marks[t.marketId] = price;
      }
      return { tickers: next, markPrices: marks };
    }),

  orderBooks: {},
  setOrderBook: (marketId, book) => set((s) => ({ orderBooks: { ...s.orderBooks, [marketId]: book } })),

  recentTrades: {},
  setTrades: (marketId, trades) =>
    set((s) => ({ recentTrades: { ...s.recentTrades, [marketId]: trades.slice(0, MAX_TRADES) } })),
  prependTrade: (marketId, trade) =>
    set((s) => {
      const current = s.recentTrades[marketId] ?? [];
      // The REST snapshot and the stream can both carry the same print.
      if (current.some((t) => t.fillId === trade.fillId)) return s;
      return { recentTrades: { ...s.recentTrades, [marketId]: [trade, ...current].slice(0, MAX_TRADES) } };
    }),

  stats24h: {},
  setStats24h: (marketId, stats) => set((s) => ({ stats24h: { ...s.stats24h, [marketId]: stats } })),

  wsConnected: false,
  setWsConnected: (wsConnected) => set({ wsConnected }),

  selectedPrice: {},
  setSelectedPrice: (marketId, price) => set((s) => ({ selectedPrice: { ...s.selectedPrice, [marketId]: price } })),
}));
