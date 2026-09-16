"use client";

import { useState } from "react";
import { useMarketStore } from "@/stores/market";
import type { OrderBookLevel } from "@/lib/market/matcher";
import { UsdcLogo, logoFor } from "@/components/common/AssetLogos";
import type { MarketConfig } from "@/config";
import { Shuffle } from "lucide-react";
const CaretIcon = () => (
  <svg width={9} height={9} viewBox="0 0 12 12" fill="currentColor">
    <path d="M2 4 L6 8 L10 4 Z" />
  </svg>
);

type ViewMode = "both" | "asks" | "bids";

interface LevelRow {
  price: number;
  metric: number; // size in base or quote, per denomination
  cum: number;
}

// Aggregate raw book levels into price buckets of `tick`.
function groupByTick(levels: OrderBookLevel[], tick: number, isBid: boolean): { price: number; size: number }[] {
  const map = new Map<string, number>();
  for (const l of levels) {
    const p = parseFloat(l.price);
    const s = parseFloat(l.size);
    if (!isFinite(p) || !isFinite(s)) continue;
    const bucket = isBid ? Math.floor(p / tick) * tick : Math.ceil(p / tick) * tick;
    const key = bucket.toFixed(8);
    map.set(key, (map.get(key) ?? 0) + s);
  }
  const out = [...map.entries()].map(([k, size]) => ({ price: parseFloat(k), size }));
  out.sort((a, b) => (isBid ? b.price - a.price : a.price - b.price));
  return out;
}

