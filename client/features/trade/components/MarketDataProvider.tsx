"use client";

/**
 * Feeds the market store for the trading screen, from Kryon's own services:
 *
 *   WebSocket (preferred)   orderbook:<id>, trades:<id>, markets
 *   REST (fallback)         /api/markets/:id/orderbook and /trades every 1.5s,
 *                           /api/markets every 5s, while the socket is down
 *   REST (always)           hourly candles for the 24h open / high / low
 *
 * Every price is the venue's own: the book and tape from the matcher and
 * indexer, mark and index from the chain. No third-party price feed, so what
 * the header shows is what the contracts will act on.
 *
 * Renders nothing of its own and never subscribes to the store, so market
 * ticks do not re-render the terminal around it.
 */

import { useEffect } from "react";

import { useNetwork } from "@/features/network/NetworkContext";
import { apiFetch } from "@/lib/api";
import {
  parseOrderBook,
  parseTicker,
  parseTrade,
  stats24hFromCandles,
  type MarketTicker,
  type StreamEvent,
  type Trade,
} from "@/lib/market/book";
import { channelName, marketStream } from "@/lib/market/stream";
import { useMarketStore } from "@/stores/market";

const BOOK_POLL_MS = 1_500;
const MARKETS_POLL_MS = 5_000;
const STATS_POLL_MS = 60_000;

/** `/api/markets` entries as tickers (the REST twin of the `markets` channel). */
function tickersFromListing(json: unknown): MarketTicker[] {
  const markets = (json as { markets?: unknown[] } | null)?.markets;
  if (!Array.isArray(markets)) return [];
  return markets
    .map((m) => {
      const r = m as Record<string, unknown>;
      return parseTicker({
        market_id: r.market_id,
        symbol: r.symbol,
        active: r.active,
        mark_price_raw: r.last_price,
        index_price_raw: r.index_price,
        funding_rate_per_hour_raw: r.funding_rate_per_hour,
        long_open_interest_raw: r.long_open_interest,
        short_open_interest_raw: r.short_open_interest,
      });
    })
    .filter((t): t is MarketTicker => t !== null);
}

export function MarketDataProvider({ marketId, children }: { marketId: number; children: React.ReactNode }) {
  const { network } = useNetwork();

  useEffect(() => {
    let cancelled = false;
    const store = () => useMarketStore.getState();
    const inFlight = new Set<string>();
    const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
    const stream = marketStream(network);
    const live = () => stream?.connected === true;

    /** One request per key at a time; skipped while hidden. */
    const once = async (key: string, fn: () => Promise<void>) => {
      if (inFlight.has(key) || !visible()) return;
      inFlight.add(key);
      try {
        await fn();
      } catch {
        // Best effort: the next tick retries, and the UI keeps the last value.
      } finally {
        inFlight.delete(key);
      }
    };

    const getJson = async (path: string): Promise<unknown | null> => {
      const res = await apiFetch(path, { cache: "no-store" });
      return res.ok ? res.json() : null;
    };

    const pollBook = () =>
      once("book", async () => {
        const book = parseOrderBook(await getJson(`/api/markets/${marketId}/orderbook`));
        if (!cancelled && book) store().setOrderBook(marketId, book);
      });

    const pollTrades = () =>
      once("trades", async () => {
        const rows = await getJson(`/api/markets/${marketId}/trades?limit=100`);
        if (cancelled || !Array.isArray(rows)) return;
        store().setTrades(marketId, rows.map(parseTrade).filter((t): t is Trade => t !== null));
      });

    const pollMarkets = () =>
      once("markets", async () => {
        const tickers = tickersFromListing(await getJson("/api/markets"));
        if (!cancelled && tickers.length > 0) store().setTickers(tickers);
      });

    const pollStats = () =>
      once("stats", async () => {
        const rows = await getJson(`/api/markets/${marketId}/candles?tf=3600&limit=25`);
        if (!cancelled) store().setStats24h(marketId, stats24hFromCandles(rows, Date.now()));
      });

    const onEvent = (ev: StreamEvent) => {
      if (cancelled) return;
      if (ev.kind === "orderbook" && ev.marketId === marketId) store().setOrderBook(marketId, ev.book);
      else if (ev.kind === "trade" && ev.marketId === marketId) store().prependTrade(marketId, ev.trade);
      else if (ev.kind === "markets") store().setTickers(ev.markets);
    };

    // Everything once, immediately: the socket's snapshots may take a moment.
    void pollBook();
    void pollTrades();
    void pollMarkets();
    void pollStats();

    const releases: (() => void)[] = [];
    if (stream) {
      releases.push(stream.subscribe(channelName.orderbook(marketId), onEvent));
      releases.push(stream.subscribe(channelName.trades(marketId), onEvent));
      releases.push(stream.subscribe(channelName.markets, onEvent));
      releases.push(
        stream.onStatus((connected) => {
          store().setWsConnected(connected);
          // Catch up on anything missed while the socket was down.
          if (!connected) {
            void pollBook();
            void pollTrades();
          }
        })
      );
      store().setWsConnected(stream.connected);
    } else {
      store().setWsConnected(false);
    }

    const timers = [
      setInterval(() => {
        if (!live()) {
          void pollBook();
          void pollTrades();
        }
      }, BOOK_POLL_MS),
      setInterval(() => {
        if (!live()) void pollMarkets();
      }, MARKETS_POLL_MS),
      setInterval(() => void pollStats(), STATS_POLL_MS),
    ];

    const onVisibility = () => {
      if (!visible()) return;
      void pollBook();
      void pollTrades();
      void pollMarkets();
      void pollStats();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      timers.forEach(clearInterval);
      releases.forEach((release) => release());
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [marketId, network]);

  return <>{children}</>;
}
