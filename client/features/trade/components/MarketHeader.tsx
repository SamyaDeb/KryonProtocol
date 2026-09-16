"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ACTIVE_MARKETS, MarketConfig } from "@/config";
import { getOpenInterest } from "@/lib/stellar/contracts";
import { formatAmount, formatChangePercent, formatMarketUsd, priceToHuman } from "@/lib/format";
import { useMarketStore } from "@/stores/market";
import { logoFor } from "@/components/common/AssetLogos";

const CaretIcon = () => (
  <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 4.5 L6 7.5 L9 4.5" />
  </svg>
);

export function MarketHeader({ market }: { market: MarketConfig }) {
  const router = useRouter();
  const [pairOpen, setPairOpen] = useState(false);
  const [pairQuery, setPairQuery] = useState("");
  // Every market's live figures, so the dropdown can show price + 24h% per row.
  const markPrices = useMarketStore((s) => s.markPrices);
  const allStats = useMarketStore((s) => s.marketStats);
  const allChangePct = useMarketStore((s) => s.priceChangePct);
  const markPrice = useMarketStore((s) => s.markPrices[market.marketId]);
  const stats = useMarketStore((s) => s.marketStats[market.marketId]);
  const ticker24h = useMarketStore((s) => s.ticker24h[market.marketId]);
  const changePct = useMarketStore((s) => s.priceChangePct[market.marketId]);

  const { data: oi } = useQuery({
    queryKey: ["oi", market.marketId],
    queryFn: () => getOpenInterest(market.marketId),
    refetchInterval: 15_000,
  });

  const markHuman = markPrice ? priceToHuman(markPrice) : null;

  // 24h volume: prefer indexer stats (already in 1e18 units from last_price),
  // fall back to on-chain OI sum as proxy
  const volumeDisplay = stats
    ? "$" + formatAmount(stats.volume, 0)
    : oi
    ? "$" + formatAmount(oi.total, 0)
    : "—";

  const displayPrice = stats && stats.lastPrice > 0n
    ? formatMarketUsd(market, stats.lastPrice)
    : markHuman !== null
    ? formatMarketUsd(market, markHuman)
    : "—";

  const baseSymbol = market.baseAsset;
  const activeMarkets = useMemo(() => Object.values(ACTIVE_MARKETS), []);
  const canSwitchMarkets = activeMarkets.length > 1;
  // With eight entries the list needs filtering; matches symbol or base asset.
  const visibleMarkets = useMemo(() => {
    const q = pairQuery.trim().toUpperCase();
    if (!q) return activeMarkets;
    return activeMarkets.filter(
      (m) => m.symbol.includes(q) || m.baseAsset.includes(q)
    );
  }, [activeMarkets, pairQuery]);
  const leverageDisplay = Math.round(market.maxLeverageBps / 10_000);

  const changeDisplay = changePct !== undefined
    ? formatChangePercent(changePct)
    : "—";
  const changeUp = changePct === undefined || changePct >= 0;
  const highDisplay = formatMarketUsd(market, ticker24h?.highPrice);
  const lowDisplay = formatMarketUsd(market, ticker24h?.lowPrice);

  const statItems: Array<{ label: string; value: string; tone?: "up" | "down" }> = [
    { label: "24h High", value: highDisplay },
    { label: "24h Low", value: lowDisplay },
    { label: "24h Change", value: changeDisplay, tone: changeUp ? "up" : "down" },
    { label: "24h Volume", value: volumeDisplay },
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
              <MarketPairLabel baseSymbol={baseSymbol} quoteAsset={market.quoteAsset} />
              <span className="text-[#a3a3a3]">
                <CaretIcon />
              </span>
            </button>
          ) : (
            <MarketPairLabel baseSymbol={baseSymbol} quoteAsset={market.quoteAsset} />
          )}
          <span className="rounded-[5px] border px-2 py-[2px] font-mono text-[11.5px] font-semibold border-[#334155] bg-[#212128] text-[#f5f5f5]">
            {leverageDisplay}X
          </span>
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
                    const rowStats = allStats[m.marketId];
                    const rowMark = markPrices[m.marketId];
                    const rowPrice =
                      rowStats && rowStats.lastPrice > 0n
                        ? formatMarketUsd(m, rowStats.lastPrice)
                        : formatMarketUsd(m, rowMark);
                    const rowChange = allChangePct[m.marketId];
                    return (
                      <button
                        key={m.marketId}
                        onClick={() => { setPairOpen(false); setPairQuery(""); if (m.marketId !== market.marketId) router.push(`/trade/${m.symbol}`); }}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-[10px] text-left hover:bg-[#2A2A31] transition-colors ${
                          m.marketId === market.marketId ? "bg-[#2A2A31]" : ""
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {logoFor(m.baseAsset, 18)}
                          <span className="flex flex-col">
                            <span className="text-[13px] font-semibold text-[#f5f5f5]">{m.symbol}</span>
                            <span className="font-mono text-[10px] text-[#737373]">{Math.round(m.maxLeverageBps / 10000)}x</span>
                          </span>
                        </span>
                        <span className="flex shrink-0 flex-col items-end">
                          <span className="font-mono text-[12px] text-[#f5f5f5]">{rowPrice}</span>
                          <span
                            className={`font-mono text-[10px] ${
                              rowChange === undefined
                                ? "text-[#737373]"
                                : rowChange >= 0
                                ? "text-[#1fae5b]"
                                : "text-[#ff4d5f]"
                            }`}
                          >
                            {rowChange === undefined ? "—" : formatChangePercent(rowChange)}
                          </span>
                        </span>
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
      <div
        className="flex h-full min-w-0 flex-1 items-center overflow-x-auto"
        style={{ scrollbarWidth: "none" }}
      >
      <div className="flex h-full shrink-0 items-center px-3">
        <span
          className="font-mono text-[15px] font-semibold text-[#f5f5f5]"
        >
          {displayPrice}
        </span>
      </div>

      {/* Stats strip */}
      <div className="flex h-full min-w-0 flex-1 items-center gap-5 px-2">
        {statItems.map((s, i) => (
          <div
            key={i}
            className={`flex h-full shrink-0 flex-col justify-center gap-[2px] ${
              i === statItems.length - 1 ? "min-w-[76px]" : "min-w-[68px]"
            }`}
          >
            <span className="text-[9.5px] font-semibold text-[#737373] whitespace-nowrap">{s.label}</span>
            <span
              className={`font-mono text-[12.5px] font-semibold ${
                s.tone
                  ? s.tone === "up"
                    ? "text-[#1fae5b]"
                    : "text-[#ff4d5f]"
                  : "text-[#f5f5f5]"
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
