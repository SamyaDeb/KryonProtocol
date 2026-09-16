"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MarketConfig } from "@/config";
import { logoFor, UsdcLogo } from "@/components/common/AssetLogos";
import { formatChangePercent, formatMarketUsd, formatVolume } from "@/lib/format";
import { apiFetch } from "@/lib/api";

function leverageLabel(bps: number) {
  return `${Math.round(bps / 10_000)}x`;
}

interface Row {
  lastPrice: bigint;
  volume: bigint;
  longOI: bigint;
  shortOI: bigint;
  changePct: number | null;
}

/**
 * Live figures per market. `/api/markets/[id]` supplies indexed price / volume
 * / OI; the 24h change comes from Binance, matching what MarketDataProvider
 * uses on the trade terminal.
 */
async function fetchRow(market: MarketConfig): Promise<Row | null> {
  const [statsRes, tickerRes] = await Promise.allSettled([
    apiFetch(`/api/markets/${market.marketId}`, { cache: "no-store" }),
    fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${market.priceSourceSymbol}`, { cache: "no-store" }),
  ]);

  let stats: Record<string, unknown> = {};
  if (statsRes.status === "fulfilled" && statsRes.value.ok) {
    stats = (await statsRes.value.json()) as Record<string, unknown>;
  }

  let changePct: number | null = null;
  let binanceLast = 0n;
  if (tickerRes.status === "fulfilled" && tickerRes.value.ok) {
    const t = (await tickerRes.value.json()) as { priceChangePercent: string; lastPrice: string };
    const pct = parseFloat(t.priceChangePercent);
    changePct = Number.isFinite(pct) ? pct : null;
    const last = parseFloat(t.lastPrice);
    if (Number.isFinite(last) && last > 0) binanceLast = BigInt(Math.round(last * 1e18));
  }

  const indexed = BigInt(String(stats["last_price"] ?? "0"));
  return {
    // Fall back to the Binance last price when nothing has traded on-venue yet
    // — a market with an empty Fill table would otherwise show "—" forever.
    lastPrice: indexed > 0n ? indexed : binanceLast,
    volume: BigInt(String(stats["volume"] ?? "0")),
    longOI: BigInt(String(stats["long_open_interest"] ?? "0")),
    shortOI: BigInt(String(stats["short_open_interest"] ?? "0")),
    changePct,
  };
}

function MarketRow({ market }: { market: MarketConfig }) {
  const { data } = useQuery({
    queryKey: ["markets-page-row", market.marketId],
    queryFn: () => fetchRow(market),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const oi = data ? data.longOI + data.shortOI : null;

  return (
    <div className="flex flex-col gap-3 border-b border-[#2A2A31] px-4 py-4 last:border-b-0 transition-colors hover:bg-white/[0.02] md:grid md:grid-cols-[1.5fr_.9fr_.7fr_.9fr_.9fr_.6fr_.7fr] md:items-center md:gap-0">
      <div className="flex items-center justify-between gap-2 md:block">
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-[14px] font-semibold">
            {logoFor(market.baseAsset, 18)}
            {market.symbol}
          </span>
          <span className="text-[12px] text-[#a3a3a3]">
            {market.baseAsset} perpetual settled in {market.quoteAsset}
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
          <span className="font-mono text-[#f5f5f5]">
            {data ? formatMarketUsd(market, data.lastPrice) : "—"}
          </span>
        </MarketStat>
        <MarketStat label="24h">
          <span
            className={`font-mono ${
              data?.changePct == null
                ? "text-[#737373]"
                : data.changePct >= 0
                ? "text-[#1fae5b]"
                : "text-[#ff4d5f]"
            }`}
          >
            {data?.changePct == null ? "—" : formatChangePercent(data.changePct)}
          </span>
        </MarketStat>
        <MarketStat label="24h Volume">
          <span className="font-mono text-[#f5f5f5]">{data ? formatVolume(data.volume) : "—"}</span>
        </MarketStat>
        <MarketStat label="Open Interest">
          <span className="font-mono text-[#f5f5f5]">{oi !== null ? formatVolume(oi) : "—"}</span>
        </MarketStat>
        <MarketStat label="Leverage">
          <span className="font-mono text-[#f5f5f5]">{leverageLabel(market.maxLeverageBps)}</span>
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

export function MarketsTable({ markets }: { markets: MarketConfig[] }) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return markets;
    return markets.filter((m) => m.symbol.includes(q) || m.baseAsset.includes(q));
  }, [markets, query]);

  return (
    <>
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
        <div className="hidden grid-cols-[1.5fr_.9fr_.7fr_.9fr_.9fr_.6fr_.7fr] border-b border-[#2A2A31] px-4 py-3 text-[11px] uppercase tracking-[.08em] text-[#737373] md:grid">
          <div>Market</div>
          <div>Price</div>
          <div>24h</div>
          <div>24h Volume</div>
          <div>Open Interest</div>
          <div>Leverage</div>
          <div className="text-right">Action</div>
        </div>

        {visible.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-[#737373]">
            No markets match “{query}”
          </div>
        ) : (
          // useQuery has no data on the server render or the first client
          // paint, so every live cell renders "—" in both — no hydration gate
          // needed.
          visible.map((market) => <MarketRow key={market.symbol} market={market} />)
        )}
      </div>

      <p className="flex items-center gap-1.5 text-[12px] text-[#737373]">
        <UsdcLogo size={13} /> All markets are settled in USDC.
      </p>
    </>
  );
}
