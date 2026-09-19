"use client";

import { MarketCell } from "@/components/common/MarketCell";
import { useFills, type AccountFill } from "@/features/account/queries";
import { useMarkets } from "@/features/markets/directory";
import { useNetwork } from "@/features/network/NetworkContext";
import { useWallet } from "@/features/wallet/useWallet";
import { formatPrice, formatSize, formatUsd } from "@/lib/format";
import { displayFor } from "@/lib/markets";
import { explorerTxUrl } from "@/lib/network";

/**
 * The account's fills. SETTLED ones are final and link to their transaction.
 * PENDING ones are matched but not yet on chain, so the gateway may still
 * reject them; they are labelled and never counted as trades. REJECTED ones
 * show the contract's reason.
 */
export function TradeHistoryTable({ marketFilter }: { marketFilter: number | "all" }) {
  const { address, connected } = useWallet();
  const { data: fills = [], isError } = useFills(address);

  if (!connected || !address) return <Empty text="Connect a wallet to view trade history" />;
  if (isError && fills.length === 0) return <Empty text="Trade history is unavailable right now; retrying." />;

  const rows = fills.filter((f) => marketFilter === "all" || f.marketId === marketFilter);
  if (rows.length === 0) return <Empty text="No trades yet" />;

  const cols = ["Time", "Market", "Side", "Role", "Size", "Price", "Fee", "Status"];

  return (
    <div className="overflow-x-auto no-scrollbar">
      <table className="w-full min-w-[640px] text-[12px] tabular">
        <thead>
          <tr className="text-[10px] text-[#737373] font-semibold uppercase tracking-wider">
            {cols.map((h, i) => (
              <th
                key={h}
                className={`py-[9px] whitespace-nowrap ${
                  i === 0 ? "pl-4 pr-2 text-left" : i === 1 ? "px-3 text-left" : i === cols.length - 1 ? "pr-4 pl-2 text-right" : "px-3 text-right"
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <FillRow key={f.id} fill={f} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FillRow({ fill: f }: { fill: AccountFill }) {
  const { byId } = useMarkets();
  const { network } = useNetwork();
  const precision = byId[f.marketId] ?? displayFor(`#${f.marketId}`);
  const muted = f.status !== "SETTLED";

  return (
    <tr className={`border-t border-[#2A2A31] hover:bg-white/[0.02] transition-colors ${muted ? "opacity-70" : ""}`}>
      <td className="pl-4 pr-2 py-[10px] text-left text-[#a3a3a3]">
        {new Date(f.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </td>
      <td className="px-3 py-[10px] text-left">
        <MarketCell marketId={f.marketId} size={15} className="font-semibold text-[#f5f5f5]" />
      </td>
      <td className={`px-3 py-[10px] text-right font-medium ${f.side === "buy" ? "text-[#1fae5b]" : "text-[#e34c4c]"}`}>
        {f.side === "buy" ? "Buy" : "Sell"}
      </td>
      <td className="px-3 py-[10px] text-right text-[#a3a3a3]">{f.isMaker ? "Maker" : "Taker"}</td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">{formatSize(precision, f.size)}</td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">{formatPrice(precision, f.price)}</td>
      <td className="px-3 py-[10px] text-right text-[#a3a3a3]" title={f.fee < 0n ? "Rebate" : undefined}>
        {formatUsd(f.fee, { dp: 4 })}
      </td>
      <td className="pr-4 pl-2 py-[10px] text-right">
        {f.status === "SETTLED" && f.txHash ? (
          <a
            href={explorerTxUrl(network, f.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[#a3a3a3] underline decoration-dotted underline-offset-4 hover:text-[#f5f5f5]"
          >
            {f.txHash.slice(0, 10)}…
          </a>
        ) : f.status === "PENDING" ? (
          <span className="text-[#fbbf24]" title="Matched and submitted; not final until it settles on chain">
            Pending
          </span>
        ) : (
          <span className="text-[#e34c4c]" title={f.rejectReason ?? undefined}>
            Rejected{f.rejectReason ? `: ${f.rejectReason}` : ""}
          </span>
        )}
      </td>
    </tr>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-[#a3a3a3]">
      <span className="text-[13px] text-[#a3a3a3]">{text}</span>
    </div>
  );
}
