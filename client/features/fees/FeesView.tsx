"use client";

import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/common/PageShell";
import { useAccountRates } from "@/features/account/chain";
import { useNetwork } from "@/features/network/NetworkContext";
import { useWallet } from "@/features/wallet/useWallet";
import { apiFetch } from "@/lib/api";
import { formatRateBps, formatRatePercent } from "@/lib/format";
import { canonicalSymbol } from "@/lib/markets";

interface Schedule {
  rebates_enabled: boolean;
  net_rate_floor: number;
  markets: { market_id: number; symbol: string; active: boolean; maker_rate: number; taker_rate: number }[];
}

export function FeesView() {
  const { network } = useNetwork();
  const { address } = useWallet();
  const { data: mine } = useAccountRates(address);
  const { data, isError } = useQuery({
    queryKey: ["fee-schedule", network],
    queryFn: async (): Promise<Schedule> => {
      const res = await apiFetch("/api/fees", { cache: "no-store" }, network);
      if (!res.ok) throw new Error(`fees ${res.status}`);
      return (await res.json()) as Schedule;
    },
    staleTime: 30_000,
  });

  if (isError) return <Card><p className="text-[13px] text-[#ff9b9b]">The fee schedule is unavailable right now.</p></Card>;
  if (!data) return <Card><p className="text-[13px] text-[#737373]">Loading…</p></Card>;

  const rate = (r: number) => (
    <span title={formatRatePercent(r)}>
      {formatRateBps(r)}
      {r < 0 && <span className="ml-1 text-[11px] text-[#1fae5b]">rebate</span>}
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card title="Schedule by market">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-[#737373]">
                <th className="py-2 pr-3">Market</th>
                <th className="py-2 pr-3 text-right">Maker</th>
                <th className="py-2 pr-3 text-right">Taker</th>
                {address && <th className="py-2 text-right">Your rates (maker / taker)</th>}
              </tr>
            </thead>
            <tbody className="font-mono">
              {data.markets.map((m) => {
                const own = mine?.[m.market_id];
                return (
                  <tr key={m.market_id} className="border-t border-[#2A2A31]">
                    <td className="py-2 pr-3 font-sans text-[#f5f5f5]">
                      {canonicalSymbol(m.symbol)}
                      {!m.active && <span className="ml-2 text-[11px] text-[#fdba74]">paused</span>}
                    </td>
                    <td className="py-2 pr-3 text-right text-[#f5f5f5]">{rate(m.maker_rate)}</td>
                    <td className="py-2 pr-3 text-right text-[#f5f5f5]">{rate(m.taker_rate)}</td>
                    {address && (
                      <td className="py-2 text-right text-[#a3a3a3]">
                        {own ? (
                          <>
                            {rate(own.makerRate)} / {rate(own.takerRate)}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="How fees are charged">
        <ul className="list-disc space-y-2 pl-5 text-[13px] leading-6 text-[#a3a3a3]">
          <li>A fee is its rate times the fill&apos;s notional (size × price), charged when the fill settles on chain. Fees owed round up, to the smallest USDC unit.</li>
          <li>
            Maker plus taker on one fill never nets below {formatRateBps(data.net_rate_floor)}: if tiers would push it lower, the
            maker side is raised to meet the floor.
          </li>
          <li>{data.rebates_enabled ? "Maker rebates are on: a negative maker rate pays you on each fill." : "Maker rebates are off on this network."}</li>
          <li>Fee tiers by 30-day volume can lower an account&apos;s rates once governance enables them. Your rates above already include any tier.</li>
          <li>Gas for settlement is paid by the venue&apos;s operator, not per order. Deposits, withdrawals and on-chain cancels are your own transactions, paid in USDC gas.</li>
        </ul>
      </Card>
    </div>
  );
}
