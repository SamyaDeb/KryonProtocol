"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { logoFor, UsdcLogo } from "@/components/common/AssetLogos";
import { displayPrice, maxLeverage, useMarkets, type ArcMarket } from "@/features/markets/directory";
import { useNetwork } from "@/features/network/NetworkContext";
import { apiFetch } from "@/lib/api";
import { formatChange, formatCompactUsd, formatRateBps, formatUsdPrice } from "@/lib/format";
import { stats24hFromCandles } from "@/lib/market/book";
import { notional } from "@/lib/math";

/** 24h open from the market's own settled fills; 0 when nothing traded. */
function useOpen24h(marketId: number): bigint {
  const { network } = useNetwork();
  const { data } = useQuery({
    queryKey: ["open24h", network, marketId],
    queryFn: async () => {
      const res = await apiFetch(`/api/markets/${marketId}/candles?tf=3600&limit=25`, { cache: "no-store" }, network);
      return res.ok ? stats24hFromCandles(await res.json(), Date.now()).open : 0n;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  return data ?? 0n;
}

function MarketRow({ market }: { market: ArcMarket }) {
  const price = displayPrice(market);
  const open24h = useOpen24h(market.marketId);
  const change = open24h > 0n && price > 0n ? formatChange(open24h, price) : null;
  const oiUsd = notional(market.longOpenInterest + market.shortOpenInterest, market.indexPrice);

  return (
    <div className="flex flex-col gap-3 border-b border-[#2A2A31] px-4 py-4 last:border-b-0 transition-colors hover:bg-white/[0.02] md:grid md:grid-cols-[1.5fr_.9fr_.7fr_.9fr_.9fr_.6fr_1fr_.7fr] md:items-center md:gap-0">
      <div className="flex items-center justify-between gap-2 md:block">
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-[14px] font-semibold">
            {logoFor(market.baseAsset, 18)}
            {market.symbol}
          </span>
          <span className="text-[12px] text-[#a3a3a3]">
            {market.baseAsset} perpetual settled in {market.quoteAsset}
            {!market.active && <span className="ml-2 text-[#fdba74]">· Paused</span>}
          </span>
        </div>
        <Link
          href={`/trade/${market.symbol}`}
          className="inline-flex shrink-0 rounded-[6px] border border-[#2A2A31] bg-[#19191A] px-3 py-2 text-[12px] font-semibold text-[#f5f5f5] transition-colors hover:border-[#475569] md:hidden"
        >
          Trade
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-y-2 text-[13px] md:contents">
        <MarketStat label="Price">
          <span className="font-mono text-[#f5f5f5]">{formatUsdPrice(market, price)}</span>
        </MarketStat>
        <MarketStat label="24h">
          <span
            className={`font-mono ${
              change === null ? "text-[#737373]" : change.startsWith("-") ? "text-[#ff4d5f]" : "text-[#1fae5b]"
            }`}
          >
            {change ?? "—"}
          </span>
        </MarketStat>
        <MarketStat label="24h Volume">
          <span className="font-mono text-[#f5f5f5]">{formatCompactUsd(market.volume24h, 18)}</span>
        </MarketStat>
        <MarketStat label="Open Interest">
          <span className="font-mono text-[#f5f5f5]">{formatCompactUsd(oiUsd, 18)}</span>
        </MarketStat>
        <MarketStat label="Leverage">
          <span className="font-mono text-[#f5f5f5]">{maxLeverage(market)}x</span>
        </MarketStat>
        <MarketStat label="Fees">
          <span
            className="font-mono text-[12px] text-[#a3a3a3]"
            title="Maker / taker, in basis points of notional"
          >
            {formatRateBps(market.makerRate)} / {formatRateBps(market.takerRate)}
          </span>
        </MarketStat>
      </div>

      <div className="hidden text-right md:block">
        <Link
          href={`/trade/${market.symbol}`}
          className="inline-flex rounded-[6px] border border-[#2A2A31] bg-[#19191A] px-3 py-2 text-[12px] font-semibold text-[#f5f5f5] transition-colors hover:border-[#475569]"
        >
          Trade
        </Link>
      </div>
    </div>
  );
}

// On mobile shows a label above the value; on desktop (md:contents) the wrapper
// dissolves and the value becomes a plain grid cell.
function MarketStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 md:block">
      <span className="text-[10px] uppercase tracking-wider text-[#737373] md:hidden">{label}</span>
      {children}
    </div>
  );
}

export function MarketsTable() {
  const [query, setQuery] = useState("");
  const { list, isLoading, error } = useMarkets();
  const markets = list;

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return markets;
    return markets.filter((m) => m.symbol.includes(q) || m.baseAsset.includes(q));
  }, [markets, query]);

  const activeCount = markets.filter((m) => m.active).length;

  return (
    <>
      {markets.length > 0 && (
        <div className="self-start rounded-[6px] border border-[#2A2A31] bg-[#212128] px-3 py-2 text-[12px] text-[#a3a3a3]">
          {activeCount} active{markets.length > activeCount ? ` · ${markets.length - activeCount} paused` : ""}
        </div>
      )}
      {markets.length > 4 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search markets…"
          aria-label="Search markets"
          className="w-full max-w-[280px] rounded-[6px] border border-[#2A2A31] bg-[#212128] px-3 py-2 text-[13px] text-[#f5f5f5] outline-none placeholder:text-[#737373] focus:border-[#475569]"
        />
      )}

      <div className="overflow-hidden rounded-[10px] border border-[#2A2A31] bg-[#212128]">
        {/* Column header — desktop only */}
        <div className="hidden grid-cols-[1.5fr_.9fr_.7fr_.9fr_.9fr_.6fr_1fr_.7fr] border-b border-[#2A2A31] px-4 py-3 text-[11px] uppercase tracking-[.08em] text-[#737373] md:grid">
          <div>Market</div>
          <div>Price</div>
          <div>24h</div>
          <div>24h Volume</div>
          <div>Open Interest</div>
          <div>Leverage</div>
          <div>Fees (maker / taker)</div>
          <div className="text-right">Action</div>
        </div>

        {error && markets.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-[#ff9b9b]">
            Markets are unavailable right now. The indexer or API may be down; retrying.
          </div>
        ) : isLoading && markets.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-[#737373]">Loading markets…</div>
        ) : markets.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-[#737373]">
            No markets are listed on this network yet.
          </div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-[#737373]">No markets match “{query}”</div>
        ) : (
          visible.map((market) => <MarketRow key={market.marketId} market={market} />)
        )}
      </div>

      <p className="flex items-center gap-1.5 text-[12px] text-[#737373]">
        <UsdcLogo size={13} /> All markets are settled in USDC.
      </p>
    </>
  );
}
