"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TopNav } from "@/components/common/TopNav";
import { useWallet } from "@/features/wallet/useWallet";
import { useAccountRates, useAccountState, useOwnFillStream } from "@/features/account/chain";
import { useMarkets } from "@/features/markets/directory";
import { formatRatePercent, formatUsd, formatUsdc, toChartNumber } from "@/lib/format";
import { DepositWithdrawDialog } from "@/features/trade/components/DepositWithdrawDialog";
import { PositionsTable } from "@/features/trade/components/PositionsTable";
import { OpenOrdersTable } from "@/features/trade/components/OpenOrdersTable";
import { OrderHistoryTable } from "@/features/trade/components/OrderHistoryTable";
import { TradeHistoryTable } from "@/features/trade/components/TradeHistoryTable";
import { FundingHistoryTable } from "@/features/trade/components/FundingHistoryTable";
import { AssetLogo } from "@/components/common/AssetLogos";
import { apiFetch } from "@/lib/api";

const TABS = [
  "Balances", "Positions", "Open Orders", "Trade History", "Order History", "Funding History",
] as const;
type Tab = (typeof TABS)[number];

const usd = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const shortDate = (value: string) =>
  new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export default function PortfolioPage() {
  const { address, connected } = useWallet();
  const [tab, setTab] = useState<Tab>("Positions");
  const account = useAccountState(address);
  const acct = account.data;
  const { data: rates } = useAccountRates(address);
  const { list: markets } = useMarkets();
  useOwnFillStream(address, account.queryKey);

  // Historical analytics (realized pnl, volume, deposits, win rate) from indexer.
  const { data: portfolio } = useQuery({
    queryKey: ["portfolio-analytics", address],
    queryFn: async () => {
      const res = await apiFetch(`/api/portfolio/${address}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{
        analytics: {
          realizedPnl: number; volume: number; tradeCount: number; winRate: number;
          totalDeposited: number; totalWithdrawn: number; totalFundingPaid: number;
          totalFeesPaid: number; liquidationCount: number;
        } | null;
        equityCurve: Array<{ equity: number; unrealizedPnl: number; realizedPnlCum: number; at: string }>;
        pnlHistory: Array<{ kind: string; amount: number; size: number; price: number; marketId: number; at: string }>;
        balanceHistory: Array<{ kind: string; asset: string; amount: number; balanceAfter: number | null; at: string }>;
        fundingHistory: Array<{ marketId: number; amount: number; at: string }>;
      }>;
    },
    enabled: !!address && connected,
    refetchInterval: 15_000,
  });

  // Live figures from the engine; history from the analytics tables.
  const equity = acct ? toChartNumber(acct.equity, 18) : 0;
  const unrealizedPnl = acct ? toChartNumber(acct.unrealizedPnl, 18) : 0;
  // The account's rates on the first active market (tiers apply venue-wide).
  const feeMarket = markets.find((m) => m.active) ?? markets[0];
  const feeRates = feeMarket ? rates?.[feeMarket.marketId] ?? { makerRate: feeMarket.makerRate, takerRate: feeMarket.takerRate } : null;
  const a = portfolio?.analytics;
  const realizedPnl = a?.realizedPnl ?? 0;
  const pnl = realizedPnl + unrealizedPnl;
  const volume = a?.volume ?? 0;
  const winRate = a?.winRate ?? 0;
  const equityCurve = portfolio?.equityCurve ?? [];
  const pnlEvents = [...(portfolio?.pnlHistory ?? [])].reverse();
  const pnlCurve = pnlEvents.reduce<Array<{ value: number; label: string }>>((acc, ev) => {
    const prev = acc.at(-1)?.value ?? 0;
    acc.push({ value: prev + ev.amount, label: shortDate(ev.at) });
    return acc;
  }, []);

  const performanceStats: [string, string, string?][] = [
    ["PNL (Realized + Unrealized)", usd(pnl), pnl >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]"],
    ["Realized PNL", usd(realizedPnl), realizedPnl >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]"],
    ["Unrealized PNL", usd(unrealizedPnl), unrealizedPnl >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]"],
    ["Volume", usd(volume)],
    ["Win Rate", `${(winRate * 100).toFixed(1)}%`],
    ["Total Equity", usd(equity)],
    ["Fees Paid", usd(a?.totalFeesPaid ?? 0)],
    ["Net Funding", usd(a?.totalFundingPaid ?? 0)],
  ];
  const chartSeries = equityCurve.length > 1
    ? equityCurve.map((p) => ({ value: p.equity, label: shortDate(p.at) }))
    : pnlCurve;
  const chartTitle = equityCurve.length > 1 ? "Account Value" : "PNL";

  const actionPill = "px-4 py-[9px] rounded-[8px] text-[13px] border border-[#2A2A31] bg-[#212128] text-[#a3a3a3] hover:text-[#f5f5f5] hover:border-[#475569] transition-colors whitespace-nowrap";

  return (
    <div className="min-h-screen bg-[#19191A] text-[#f5f5f5]" style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}>
      <TopNav />
      <main className="mx-auto max-w-[1200px] px-4 py-5 sm:px-6 sm:py-6">
        {/* Header */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[26px] font-bold tracking-tight sm:text-[34px]">Portfolio</h1>
          <div className="flex flex-wrap items-center gap-2">
            <DepositWithdrawDialog triggerLabel="Withdraw" defaultTab="withdraw" triggerClassName={actionPill} />
            <DepositWithdrawDialog
              triggerLabel="Deposit"
              defaultTab="deposit"
              triggerClassName="px-4 py-[9px] rounded-[8px] text-[13px] font-semibold border border-[#2A2A31] bg-[#212128] text-[#f5f5f5] hover:border-[#475569] transition whitespace-nowrap"
            />
          </div>
        </div>

        <section className="grid grid-cols-1 gap-3 xl:grid-cols-12">
          <div className="xl:col-span-3 flex flex-col gap-3">
            <Card>
              <Label>Total Equity</Label>
              <div className="mt-2 text-[30px] font-semibold tabular">
                {acct ? formatUsd(acct.equity, { rounding: "down" }) : "—"}
              </div>
              <CollateralBreakdown acct={acct} />
            </Card>
            <Card>
              <div className="flex items-center justify-between">
                <Label>Fees (Taker / Maker)</Label>
                <span className="text-[12.5px] text-[#a3a3a3]">Perps</span>
              </div>
              <div className="mt-2 text-[28px] font-semibold tabular">
                {feeRates ? `${formatRatePercent(feeRates.takerRate)} / ${formatRatePercent(feeRates.makerRate)}` : "—"}
              </div>
              <div className="mt-3 text-[13px] text-[#a3a3a3]">Volume: {usd(volume)}</div>
            </Card>
          </div>

          <div className="xl:col-span-4">
            <Card className="h-full">
              <div className="mb-1 flex items-center justify-between border-b border-[#2A2A31] pb-3">
                <span className="text-[13px] font-medium text-[#f5f5f5]">Perps Portfolio</span>
                <span className="text-[12.5px] text-[#a3a3a3]">Live</span>
              </div>
              {performanceStats.map(([label, value, cls]) => (
                <Row key={label} label={label} value={value} valueClass={cls} />
              ))}
            </Card>
          </div>

          <div className="xl:col-span-5">
            <Card className="h-full">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-1">
                  {["Account Value", "PNL", "Perps PNL"].map((t) => (
                    <span
                      key={t}
                      className={`px-3 py-1.5 text-[13px] ${t === chartTitle ? "text-[#f5f5f5]" : "text-[#a3a3a3]"}`}
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <span className="text-[12.5px] text-[#a3a3a3]">30D</span>
              </div>
              <MiniLineChart
                data={chartSeries}
                color={chartTitle === "PNL" && chartSeries.at(-1)?.value && chartSeries.at(-1)!.value < 0 ? "#ff4d5f" : "#f5f5f5"}
                valuePrefix="$"
                emptyText="No portfolio history yet"
                compact
              />
            </Card>
          </div>
        </section>

        {/* Bottom: tabs + table */}
        <div className="mt-3 rounded-xl border border-[#2A2A31] bg-[#212128] overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#2A2A31]">
            <div className="flex overflow-x-auto" style={{ scrollbarWidth: "none" }}>
              {TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`whitespace-nowrap px-4 py-[14px] text-[13px] font-medium relative transition-colors ${
                    tab === t
                      ? "text-[#f5f5f5] after:content-[''] after:absolute after:left-[14px] after:right-[14px] after:bottom-[-1px] after:h-[2px] after:bg-[#f5f5f5] after:rounded-[2px]"
                      : "text-[#a3a3a3] hover:text-[#f5f5f5]"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-[200px]">
            {tab === "Positions" && <PositionsTable marketFilter="all" sideFilter="both" />}
            {tab === "Funding History" && <FundingHistoryTable marketFilter="all" />}
            {tab === "Open Orders" && <OpenOrdersTable marketFilter="all" sideFilter="both" />}
            {tab === "Order History" && <OrderHistoryTable marketFilter="all" />}
            {tab === "Trade History" && <TradeHistoryTable marketFilter="all" />}
            {tab === "Balances" && <BalancesTab connected={connected} acct={acct} />}
          </div>
        </div>
      </main>
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-[#2A2A31] bg-[#212128] p-5 ${className}`}>{children}</div>;
}
function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[13px] text-[#a3a3a3]">{children}</span>;
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between py-[7px] text-[13px]">
      <span className="text-[#a3a3a3]">{label}</span>
      <span className={`tabular font-medium ${valueClass ?? "text-[#f5f5f5]"}`}>{value}</span>
    </div>
  );
}

function MiniLineChart({
  data,
  color,
  valuePrefix = "",
  emptyText,
  compact = false,
}: {
  data: Array<{ value: number; label: string }>;
  color: string;
  valuePrefix?: string;
  emptyText: string;
  compact?: boolean;
}) {
  if (data.length < 2) {
    return <ChartEmpty text={emptyText} />;
  }

  const width = 640;
  const height = compact ? 170 : 190;
  const padX = 12;
  const padY = 18;
  const values = data.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = data.map((p, i) => {
    const x = padX + (i / Math.max(data.length - 1, 1)) * (width - padX * 2);
    const y = padY + ((max - p.value) / range) * (height - padY * 2);
    return { x, y, ...p };
  });
  const line = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${padX},${height - padY} ${line} ${width - padX},${height - padY}`;
  const latest = data[data.length - 1];
  const first = data[0];
  const delta = latest.value - first.value;

  return (
    <div className="pt-4">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[22px] font-semibold text-[#f5f5f5]">
            {valuePrefix}{latest.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </div>
          <div className={`mt-1 font-mono text-[12px] ${delta >= 0 ? "text-[#1fae5b]" : "text-[#ff4d5f]"}`}>
            {delta >= 0 ? "+" : ""}{valuePrefix}{delta.toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="text-right text-[11px] text-[#737373]">
          <div>{first.label}</div>
          <div>{latest.label}</div>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className={`${compact ? "h-[170px]" : "h-[190px]"} w-full overflow-visible`}>
        {[0, 1, 2, 3].map((i) => {
          const y = padY + (i / 3) * (height - padY * 2);
          return <line key={i} x1={padX} x2={width - padX} y1={y} y2={y} stroke="rgba(255,255,255,.06)" />;
        })}
        <polygon points={area} fill={color} opacity="0.08" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {points.slice(-1).map((p) => (
          <circle key={`${p.x}-${p.y}`} cx={p.x} cy={p.y} r="4" fill={color} stroke="#212128" strokeWidth="2" />
        ))}
      </svg>
    </div>
  );
}

function ChartEmpty({ text }: { text: string }) {
  return (
    <div className="flex h-[240px] items-center justify-center rounded-[8px] border border-dashed border-[#2A2A31] text-[12px] text-[#737373]">
      {text}
    </div>
  );
}

type Acct = ReturnType<typeof useAccountState>["data"];

/** What equity is made of: the vault balance plus unrealized PnL. */
function CollateralBreakdown({ acct }: { acct: Acct }) {
  if (!acct) return null;
  const rows: [string, string, boolean][] = [
    ["Vault balance", formatUsd(acct.ledger, { rounding: "down" }), acct.ledger < 0n],
    ["Unrealized PnL", formatUsd(acct.unrealizedPnl, { sign: "always" }), acct.unrealizedPnl < 0n],
    ["Margin used", formatUsd(acct.initialMarginRequired, { rounding: "up" }), false],
  ];
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      {rows.map(([label, value, negative]) => (
        <div key={label} className="flex items-center justify-between text-[13px]">
          <span className="text-[#a3a3a3]">{label}</span>
          <span className={`tabular ${negative ? "text-[#f87171]" : "text-[#f5f5f5]"}`}>{value}</span>
        </div>
      ))}
    </div>
  );
}

/** USDC is the only collateral on Arc: wallet, vault, and what can leave now. */
function BalancesTab({ connected, acct }: { connected: boolean; acct: Acct }) {
  if (!connected) return <Empty text="Connect a wallet to view balances" />;
  if (!acct) return <Empty text="Loading balances…" />;

  const cells: [string, string][] = [
    ["Wallet", formatUsdc(acct.walletUsdc, { rounding: "down" })],
    ["Vault Balance", formatUsd(acct.ledger, { rounding: "down" })],
    ["Free Collateral", formatUsd(acct.freeCollateral > 0n ? acct.freeCollateral : 0n, { rounding: "down" })],
    ["Withdrawable", formatUsdc(acct.maxWithdraw, { rounding: "down" })],
  ];
  return (
    <table className="w-full text-[12px] tabular">
      <thead>
        <tr className="text-[10px] font-semibold uppercase tracking-wider text-[#737373]">
          <th className="py-[9px] pl-4 pr-2 text-left">Coin</th>
          {cells.map(([h], i) => (
            <th key={h} className={`py-[9px] text-right ${i === cells.length - 1 ? "pl-2 pr-4" : "px-3"}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr className="border-t border-[#2A2A31]">
          <td className="py-[12px] pl-4 pr-2 text-left">
            <span className="inline-flex items-center gap-2">
              <AssetLogo symbol="USDC" size={16} />
              <span className="font-semibold text-[#f5f5f5]">USDC</span>
              <span className="rounded-full border border-[#334155] px-1.5 py-[1px] text-[9.5px] font-semibold uppercase tracking-wide text-[#a3a3a3]">
                Collateral & gas
              </span>
            </span>
          </td>
          {cells.map(([h, v], i) => (
            <td key={h} className={`py-[12px] text-right text-[#f5f5f5] ${i === cells.length - 1 ? "pl-2 pr-4" : "px-3"}`}>
              {v}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-[12px] text-[#737373]">
      <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M7 7l10 10M17 7L7 17" />
      </svg>
      <span className="underline decoration-dotted underline-offset-4">{text}</span>
    </div>
  );
}
