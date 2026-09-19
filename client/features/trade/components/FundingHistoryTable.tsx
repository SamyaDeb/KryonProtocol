"use client";

import { MarketCell } from "@/components/common/MarketCell";
import { useFunding } from "@/features/account/queries";
import { useNetwork } from "@/features/network/NetworkContext";
import { useWallet } from "@/features/wallet/useWallet";
import { formatUsd } from "@/lib/format";
import { explorerTxUrl } from "@/lib/network";

/** Funding settled on the account's positions: positive received, negative paid. */
export function FundingHistoryTable({ marketFilter }: { marketFilter: number | "all" }) {
  const { address, connected } = useWallet();
  const { network } = useNetwork();
  const { data: payments = [], isError } = useFunding(address);

  if (!connected || !address) return <Empty text="Connect a wallet to view funding history" />;
  if (isError && payments.length === 0) return <Empty text="Funding history is unavailable right now; retrying." />;

  const rows = payments.filter((p) => marketFilter === "all" || p.marketId === marketFilter);
  if (rows.length === 0) return <Empty text="No funding payments yet" />;

  const cols = ["Time", "Market", "Payment", "Tx"];

  return (
    <div className="overflow-x-auto no-scrollbar">
      <table className="w-full min-w-[460px] text-[12px] tabular">
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
          {rows.map((p) => (
            <tr key={`${p.txHash}-${p.marketId}`} className="border-t border-[#2A2A31] hover:bg-white/[0.02] transition-colors">
              <td className="pl-4 pr-2 py-[10px] text-left text-[#a3a3a3]">
                {new Date(p.createdAt).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </td>
              <td className="px-3 py-[10px] text-left">
                <MarketCell marketId={p.marketId} size={15} className="font-semibold text-[#f5f5f5]" />
              </td>
              <td className="px-3 py-[10px] text-right font-medium font-mono">
                <span className={p.amount >= 0n ? "text-[#1fae5b]" : "text-[#e34c4c]"}>
                  {formatUsd(p.amount, { dp: 4, sign: "always" })}
                </span>
              </td>
              <td className="pr-4 pl-2 py-[10px] text-right">
                {p.txHash ? (
                  <a
                    href={explorerTxUrl(network, p.txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[#a3a3a3] underline decoration-dotted underline-offset-4 hover:text-[#f5f5f5]"
                  >
                    {p.txHash.slice(0, 10)}…
                  </a>
                ) : (
                  <span className="text-[#737373]">—</span>
                )}
              </td>
            </tr>
          ))}
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
