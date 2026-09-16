"use client";

import { useEffect, useRef } from "react";
import { useMarketStore } from "@/stores/market";
import { getOraclePrice } from "@/lib/stellar/oracle";
import { fetchOrderBook, fetchRecentTrades } from "@/lib/market/matcher";
import {
  wsSetHandlers,
  wsSubscribe,
  wsUnsubscribe,
  wsDisconnect,
  wsReset,
} from "@/lib/market/websocket";
import { ACTIVE_MARKETS, MARKETS, PRICE_PRECISION, type MarketConfig } from "@/config";
import type { OrderBook, RecentTrade } from "@/lib/market/matcher";
import { apiFetch } from "@/lib/api";

interface Props {
  market: MarketConfig;
  children: React.ReactNode;
}

// Binance pair for a market. Unknown ids return null rather than falling back
// to XLM — a wrong ticker is worse than no 24h stats.
function getBinancePair(marketId: number): string | null {
  const market = Object.values(MARKETS).find((m) => m.marketId === marketId);
  return market ? market.priceSourceSymbol : null;
}

// Fetch Binance 24h ticker once — gives last price, 24h high/low, and 24h % change.
async function fetchBinance24h(
  marketId: number
): Promise<{ price: bigint; highPrice: bigint; lowPrice: bigint; changePct: number } | null> {
  try {
    const pair = getBinancePair(marketId);
    if (!pair) return null;
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      lastPrice: string;
      highPrice: string;
      lowPrice: string;
      priceChangePercent: string;
    };
    const priceFloat = parseFloat(data.lastPrice);
    const highFloat = parseFloat(data.highPrice);
    const lowFloat = parseFloat(data.lowPrice);
    const changePct = parseFloat(data.priceChangePercent);
    return {
      price: priceFloat > 0 ? BigInt(Math.round(priceFloat * Number(PRICE_PRECISION))) : 0n,
      highPrice: highFloat > 0 ? BigInt(Math.round(highFloat * Number(PRICE_PRECISION))) : 0n,
      lowPrice: lowFloat > 0 ? BigInt(Math.round(lowFloat * Number(PRICE_PRECISION))) : 0n,
      changePct: isNaN(changePct) ? 0 : changePct,
    };
  } catch {
    return null;
  }
}

/**
 * One batched 24h ticker for EVERY active market.
 *
 * The market switcher and the markets page show a price and 24h change per
 * row, which needs data for markets the terminal is not currently subscribed
 * to. Binance's /ticker/24hr accepts a `symbols` array, so this is a single
 * request for all eight rather than eight requests — and notably it does NOT
 * require touching lib/market/websocket.ts, whose single global handler set
 * still only has to serve the one market on screen.
 */
async function fetchAllTickers(): Promise<
  Record<number, { price: bigint; changePct: number }>
> {
  const markets = Object.values(ACTIVE_MARKETS);
  const symbols = markets.map((m) => m.priceSourceSymbol);
  const url =
    `https://api.binance.com/api/v3/ticker/24hr?symbols=` +
    encodeURIComponent(JSON.stringify(symbols));
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return {};
  const rows = (await res.json()) as { symbol: string; lastPrice: string; priceChangePercent: string }[];
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));

  const out: Record<number, { price: bigint; changePct: number }> = {};
  for (const m of markets) {
    const r = bySymbol.get(m.priceSourceSymbol);
    if (!r) continue;
    const last = parseFloat(r.lastPrice);
    const pct = parseFloat(r.priceChangePercent);
    if (!Number.isFinite(last) || last <= 0) continue;
    out[m.marketId] = {
      price: BigInt(Math.round(last * Number(PRICE_PRECISION))),
      changePct: Number.isFinite(pct) ? pct : 0,
    };
  }
  return out;
}

