"use client";

import { MarketCell } from "@/components/common/MarketCell";
import { useOrderHistory, type AccountOrder } from "@/features/account/queries";
import { useMarkets } from "@/features/markets/directory";
import { useWallet } from "@/features/wallet/useWallet";
import { formatPrice, formatSize } from "@/lib/format";
import { displayFor } from "@/lib/markets";

/** Every order this account signed, in every status. */
export function OrderHistoryTable({ marketFilter }: { marketFilter: number | "all" }) {
  const { address, connected } = useWallet();
  const { data: orders = [], isError } = useOrderHistory(address);
  const { byId } = useMarkets();

  if (!connected || !address) return <Empty text="Connect a wallet to view order history" />;
  if (isError && orders.length === 0) return <Empty text="Order history is unavailable right now; retrying." />;

  const rows = orders.filter((o) => marketFilter === "all" || o.marketId === marketFilter);
  if (rows.length === 0) return <Empty text="No orders yet" />;

  const cols = ["Time", "Market", "Side", "Price", "Size", "Filled", "Status"];

  return (
    <div className="overflow-x-auto no-scrollbar">
      <table className="w-full min-w-[620px] text-[12px] tabular">
        <thead>
          <tr className="text-[10px] font-semibold uppercase tracking-wider text-[#737373]">
            {cols.map((h, i) => (
              <th
                key={h}
                className={`whitespace-nowrap py-[9px] ${i === 0 ? "pl-4 pr-2 text-left" : i === 1 ? "px-3 text-left" : i === cols.length - 1 ? "pl-2 pr-4 text-right" : "px-3 text-right"}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => {
            const p = byId[o.marketId] ?? displayFor(`#${o.marketId}`);
            return (
              <tr key={o.orderHash} className="border-t border-[#2A2A31] transition-colors hover:bg-white/[0.02]">
                <td className="py-[10px] pl-4 pr-2 text-left text-[#a3a3a3]">
                  {new Date(o.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </td>
                <td className="px-3 py-[10px] text-left">
                  <MarketCell marketId={o.marketId} size={15} className="font-semibold text-[#f5f5f5]" />
                </td>
                <td className={`px-3 py-[10px] text-right font-medium ${o.isLong ? "text-[#1fae5b]" : "text-[#e34c4c]"}`}>
                  {o.isLong ? "Buy" : "Sell"}
                  {o.reduceOnly && <span className="ml-1 text-[10px] text-[#a3a3a3]">RO</span>}
                </td>
                <td className="px-3 py-[10px] text-right text-[#f5f5f5]">{formatPrice(p, o.limitPrice)}</td>
                <td className="px-3 py-[10px] text-right text-[#f5f5f5]">{formatSize(p, o.size)}</td>
                <td className="px-3 py-[10px] text-right text-[#a3a3a3]">{formatSize(p, o.filledSize)}</td>
                <td className="py-[10px] pl-2 pr-4 text-right text-[#a3a3a3]">{statusText(o)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function statusText(o: AccountOrder): string {
  if (o.nonceInvalidated && o.status !== "FILLED") return "Cancelled on chain";
  switch (o.status) {
    case "FILLED":
      return "Filled";
    case "PARTIALLY_FILLED":
      return o.expired ? "Partly filled, expired" : "Partly filled";
    case "CANCELLED":
      return o.filledSize > 0n ? "Partly filled, cancelled" : "Cancelled";
    case "EXPIRED":
      return "Expired";
    case "OPEN":
      return o.expired ? "Expired" : o.pendingSize > 0n ? "Settling" : "Open";
    default:
      return o.status.toLowerCase();
  }
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-[#a3a3a3]">
      <span className="text-[13px]">{text}</span>
    </div>
  );
}
