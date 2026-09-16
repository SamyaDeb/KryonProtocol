"use client";

import { useLocalOrders } from "@/stores/orders";
import { useWalletStore } from "@/stores/wallet";
import { priceFor, sizeFor } from "@/lib/format";
import { MarketCell } from "@/components/common/MarketCell";

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  filled: "bg-[rgba(31,174,91,0.12)] text-[#1fae5b] border-[#1fae5b]/20",
  cancelled: "bg-[#2a2a30] text-[#a3a3a3] border-[#334155]",
};

export function OrderHistoryTable({
  marketFilter,
  sideFilter,
}: {
  marketFilter: number | "all";
  sideFilter: "both" | "long" | "short";
}) {
  const orders = useLocalOrders((s) => s.orders);
  const { address, connected } = useWalletStore();
  if (!connected || !address) return <Empty text="Connect a wallet to view order history" />;

  const rows = orders.filter(
    (o) =>
      o.owner === address &&
      (marketFilter === "all" || o.marketId === marketFilter) &&
      (sideFilter === "both" || (sideFilter === "long") === o.isLong)
  );

  if (rows.length === 0) return <Empty text="No order history yet" />;

  const cols = ["Time", "Market", "Type", "Side", "Size", "Price", "Status"];

  return (
    <div className="overflow-x-auto no-scrollbar">
    <table className="w-full min-w-[560px] text-[12px] tabular">
      <thead>
        <tr className="text-[10px] text-[#737373] font-semibold uppercase tracking-wider">
          {cols.map((h, i) => (
            <th key={h} className={`py-[9px] whitespace-nowrap ${i === 0 ? "pl-4 pr-2 text-left" : i === 1 ? "px-3 text-left" : "px-3 text-right"}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => {
          const isMarket = o.limitPrice === 0n;
          const sideBadge = o.isLong
            ? "bg-[rgba(31,174,91,0.12)] text-[#1fae5b]"
            : "bg-[rgba(227,76,76,0.12)] text-[#e34c4c]";
          return (
            <tr key={String(o.nonce)} className="border-t border-[#2A2A31] hover:bg-white/[0.02] transition-colors">
              <td className="pl-4 pr-2 py-[10px] text-left text-[#a3a3a3]">
                {new Date(Number(o.nonce)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </td>
              <td className="px-3 py-[10px] text-left">
                <MarketCell marketId={o.marketId} size={15} className="font-semibold text-[#f5f5f5]" />
              </td>
              <td className="px-3 py-[10px] text-right text-[#a3a3a3]">{isMarket ? "Market" : "Limit"}</td>
              <td className="px-3 py-[10px] text-right">
                <span className={`rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${sideBadge}`}>
                  {o.isLong ? "LONG" : "SHORT"}
                </span>
              </td>
              <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">{sizeFor(o.marketId, o.size)}</td>
              <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">
                {isMarket ? "Market" : priceFor(o.marketId, o.limitPrice)}
              </td>
              <td className="px-3 py-[10px] text-right">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium border capitalize ${STATUS_STYLE[o.status] ?? STATUS_STYLE.cancelled}`}>
                  {o.status}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-[#a3a3a3]">
      <span className="text-[13px] text-[#a3a3a3]">{text}</span>
    </div>
  );
}
