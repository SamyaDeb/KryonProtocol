"use client";

import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { TopNav } from "@/components/common/TopNav";
import { shortenAddress } from "@/lib/format";
import { apiFetch } from "@/lib/api";

const CaretIcon = () => (
  <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 4.5 L6 7.5 L9 4.5" />
  </svg>
);

type Period = "DAY" | "WEEK" | "MONTH" | "ALL";
const PERIOD_LABEL: Record<Period, string> = { DAY: "24H", WEEK: "7D", MONTH: "30D", ALL: "All" };

interface Trader {
  rank: number;
  address: string;
  pnl: number;
  volume: number;
  roi: number;
  winRate: number;
  tradeCount: number;
  liquidations: number;
  accountValue: number;
}
interface LeaderboardResp {
  period: Period;
  metric: string;
  total: number;
  traders: Trader[];
}

const fmtUsd = (v: number) =>
  (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 });

function RankBadge({ rank }: { rank: number }) {
  const icon = rank === 1 ? "🏆" : rank === 2 ? "🥈" : "🥉";
  const label = rank === 1 ? "Rank 1" : rank === 2 ? "Rank 2" : rank === 3 ? "Rank 3" : `Rank ${rank}`;

  return (
    <span className="inline-flex items-center text-[16px] leading-none" title={label} aria-label={label}>
      {icon}
    </span>
  );
}

export default function LeaderboardPage() {
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<Period>("MONTH");
  const [page, setPage] = useState(0);
  const [periodOpen, setPeriodOpen] = useState(false);
  const pageSize = 10;

  const { data, isLoading, isError } = useQuery<LeaderboardResp>({
    queryKey: ["leaderboard", period, page, search],
    queryFn: async () => {
      const params = new URLSearchParams({
        period,
        metric: "pnl",
        limit: String(pageSize),
        offset: String(page * pageSize),
      });
      if (search.trim()) params.set("search", search.trim());
      const res = await apiFetch(`/api/leaderboard?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });

  const traders = data?.traders ?? [];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);
  const label = PERIOD_LABEL[period];
  const COLS = ["Rank", "Trader", "Account Value", `PNL (${label})`, `ROI (${label})`, `Volume (${label})`];

  return (
    <div className="min-h-screen bg-[#19191A] text-[#f5f5f5]" style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}>
      <TopNav />
      <main className="px-4 py-5 sm:px-6 sm:py-6 max-w-[1200px] mx-auto">
        <h1 className="text-[26px] sm:text-[34px] font-bold tracking-tight mb-5">Leaderboard</h1>

        <div className="rounded-xl border border-[#2A2A31] bg-[#212128] overflow-hidden">
          {/* Controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-[#2A2A31]">
            <div className="relative flex-1 min-w-[180px] max-w-[520px]">
              <svg
                width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[#737373]"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                placeholder="Search by wallet address…"
                className="w-full rounded-[8px] border border-[#2A2A31] bg-[#19191A] pl-9 pr-3 py-[10px] text-[13px] text-[#f5f5f5] placeholder:text-[#737373] outline-none focus:border-[#475569]"
              />
            </div>
            <div className="relative shrink-0">
              <button
                onClick={() => setPeriodOpen((o) => !o)}
                className="flex items-center gap-2 rounded-[8px] border border-[#2A2A31] bg-[#19191A] px-3 py-[10px] text-[12.5px] text-[#f5f5f5] hover:border-[#475569] transition-colors"
              >
                {label} <CaretIcon />
              </button>
              {periodOpen && (
                <div className="absolute right-0 mt-1 z-10 rounded-[8px] border border-[#2A2A31] bg-[#212128] overflow-hidden">
                  {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => { setPeriod(p); setPage(0); setPeriodOpen(false); }}
                      className={`block w-full text-left px-4 py-2 text-[12.5px] hover:bg-[#19191A] ${p === period ? "bg-[#19191A] text-[#f5f5f5]" : "text-[#f5f5f5]"}`}
                    >
                      {PERIOD_LABEL[p]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Header row */}
          <div className="hidden md:grid grid-cols-[60px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)] px-4 py-3 text-[12px] text-[#a3a3a3] border-b border-[#2A2A31]">
            {COLS.map((c, i) => (
              <span key={c} className={i >= 2 ? "text-right" : ""}>{c}</span>
            ))}
          </div>

          {/* Body */}
          {isLoading ? (
            <div className="flex flex-col gap-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-9 rounded bg-[#19191A] animate-pulse" />
              ))}
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-[13px] text-[#e34c4c]">
              Failed to load leaderboard. Retrying…
            </div>
          ) : traders.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-[13px] text-[#737373]">
              <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 19V5M10 19V9M16 19v-6M22 19V3" />
              </svg>
              <span className="text-[#a3a3a3]">No traders match this filter yet.</span>
              <span className="text-[12px] text-[#737373]">Trade activity feeds the board as fills settle.</span>
            </div>
          ) : (
            traders.map((t) => {
              const pnlColor = t.pnl >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]";
              const roiColor = t.roi >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]";
              const pnlText = `${t.pnl >= 0 ? "+" : ""}${fmtUsd(t.pnl)}`;
              const roiText = `${(t.roi * 100).toFixed(2)}%`;
              return (
                <div key={t.address} className="border-b border-[#2A2A31]">
                  {/* Desktop row */}
                  <div className="hidden md:grid grid-cols-[60px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)] px-4 py-[14px] text-[13px] hover:bg-white/[0.02] transition-colors items-center">
                    <span>
                      <RankBadge rank={t.rank} />
                    </span>
                    <span className="font-mono text-[#f5f5f5]">{shortenAddress(t.address)}</span>
                    <span className="text-right text-[#f5f5f5]">{fmtUsd(t.accountValue)}</span>
                    <span className={`text-right font-semibold ${pnlColor}`}>{pnlText}</span>
                    <span className={`text-right ${roiColor}`}>{roiText}</span>
                    <span className="text-right text-[#f5f5f5]">{fmtUsd(t.volume)}</span>
                  </div>

                  {/* Mobile card */}
                  <div className="md:hidden p-4 hover:bg-white/[0.02] transition-colors">
                    <div className="flex items-center gap-2 mb-3">
                      <RankBadge rank={t.rank} />
                      <span className="font-mono text-[13px] text-[#f5f5f5]">{shortenAddress(t.address)}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
                      <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-[#a3a3a3]">Account Value</span>
                        <span className="text-[#f5f5f5]">{fmtUsd(t.accountValue)}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-[#a3a3a3]">PNL ({label})</span>
                        <span className={`font-semibold ${pnlColor}`}>{pnlText}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-[#a3a3a3]">ROI ({label})</span>
                        <span className={roiColor}>{roiText}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-[#a3a3a3]">Volume ({label})</span>
                        <span className="text-[#f5f5f5]">{fmtUsd(t.volume)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {/* Pagination */}
          <div className="flex items-center justify-end gap-4 px-4 py-3 border-t border-[#2A2A31] text-[12.5px] text-[#a3a3a3]">
            <span className="tabular">{from}–{to} of {total}</span>
            <div className="flex items-center gap-1">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="w-7 h-7 grid place-items-center rounded-[6px] disabled:text-[#525252] text-[#f5f5f5] hover:bg-[#19191A] disabled:hover:bg-transparent"
              >
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <button
                disabled={to >= total}
                onClick={() => setPage((p) => p + 1)}
                className="w-7 h-7 grid place-items-center rounded-[6px] disabled:text-[#525252] text-[#f5f5f5] hover:bg-[#19191A] disabled:hover:bg-transparent"
              >
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
