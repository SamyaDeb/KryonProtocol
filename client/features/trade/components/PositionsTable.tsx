"use client";

import { useState } from "react";
import { toast } from "sonner";

import { MarketCell } from "@/components/common/MarketCell";
import { useAccountRates, useAccountState } from "@/features/account/chain";
import { usePositions, type AccountPosition } from "@/features/account/queries";
import { useTrading } from "@/features/account/useTrading";
import { useMarkets, type ArcMarket } from "@/features/markets/directory";
import { useWallet } from "@/features/wallet/useWallet";
import { formatSize, formatUsd, formatUsdPrice } from "@/lib/format";
import { describeTxError } from "@/lib/market/errors";
import { evaluateTicket, TICKET_ERROR_TEXT } from "@/lib/market/order-ticket";
import { liquidationPrice, marginAt, unrealizedPnl } from "@/lib/math";
import { useMarketStore } from "@/stores/market";

/** Slippage for the one-click close: a reduce-only market order. */
const CLOSE_SLIPPAGE_BPS = 100;

/**
 * Open positions. Arc accounts are cross-margined: one signed position per
 * market, all backed by the same collateral, so a position has no margin or
 * leverage of its own. The margin shown is its maintenance requirement, and
 * its liquidation price holds every other position where it is.
 */
export function PositionsTable({
  marketFilter,
  sideFilter = "both",
}: {
  marketFilter: number | "all";
  sideFilter?: "both" | "long" | "short";
}) {
  const { address, connected } = useWallet();
  const { data: positions = [], isError } = usePositions(address);
  const { data: account } = useAccountState(address);
  const { byId } = useMarkets();
  const indexPrices = useMarketStore((s) => s.tickers);

  if (!connected || !address) return <Empty text="Connect a wallet to view open positions" />;
  if (isError && positions.length === 0) return <Empty text="Positions are unavailable right now; retrying." />;

  const rows = positions.filter(
    (p) =>
      p.size !== 0n &&
      (marketFilter === "all" || p.marketId === marketFilter) &&
      (sideFilter === "both" || (sideFilter === "long") === p.size > 0n)
  );
  if (rows.length === 0) return <Empty text="No open positions" />;

  const cols = ["Market", "Size", "Entry", "Index", "Unrealized PnL", "Maint. Margin", "Liq. Price", ""];

  return (
    <div className="overflow-x-auto no-scrollbar">
      <table className="w-full min-w-[780px] text-[12px] tabular">
        <thead>
          <tr className="text-[10px] font-semibold uppercase tracking-wider text-[#737373]">
            {cols.map((h, i) => (
              <th
                key={h || "action"}
                className={`whitespace-nowrap py-[9px] ${i === 0 ? "pl-4 pr-2 text-left" : i === cols.length - 1 ? "pl-2 pr-4 text-right" : "px-3 text-right"}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const market = byId[p.marketId];
            if (!market) return null;
            const index = indexPrices[p.marketId]?.indexPrice ?? market.indexPrice;
            return <PositionRow key={p.marketId} p={p} market={market} index={index} account={account} />;
          })}
        </tbody>
      </table>
      <p className="px-4 py-2 text-[10.5px] text-[#737373]">
        PnL and liquidation prices are estimates at the index price, excluding funding not yet settled.
      </p>
    </div>
  );
}

function PositionRow({
  p,
  market,
  index,
  account,
}: {
  p: AccountPosition;
  market: ArcMarket;
  index: bigint;
  account: ReturnType<typeof useAccountState>["data"];
}) {
  const { address, ready } = useWallet();
  const trading = useTrading(address);
  const { data: rates } = useAccountRates(address);
  const book = useMarketStore((s) => s.orderBooks[market.marketId]);
  const [closing, setClosing] = useState(false);

  const long = p.size > 0n;
  const abs = long ? p.size : -p.size;
  const pnl = index > 0n ? unrealizedPnl(p.size, p.openNotional, index) : 0n;
  const maint = marginAt(p.size, index, market.maintenanceMarginBps);
  const liq =
    account && index > 0n
      ? liquidationPrice({
          size: p.size,
          equity: account.equity,
          price: index,
          maintenanceMarginBps: market.maintenanceMarginBps,
          otherMaintenance: account.maintenanceMarginRequired > maint ? account.maintenanceMarginRequired - maint : 0n,
        })
      : null;

  async function close() {
    const r = rates?.[market.marketId] ?? { makerRate: market.makerRate, takerRate: market.takerRate };
    const ticket = evaluateTicket({
      market,
      side: long ? "sell" : "buy",
      kind: "market",
      size: abs,
      limitPrice: null,
      slippageBps: CLOSE_SLIPPAGE_BPS,
      reduceOnly: true,
      postOnly: false,
      bestBid: book?.bids[0]?.price ?? null,
      bestAsk: book?.asks[0]?.price ?? null,
      indexPrice: index,
      position: p,
      health: account ?? null,
      makerRate: r.makerRate,
      takerRate: r.takerRate,
    });
    const blocking = ticket.errors.find((e) => e !== "below_min_notional");
    if (blocking || ticket.limitPrice === null) {
      toast.error(blocking ? TICKET_ERROR_TEXT[blocking] : "No price to close against yet.");
      return;
    }
    setClosing(true);
    try {
      const res = await trading.submit({
        marketId: market.marketId,
        isLong: !long,
        size: abs,
        limitPrice: ticket.limitPrice,
        reduceOnly: true,
        ttlSeconds: 3_600n,
      });
      if (res.ok) toast.success(`Close order for ${formatSize(market, abs)} ${market.baseAsset} sent to match.`);
      else toast.error(res.message);
    } catch (e) {
      toast.error(describeTxError(e));
    } finally {
      setClosing(false);
    }
  }

  return (
    <tr className="border-t border-[#2A2A31] transition-colors hover:bg-white/[0.02]">
      <td className="py-[10px] pl-4 pr-2 text-left">
        <MarketCell marketId={p.marketId} size={15} className="font-semibold text-[#f5f5f5]" />
      </td>
      <td className={`px-3 py-[10px] text-right font-medium ${long ? "text-[#1fae5b]" : "text-[#e34c4c]"}`}>
        {long ? "Long" : "Short"} {formatSize(market, abs)}
      </td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5]">{formatUsdPrice(market, p.entryPrice)}</td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5]">{formatUsdPrice(market, index)}</td>
      <td className={`px-3 py-[10px] text-right font-medium ${pnl >= 0n ? "text-[#1fae5b]" : "text-[#e34c4c]"}`}>
        {formatUsd(pnl, { sign: "always" })}
      </td>
      <td className="px-3 py-[10px] text-right text-[#a3a3a3]">{formatUsd(maint, { rounding: "up" })}</td>
      <td className="px-3 py-[10px] text-right text-amber-400">{liq ? formatUsdPrice(market, liq) : "—"}</td>
      <td className="py-[10px] pl-2 pr-4 text-right">
        <button
          onClick={() => void close()}
          disabled={!ready || closing}
          className="rounded-[5px] border border-[#334155] px-2 py-[2px] text-[11px] font-semibold text-[#f5f5f5] transition-colors hover:border-[#475569] disabled:opacity-40"
          title="Reduce-only market order for the whole position, at most 1% past the best price"
        >
          {closing ? "Sign…" : "Close"}
        </button>
      </td>
    </tr>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-[#a3a3a3]">
      <span className="text-[13px]">{text}</span>
    </div>
  );
}