export function MarketDataProvider({ market, children }: Props) {
  const marketId = market.marketId;
  const oracleSymbol = market.oracleSymbol;
  // NOTE: intentionally does NOT subscribe to the store (no useMarketStore()).
  // It only writes via getState() setters, so market-data ticks never re-render
  // this wrapper or its (stable) children.
  const wsActiveRef = useRef(false);
  const visibleRef = useRef(true);
  const inFlightRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    const set = () => useMarketStore.getState();
    const runOnce = async (key: string, fn: () => Promise<void>) => {
      if (inFlightRef.current[key]) return;
      inFlightRef.current[key] = true;
      try {
        await fn();
      } finally {
        inFlightRef.current[key] = false;
      }
    };

    visibleRef.current = typeof document === "undefined" ? true : document.visibilityState === "visible";
    function onVisibility() {
      visibleRef.current = document.visibilityState === "visible";
      if (visibleRef.current) {
        pollOracle();
        pollOrderBook();
        pollTrades();
        pollMarketStats();
        pollAllTickers();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    // ── Oracle price → Binance fallback ──────────────────────────────────────
    // Wrapped so a failed/slow RPC never becomes an unhandled rejection on the
    // polling interval; we degrade to the Binance price instead.
    async function pollOracle() {
      if (!visibleRef.current) return;
      await runOnce("oracle", async () => {
      try {
        const result = await getOraclePrice(oracleSymbol);
        if (cancelled) return;
        if (result && result.price > 0n) {
          set().setMarkPrice(marketId, result.price);
          return;
        }
      } catch { /* RPC failure — fall through to Binance */ }
      try {
        const b = await fetchBinance24h(marketId);
        if (!cancelled && b && b.price > 0n) set().setMarkPrice(marketId, b.price);
      } catch { /* best-effort */ }
      });
    }

    // ── 24h change (Binance) ─────────────────────────────────────────────────
    async function poll24h() {
      if (!visibleRef.current) return;
      await runOnce("24h", async () => {
      const b = await fetchBinance24h(marketId);
      if (!cancelled && b) {
        set().setPriceChangePct(marketId, b.changePct);
        set().setTicker24h(marketId, {
          highPrice: b.highPrice,
          lowPrice: b.lowPrice,
          changePct: b.changePct,
        });
      }
      });
    }

    // ── All-markets ticker (switcher rows) ───────────────────────────────────
    // Only writes markets OTHER than the active one, so it can never race the
    // active market's oracle-backed mark price with a Binance figure.
    async function pollAllTickers() {
      if (!visibleRef.current) return;
      await runOnce("allTickers", async () => {
        try {
          const all = await fetchAllTickers();
          if (cancelled) return;
          for (const [idStr, v] of Object.entries(all)) {
            const id = Number(idStr);
            set().setPriceChangePct(id, v.changePct);
            if (id !== marketId) set().setMarkPrice(id, v.price);
          }
        } catch { /* best-effort — rows fall back to "—" */ }
      });
    }

    // ── Orderbook / trades REST polling (fallback when WS is down) ────────────
    async function pollOrderBook() {
      if (wsActiveRef.current || !visibleRef.current) return;
      await runOnce("book", async () => {
      const book = await fetchOrderBook(marketId);
      if (!cancelled && book) set().setOrderBook(marketId, book);
      });
    }

    async function pollTrades() {
      if (wsActiveRef.current || !visibleRef.current) return;
      await runOnce("trades", async () => {
      const trades = await fetchRecentTrades(marketId);
      if (!cancelled && trades.length > 0) set().setTrades(marketId, trades);
      });
    }

    // ── Market stats from indexer / node-runtime ──────────────────────────────
    async function pollMarketStats() {
      if (!visibleRef.current) return;
      await runOnce("stats", async () => {
      try {
        const res = await apiFetch(`/api/markets/${marketId}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Record<string, unknown>;
        if (cancelled) return;
        set().setMarketStats(marketId, {
          lastPrice: BigInt(String(data["last_price"] ?? "0")),
          volume: BigInt(String(data["volume"] ?? "0")),
          longOI: BigInt(String(data["long_open_interest"] ?? "0")),
          shortOI: BigInt(String(data["short_open_interest"] ?? "0")),
        });
      } catch { /* best-effort */ }
      });
    }

    // ── WS handlers ──────────────────────────────────────────────────────────
    function handleWsOrderBook(mid: number, book: OrderBook) {
      if (mid !== marketId) return;
      set().setOrderBook(mid, book);
    }
    function handleWsTrade(mid: number, trade: RecentTrade) {
      if (mid !== marketId) return;
      set().prependTrade(mid, trade);
    }
    function handleWsStatus(connected: boolean) {
      wsActiveRef.current = connected;
      set().setWsConnected(connected);
      if (!connected) {
        pollOrderBook();
        pollTrades();
      }
    }

    // Initial fetches immediately
    pollOracle();
    poll24h();
    pollAllTickers();
    pollOrderBook();
    pollTrades();
    pollMarketStats();

    const timers = [
      setInterval(pollOracle, 3_000),
      setInterval(() => { pollOrderBook(); pollTrades(); }, 1_500),
      setInterval(pollMarketStats, 15_000),
      setInterval(poll24h, 30_000),
      // Switcher rows only need to be roughly live.
      setInterval(pollAllTickers, 60_000),
    ];

    wsReset();
    wsSetHandlers(handleWsOrderBook, handleWsTrade, handleWsStatus);
    wsSubscribe(marketId);

    return () => {
      cancelled = true;
      timers.forEach(clearInterval);
      document.removeEventListener("visibilitychange", onVisibility);
      wsUnsubscribe(marketId);
      wsDisconnect();
    };
  }, [marketId, oracleSymbol]);

  return <>{children}</>;
}