export function OrderBook({ market }: { market: MarketConfig }) {
  const marketId = market.marketId;
  // The aggregation ladder is per asset — a $0.20 tick ladder is useless on a
  // $77,000 book. Comes from MarketConfig.tickSizes.
  const TICKS = market.tickSizes;
  const [activeTab, setActiveTab] = useState<"Order Book" | "Trades">("Order Book");
  const [hover, setHover] = useState<HoverState>(null);
  // Default to the second-finest tick, clamped for markets with a short ladder.
  const [tickIdx, setTickIdx] = useState(() => Math.min(1, TICKS.length - 1));
  const [tickOpen, setTickOpen] = useState(false);
  const [denomQuote, setDenomQuote] = useState(true); // false = base asset, true = quote (USDC)
  const [viewMode, setViewMode] = useState<ViewMode>("both");

  const book = useMarketStore((s) => s.orderBooks[marketId]);
  const tradesRaw = useMarketStore((s) => s.recentTrades[marketId]);
  const setSelectedPrice = useMarketStore((s) => s.setSelectedPrice);
  const trades = tradesRaw ?? [];

  // Switching markets can leave tickIdx past the end of a shorter ladder.
  const safeTickIdx = Math.min(tickIdx, TICKS.length - 1);
  const tick = TICKS[safeTickIdx];
  const unit = denomQuote ? market.quoteAsset : market.baseAsset;
  const depth = viewMode === "both" ? 10 : 22;
  // Enough decimals to render the chosen tick, but never fewer than the
  // market's own display precision.
  const priceDecimals = Math.max(market.priceDecimals, Math.ceil(-Math.log10(tick)));
  const tradeMetric = (price: string, size: string) => {
    const p = parseFloat(price);
    const s = parseFloat(size);
    if (!isFinite(p) || !isFinite(s)) return 0;
    return denomQuote ? p * s : s;
  };

  // Group → slice → cumulative on the chosen denomination metric.
  const toRows = (levels: { price: number; size: number }[]): LevelRow[] => {
    let run = 0;
    return levels.slice(0, depth).map(({ price, size }) => {
      const metric = denomQuote ? price * size : size;
      run += metric;
      return { price, metric, cum: run };
    });
  };

  const asks = toRows(groupByTick(book?.asks ?? [], tick, false));
  const bids = toRows(groupByTick(book?.bids ?? [], tick, true));

  const maxDepth = Math.max(
    asks.length ? asks[asks.length - 1].cum : 0,
    bids.length ? bids[bids.length - 1].cum : 0,
    1
  );

  const displayAsks = [...asks].reverse(); // highest at top, best ask near spread

  const bestAsk = asks[0]?.price ?? null;
  const bestBid = bids[0]?.price ?? null;
  const spreadAbs = bestAsk !== null && bestBid !== null ? (bestAsk - bestBid).toFixed(priceDecimals) : null;
  const midPrice = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : null;
  const spreadPct =
    spreadAbs && midPrice ? ((parseFloat(spreadAbs) / midPrice) * 100).toFixed(3) + "%" : "0.000%";

  const tabCls = (active: boolean) =>
    `flex-1 h-full text-center text-[13px] font-semibold relative transition-colors ${
      active
        ? "text-[#f5f5f5] after:content-[''] after:absolute after:left-0 after:right-0 after:bottom-[-1px] after:h-[2px] after:bg-[#ff9440]"
        : "text-[#a3a3a3] hover:text-[#f5f5f5]"
    }`;

  const onPriceClick = (price: number) => setSelectedPrice(marketId, price);

  const Asks = (
    <div className="flex-1 overflow-y-auto flex flex-col" style={{ scrollbarWidth: "none" }}>
      {displayAsks.length === 0 ? (
        <EmptyRows count={8} side="ask" />
      ) : (
        displayAsks.map((a, displayIdx) => {
          const originalIdx = asks.length - 1 - displayIdx;
          const hl = hover?.side === "ask" && originalIdx <= asks.length - 1 - (hover?.idx ?? 0);
          return (
            <BookRow
              key={displayIdx}
              level={a}
              side="ask"
              maxCum={maxDepth}
              highlight={hl}
              priceDecimals={priceDecimals}
              onClick={() => onPriceClick(a.price)}
              onEnter={() => setHover({ side: "ask", idx: displayIdx })}
              onLeave={() => setHover(null)}
            />
          );
        })
      )}
    </div>
  );

  const Bids = (
    <div className="flex-1 overflow-y-auto flex flex-col" style={{ scrollbarWidth: "none" }}>
      {bids.length === 0 ? (
        <EmptyRows count={8} side="bid" />
      ) : (
        bids.map((b, i) => {
          const hl = hover?.side === "bid" && i <= (hover?.idx ?? -1);
          return (
            <BookRow
              key={i}
              level={b}
              side="bid"
              maxCum={maxDepth}
              highlight={hl}
              priceDecimals={priceDecimals}
              onClick={() => onPriceClick(b.price)}
              onEnter={() => setHover({ side: "bid", idx: i })}
              onLeave={() => setHover(null)}
            />
          );
        })
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tabs */}
      <div className="mx-[8px] flex h-[46px] border-b border-[#3a3a42] shrink-0">
        {(["Order Book", "Trades"] as const).map((t) => (
          <button key={t} className={tabCls(activeTab === t)} onClick={() => setActiveTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {activeTab === "Order Book" ? (
        <>
          {/* Sub-controls */}
          <div className="flex items-center justify-between px-[8px] py-[7px] shrink-0 font-mono text-[12px] font-semibold text-[#f5f5f5]">
            <div className="flex items-center gap-[6px]">
              <div className="relative">
                <button
                  className="flex items-center gap-[7px] hover:text-[#f5f5f5] transition-colors"
                  onClick={() => setTickOpen((v) => !v)}
                >
                  {formatTick(tick)} <CaretIcon />
                </button>
                {tickOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setTickOpen(false)} />
                    <div className="absolute left-0 top-full mt-1 z-50 rounded-[8px] border border-[#334155] bg-[#212128] p-1 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
                      {TICKS.map((t, i) => (
                        <button
                          key={t}
                          onClick={() => { setTickIdx(i); setTickOpen(false); }}
                          className={`block w-full text-left px-3 py-[5px] rounded-[5px] transition-colors ${
                            i === safeTickIdx ? "text-[#f5f5f5] bg-[#212128]" : "text-[#a3a3a3] hover:text-[#f5f5f5] hover:bg-[#212128]"
                          }`}
                        >
                          {formatTick(t)}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-[8px]">
              <button
                className="flex items-center gap-[8px] text-[#f5f5f5] hover:text-[#f5f5f5] transition-colors"
                onClick={() => setDenomQuote((v) => !v)}
                title="Toggle size denomination"
              >
                {denomQuote ? <UsdcLogo size={13} /> : logoFor(market.baseAsset, 13)} {unit}{" "}
                <Shuffle size={13} className="text-[#a3a3a3]" />
              </button>
              <button
                className="hover:opacity-80 transition-opacity"
                onClick={() => setViewMode((m) => (m === "both" ? "asks" : m === "asks" ? "bids" : "both"))}
                title={`View: ${viewMode}`}
              >
                <svg width={16} height={14} viewBox="0 0 16 14" fill="none">
                  <circle cx="2.4" cy="4" r="1.7" fill={viewMode === "bids" ? "#525252" : "#e06a6a"} />
                  <rect x="6" y="3.2" width="9" height="1.6" rx="0.8" fill={viewMode === "bids" ? "#525252" : "#6b7280"} />
                  <circle cx="2.4" cy="10" r="1.7" fill={viewMode === "asks" ? "#525252" : "#54bd7c"} />
                  <rect x="6" y="9.2" width="9" height="1.6" rx="0.8" fill={viewMode === "asks" ? "#525252" : "#6b7280"} />
                </svg>
              </button>
            </div>
          </div>

          {/* Column headers */}
          <div
            className="grid grid-cols-3 px-[8px] pb-[6px] font-mono text-[11px] text-[#9fb0c9] shrink-0"
            style={{ letterSpacing: ".02em" }}
          >
            <span>Price</span>
            <span className="text-right">Size</span>
            <span className="text-right">Total</span>
          </div>

          {viewMode !== "bids" && Asks}

          {/* Spread row */}
          <div
            className="grid grid-cols-3 px-[8px] py-[7px] bg-[#212128] font-mono text-[11.5px] font-semibold shrink-0"
          >
            <span className="font-medium text-[#f5f5f5]">{spreadAbs ?? "—"}</span>
            <span className="text-center text-[#f5f5f5]">Spread</span>
            <span className="text-right text-[#f5f5f5]">{spreadPct}</span>
          </div>

          {viewMode !== "asks" && Bids}
        </>
      ) : (
        /* Trades tab */
        <div className="flex flex-col flex-1 overflow-hidden">
          <div
            className="grid grid-cols-3 px-[8px] py-[6px] font-mono text-[11px] text-[#9fb0c9] border-b border-[#2A2A31] shrink-0"
            style={{ letterSpacing: ".02em" }}
          >
            <span>Price</span>
            <span className="text-right">Size</span>
            <span className="text-right">Time</span>
          </div>
          <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
            {trades.length === 0 ? (
              <div className="flex items-center justify-center h-16">
                <span className="text-[11px] text-[#737373]">No trades yet</span>
              </div>
            ) : (
              trades.map((t, i) => (
                <div
                  key={i}
                  className="grid grid-cols-3 font-mono text-[11.5px] hover:bg-white/[0.02] cursor-pointer"
                  style={{ padding: "4px 8px" }}
                  onClick={() => setSelectedPrice(marketId, parseFloat(t.price))}
                >
                  <span
                    className={
                      t.side === "buy"
                        ? "text-[#54bd7c]"
                        : t.side === "sell"
                          ? "text-[#e06a6a]"
                          : "text-[#a3a3a3]"
                    }
                  >
                    {parseFloat(t.price).toFixed(market.priceDecimals)}
                  </span>
                  <span className="text-right text-[#f5f5f5]">
                    {fmt(tradeMetric(t.price, t.size))}
                  </span>
                  <span className="text-right text-[#a3a3a3]">
                    {new Date(t.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type HoverState = { side: "ask" | "bid"; idx: number } | null;

// toFixed, not String(): String(0.00001) is "1e-5".
function formatTick(t: number): string {
  return t.toFixed(Math.max(0, Math.ceil(-Math.log10(t))));
}

function fmt(n: number): string {
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2);
}

function BookRow({
  level,
  side,
  maxCum,
  highlight,
  priceDecimals,
  onClick,
  onEnter,
  onLeave,
}: {
  level: LevelRow;
  side: "ask" | "bid";
  maxCum: number;
  highlight: boolean;
  priceDecimals: number;
  onClick: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const barPct = (level.cum / maxCum) * 100;

  return (
    <div
      className="relative grid grid-cols-3 overflow-hidden rounded-[4px] font-mono text-[12px] cursor-pointer hover:bg-white/[0.03]"
      style={{ padding: "3px 5px", margin: "1px 8px", lineHeight: 1.4 }}
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div
        className={`absolute top-0 bottom-0 left-0 rounded-[4px] ${
          side === "ask" ? "bg-[rgba(199,67,67,0.34)]" : "bg-[rgba(54,156,91,0.32)]"
        }`}
        style={{ width: `${barPct}%` }}
      />
      {highlight && <div className="absolute inset-0 bg-white/[0.08] z-[1]" />}
      <span className={`relative z-10 ${side === "ask" ? "text-[#ff5d5d]" : "text-[#42e783]"}`}>
        {level.price.toFixed(priceDecimals)}
      </span>
      <span className="relative z-10 text-right text-[#f5f5f5]">{fmt(level.metric)}</span>
      <span className="relative z-10 text-right text-[#f5f5f5]">{fmt(level.cum)}</span>
    </div>
  );
}

function EmptyRows({ count, side }: { count: number; side: "ask" | "bid" }) {
  const widths = [40, 56, 32, 48, 36, 52, 28, 44, 60, 34, 50, 38, 46, 30];
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="grid grid-cols-3 font-mono text-[11.5px]"
          style={{ padding: "3px 8px", lineHeight: 1.4 }}
        >
          <div
            className={`h-[5px] rounded-full opacity-[0.06] ${side === "ask" ? "bg-[#e06a6a]" : "bg-[#54bd7c]"}`}
            style={{ width: widths[i % widths.length] }}
          />
          <div className="h-[5px] rounded-full bg-[#334155] opacity-[0.06] ml-auto" style={{ width: 36 }} />
          <div className="h-[5px] rounded-full bg-[#334155] opacity-[0.06] ml-auto" style={{ width: 44 }} />
        </div>
      ))}
    </>
  );
}
