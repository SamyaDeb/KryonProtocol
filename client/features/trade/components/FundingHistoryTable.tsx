"use client";

import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "@/stores/wallet";
import { STELLAR_EXPERT_URL } from "@/config";
import { MarketCell } from "@/components/common/MarketCell";
import { apiFetch } from "@/lib/api";

interface FundingPayment {
  marketId: number;
  amount: number;
  txHash: string;
  createdAt: number;
}

export function FundingHistoryTable({ marketFilter }: { marketFilter: number | "all" }) {
  const { address, connected } = useWalletStore();

  const { data: payments = [] } = useQuery<FundingPayment[]>({
    queryKey: ["funding", address],
    queryFn: async () => {
      const res = await apiFetch(`/api/funding?address=${address}&limit=50`, { cache: "no-store" });
      if (!res.ok) return [];
      return (await res.json()) as FundingPayment[];
    },
    enabled: !!address && connected,
    refetchInterval: 15_000,
  });

  if (!connected || !address) return <Empty text="Connect a wallet to view funding history" />;

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
        {rows.map((p) => {
          const positive = p.amount >= 0;
          const onChain = p.txHash && !p.txHash.startsWith("0x000");
          return (
            <tr key={`${p.marketId}-${p.createdAt}`} className="border-t border-[#2A2A31] hover:bg-white/[0.02] transition-colors">
              <td className="pl-4 pr-2 py-[10px] text-left text-[#a3a3a3]">
                {new Date(p.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </td>
              <td className="px-3 py-[10px] text-left">
                <MarketCell marketId={p.marketId} size={15} className="font-semibold text-[#f5f5f5]" />
              </td>
              <td className="px-3 py-[10px] text-right font-medium font-mono">
                <span className={positive ? "text-[#1fae5b]" : "text-[#e34c4c]"}>
                  {positive ? "+" : ""}{p.amount.toFixed(4)} USDC
                </span>
              </td>
              <td className="pr-4 pl-2 py-[10px] text-right">
                {onChain ? (
                  <a
                    href={`${STELLAR_EXPERT_URL}/tx/${p.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[#a3a3a3] underline decoration-dotted underline-offset-4 hover:text-[#f5f5f5]"
                  >
                    {p.txHash.slice(0, 8)}…
                  </a>
                ) : (
                  <span className="text-[#737373]">—</span>
                )}
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
