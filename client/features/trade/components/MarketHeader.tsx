"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { logoFor } from "@/components/common/AssetLogos";
import { displayPrice, maxLeverage, useMarkets, type ArcMarket } from "@/features/markets/directory";
import { formatChange, formatCompactUsd, formatFundingRate, formatSize, formatUsdPrice } from "@/lib/format";
import { useMarketStore } from "@/stores/market";

const CaretIcon = () => (
  <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 4.5 L6 7.5 L9 4.5" />
  </svg>
);

/** A market's live figures: the stream's ticker when present, else the listing. */
function useLive(market: ArcMarket) {
  const ticker = useMarketStore((s) => s.tickers[market.marketId]);
  const stats = useMarketStore((s) => s.stats24h[market.marketId]);
  const mark = ticker?.markPrice ?? market.lastPrice;
  const index = ticker?.indexPrice ?? market.indexPrice;
  return {
    price: displayPrice({ lastPrice: mark, indexPrice: index }),
    index,
    fundingRatePerHour: ticker?.fundingRatePerHour ?? market.fundingRatePerHour,
    openInterest: (ticker?.longOpenInterest ?? market.longOpenInterest) + (ticker?.shortOpenInterest ?? market.shortOpenInterest),
    stats,
  };
}

export function MarketHeader({ market }: { market: ArcMarket }) {
  const router = useRouter();
  const [pairOpen, setPairOpen] = useState(false);
  const [pairQuery, setPairQuery] = useState("");
  const { list } = useMarkets();
  const tickers = useMarketStore((s) => s.tickers);
  const live = useLive(market);

  const markets = useMemo(() => list.filter((m) => m.active || m.marketId === market.marketId), [list, market.marketId]);
  const canSwitchMarkets = markets.length > 1;
  const visibleMarkets = useMemo(() => {
    const q = pairQuery.trim().toUpperCase();
    if (!q) return markets;
    return markets.filter((m) => m.symbol.includes(q) || m.baseAsset.includes(q));
  }, [markets, pairQuery]);

  const open24h = live.stats?.open ?? 0n;
  const change = open24h > 0n && live.price > 0n ? formatChange(open24h, live.price) : "—";
  const changeUp = !change.startsWith("-");
  const funding = formatFundingRate(live.fundingRatePerHour);

  const statItems: Array<{ label: string; value: string; tone?: "up" | "down"; title?: string }> = [
    {
      label: "Index",
      value: formatUsdPrice(market, live.index),
      title: "Oracle index price: what margin, funding and liquidation are computed against",
    },
    { label: "24h Change", value: change, tone: change === "—" ? undefined : changeUp ? "up" : "down" },
    { label: "24h High", value: formatUsdPrice(market, live.stats?.high) },
    { label: "24h Low", value: formatUsdPrice(market, live.stats?.low) },
    { label: "24h Volume", value: formatCompactUsd(market.volume24h, 18) },
    {
      label: "Open Interest",
      value: `${formatSize(market, live.openInterest)} ${market.baseAsset}`,
      title: "Long plus short open interest, in the base asset",
    },
    {
      label: "Funding / 1h",
      value: funding,
      tone: live.fundingRatePerHour === 0n ? undefined : live.fundingRatePerHour > 0n ? "down" : "up",
      title: "Hourly funding rate. Positive: longs pay shorts.",
    },
  ];

  return (
    <div className="flex h-[40px] items-center rounded-none border border-[#2A2A31] bg-[#19191A]">
      {/* Pair selector — switches market */}
      <div className="relative flex h-full shrink-0 items-center gap-2 px-3">
        <div className="flex items-center gap-[9px]">
          {canSwitchMarkets ? (
            <button
              type="button"
              className="flex items-center gap-[7px] transition-opacity hover:opacity-90"
              onClick={() => setPairOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={pairOpen}
            >
              <MarketPairLabel baseSymbol={market.baseAsset} quoteAsset={market.quoteAsset} />
              <span className="text-[#a3a3a3]">
                <CaretIcon />
              </span>
            </button>
          ) : (
            <MarketPairLabel baseSymbol={market.baseAsset} quoteAsset={market.quoteAsset} />
          )}
          <span className="rounded-[5px] border px-2 py-[2px] font-mono text-[11.5px] font-semibold border-[#334155] bg-[#212128] text-[#f5f5f5]">
            {maxLeverage(market)}X
          </span>
          {!market.active && (
            <span className="rounded-[5px] border border-[#7c2d12] bg-[#2a1a12] px-2 py-[2px] text-[11px] font-semibold text-[#fdba74]">
              Paused
            </span>
          )}
        </div>
        {canSwitchMarkets && pairOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => { setPairOpen(false); setPairQuery(""); }} />
            <div className="absolute left-0 top-full mt-2 z-50 w-[290px] rounded-[10px] border border-[#334155] bg-[#19191A] shadow-[0_20px_40px_rgba(0,0,0,.6)] overflow-hidden">
              <div className="border-b border-[#2A2A31] p-2">
                <input
                  autoFocus
                  value={pairQuery}
                  onChange={(e) => setPairQuery(e.target.value)}
                  placeholder="Search markets…"
                  aria-label="Search markets"
                  className="w-full rounded-[6px] border border-[#2A2A31] bg-[#212128] px-2 py-[6px] text-[12px] text-[#f5f5f5] outline-none placeholder:text-[#737373] focus:border-[#475569]"
                />
              </div>
              <div className="max-h-[320px] overflow-y-auto">
                {visibleMarkets.length === 0 ? (
                  <div className="px-3 py-4 text-center text-[12px] text-[#737373]">No markets match “{pairQuery}”</div>
                ) : (
                  visibleMarkets.map((m) => {
                    const t = tickers[m.marketId];
                    const rowPrice = displayPrice({
                      lastPrice: t?.markPrice ?? m.lastPrice,
                      indexPrice: t?.indexPrice ?? m.indexPrice,
                    });
                    return (
                      <button
                        key={m.marketId}
                        onClick={() => {
                          setPairOpen(false);
                          setPairQuery("");
                          if (m.marketId !== market.marketId) router.push(`/trade/${m.symbol}`);
                        }}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-[10px] text-left hover:bg-[#2A2A31] transition-colors ${
                          m.marketId === market.marketId ? "bg-[#2A2A31]" : ""
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {logoFor(m.baseAsset, 18)}
                          <span className="flex flex-col">
                            <span className="text-[13px] font-semibold text-[#f5f5f5]">{m.symbol}</span>
                            <span className="font-mono text-[10px] text-[#737373]">{maxLeverage(m)}x</span>
                          </span>
                        </span>
                        <span className="font-mono text-[12px] text-[#f5f5f5]">{formatUsdPrice(m, rowPrice)}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Only this region scrolls horizontally — keeping the pair selector out
          of it is what lets its dropdown escape the clipping context. */}
      <div className="flex h-full min-w-0 flex-1 items-center overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        <div className="flex h-full shrink-0 items-center px-3">
          <span
            className="font-mono text-[15px] font-semibold text-[#f5f5f5]"
            title={market.lastPrice > 0n ? "Mark price (time-weighted from fills)" : "Index price (no trades yet)"}
          >
            {formatUsdPrice(market, live.price)}
          </span>
        </div>

        <div className="flex h-full min-w-0 flex-1 items-center gap-5 px-2">
          {statItems.map((s) => (
            <div key={s.label} className="flex h-full shrink-0 flex-col justify-center gap-[2px] min-w-[68px]" title={s.title}>
              <span className="text-[9.5px] font-semibold text-[#737373] whitespace-nowrap">{s.label}</span>
              <span
                className={`font-mono text-[12.5px] font-semibold ${
                  s.tone ? (s.tone === "up" ? "text-[#1fae5b]" : "text-[#ff4d5f]") : "text-[#f5f5f5]"
                }`}
              >
                {s.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MarketPairLabel({ baseSymbol, quoteAsset }: { baseSymbol: string; quoteAsset: string }) {
  return (
    <span className="flex items-center gap-[7px]">
      {logoFor(baseSymbol, 19)}
      <span className="flex items-center gap-[3px] text-[15px] font-semibold text-[#f5f5f5]" style={{ letterSpacing: ".01em" }}>
        {baseSymbol}
        <span className="text-[#737373] font-normal">/</span>
        <span>{quoteAsset}</span>
      </span>
    </span>
  );
}
