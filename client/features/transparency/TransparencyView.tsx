"use client";

import { useQuery } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";

import { Card, Stat } from "@/components/common/PageShell";
import { useProtocolConfig } from "@/features/account/chain";
import { useNetwork } from "@/features/network/NetworkContext";
import { apiFetch } from "@/lib/api";
import { insuranceAbi, vaultAbi } from "@/lib/chain/contracts";
import { formatUsd, formatUsdc, shortenAddress } from "@/lib/format";
import { arcNetwork, explorerAddressUrl, explorerTxUrl } from "@/lib/network";
import type { PublicContracts } from "@/lib/public-config";

const CONTRACT_LABELS: Record<keyof PublicContracts, string> = {
  vault: "Vault (collateral)",
  engine: "Engine (positions, margin, funding)",
  order_gateway: "Order Gateway (signed orders, settlement)",
  fee_router: "Fee Router",
  insurance: "Insurance Fund",
  oracle_adapter: "Oracle Adapter",
  liquidation: "Liquidation",
  risk_params: "Risk Parameters",
  timelock: "Timelock (governance)",
  usdc: "USDC",
  permit2: "Permit2",
  multicall3: "Multicall3",
};

interface Operation {
  operation_id: string;
  status: "SCHEDULED" | "EXECUTED" | "CANCELLED";
  ready: boolean;
  ready_at: number;
  delay_seconds: number;
  calls: { target: string; value: string; data: string }[];
  description: string | null;
  scheduled_tx: string;
  executed_tx: string | null;
  cancelled_tx: string | null;
  created_at: number;
}

export function TransparencyView() {
  const { network } = useNetwork();
  const chainId = arcNetwork(network).chainId;
  const { data: cfg, isError: cfgError } = useProtocolConfig();
  const c = cfg?.contracts;

  const reads = useReadContracts({
    allowFailure: true,
    contracts: c
      ? ([
          { chainId, address: c.vault, abi: vaultAbi, functionName: "solvency" },
          { chainId, address: c.vault, abi: vaultAbi, functionName: "depositCaps" },
          { chainId, address: c.vault, abi: vaultAbi, functionName: "totalDeposited" },
          { chainId, address: c.insurance, abi: insuranceAbi, functionName: "effectiveBalance" },
          { chainId, address: c.insurance, abi: insuranceAbi, functionName: "unfundedShortfall" },
        ] as const)
      : [],
    query: { enabled: !!c, refetchInterval: 15_000 },
  });

  const { data: gov, isError: govError } = useQuery({
    queryKey: ["governance", network],
    queryFn: async () => {
      const res = await apiFetch("/api/governance?limit=50", { cache: "no-store" }, network);
      if (!res.ok) throw new Error(`governance ${res.status}`);
      return ((await res.json()) as { operations: Operation[] }).operations;
    },
    refetchInterval: 30_000,
  });

  const ok = <T,>(i: number): T | undefined => (reads.data?.[i]?.status === "success" ? (reads.data[i].result as T) : undefined);
  const solvency = ok<readonly [bigint, bigint]>(0);
  const caps = ok<readonly [bigint, bigint]>(1);
  const totalDeposited = ok<bigint>(2);
  const insurance = ok<bigint>(3);
  const shortfall = ok<bigint>(4);
  const surplus = solvency ? solvency[0] - solvency[1] : undefined;

  const nameOf = (address: string) => {
    if (!c) return shortenAddress(address);
    const hit = (Object.keys(c) as (keyof PublicContracts)[]).find((k) => c[k].toLowerCase() === address.toLowerCase());
    return hit ? CONTRACT_LABELS[hit] : shortenAddress(address);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title="Vault solvency (assets ≥ liabilities)">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Assets held" value={solvency ? formatUsd(solvency[0], { rounding: "down" }) : "—"} hint="USDC the vault holds" />
            <Stat
              label="Owed to accounts"
              value={solvency ? formatUsd(solvency[1], { rounding: "up" }) : "—"}
              hint="Every ledger balance, net of the cost basis of open positions"
            />
          </div>
          <p className={`mt-3 text-[12.5px] ${surplus === undefined ? "text-[#737373]" : surplus >= 0n ? "text-[#1fae5b]" : "text-[#ff4d5f]"}`}>
            {surplus === undefined
              ? "Reading Vault.solvency() from the chain…"
              : surplus >= 0n
                ? surplus === 0n
                  ? "Holds: assets equal liabilities exactly."
                  : `Holds: assets exceed liabilities by ${formatUsd(surplus, { rounding: "down" })} (USDC sent to the vault directly).`
                : `Broken by ${formatUsd(-surplus, { rounding: "up" })}. The contracts keep assets ≥ liabilities by construction; the monitor pages on this.`}
          </p>
        </Card>
        <Card title="Caps and insurance">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Deposited" value={totalDeposited !== undefined ? formatUsdc(totalDeposited, { rounding: "down" }) : "—"} />
            <Stat
              label="Deposit cap"
              value={caps ? (caps[0] === 0n ? "Closed" : formatUsdc(caps[0])) : "—"}
              hint="Venue-wide cap; raised only through the timelock"
            />
            <Stat label="Per-account cap" value={caps ? formatUsdc(caps[1]) : "—"} />
            <Stat label="Insurance fund" value={insurance !== undefined ? formatUsd(insurance, { rounding: "down" }) : "—"} />
          </div>
          {shortfall !== undefined && shortfall > 0n && (
            <p className="mt-3 text-[12.5px] text-[#ff9b9b]">Unfunded shortfall: {formatUsd(shortfall, { rounding: "up" })} (resolved by ADL).</p>
          )}
        </Card>
      </div>

      <Card title="Contracts">
        {cfgError ? (
          <p className="text-[13px] text-[#ff9b9b]">The network config is unavailable right now.</p>
        ) : !c ? (
          <p className="text-[13px] text-[#737373]">Loading…</p>
        ) : (
          <ul className="divide-y divide-[#2A2A31]">
            {(Object.keys(CONTRACT_LABELS) as (keyof PublicContracts)[]).map((k) => (
              <li key={k} className="flex flex-col gap-1 py-2 text-[13px] sm:flex-row sm:items-center sm:justify-between">
                <span className="text-[#a3a3a3]">{CONTRACT_LABELS[k]}</span>
                <a
                  href={explorerAddressUrl(network, c[k])}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all font-mono text-[12px] text-[#f5f5f5] underline decoration-dotted underline-offset-4"
                >
                  {c[k]}
                </a>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[12px] text-[#737373]">
          Chain {cfg?.chain_id ?? "—"}. Upgradeable contracts are UUPS proxies owned by the timelock.
        </p>
      </Card>

      <Card title="Timelock queue">
        {govError ? (
          <p className="text-[13px] text-[#ff9b9b]">The governance index is unavailable right now.</p>
        ) : !gov ? (
          <p className="text-[13px] text-[#737373]">Loading…</p>
        ) : gov.length === 0 ? (
          <p className="text-[13px] text-[#737373]">No governance operations have been scheduled on this network.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[12px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-[#737373]">
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Targets</th>
                  <th className="py-2 pr-3">Executable from</th>
                  <th className="py-2">Transactions</th>
                </tr>
              </thead>
              <tbody>
                {gov.map((o) => (
                  <tr key={o.operation_id} className="border-t border-[#2A2A31] align-top">
                    <td className="py-2 pr-3">
                      <span
                        className={
                          o.status === "EXECUTED" ? "text-[#a3a3a3]" : o.status === "CANCELLED" ? "text-[#737373]" : o.ready ? "text-[#fbbf24]" : "text-[#f5f5f5]"
                        }
                      >
                        {o.status === "SCHEDULED" ? (o.ready ? "Ready to execute" : "Waiting") : o.status === "EXECUTED" ? "Executed" : "Cancelled"}
                      </span>
                      {o.description && <div className="mt-1 text-[11.5px] text-[#a3a3a3]">{o.description}</div>}
                    </td>
                    <td className="py-2 pr-3 text-[#f5f5f5]">
                      {o.calls.map((call, i) => (
                        <div key={i}>
                          {nameOf(call.target)} <span className="font-mono text-[#737373]">{call.data.slice(0, 10)}</span>
                        </div>
                      ))}
                    </td>
                    <td className="py-2 pr-3 text-[#a3a3a3]">{new Date(o.ready_at).toLocaleString()}</td>
                    <td className="py-2">
                      {[
                        ["scheduled", o.scheduled_tx],
                        ["executed", o.executed_tx],
                        ["cancelled", o.cancelled_tx],
                      ]
                        .filter(([, tx]) => tx)
                        .map(([label, tx]) => (
                          <a
                            key={label}
                            href={explorerTxUrl(network, tx!)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mr-2 font-mono text-[#a3a3a3] underline decoration-dotted underline-offset-4"
                          >
                            {label}
                          </a>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Audit status">
        <p className="text-[13px] leading-6 text-[#a3a3a3]">
          The contracts are frozen for review as <span className="font-mono text-[#f5f5f5]">audit-v1</span>. An external
          audit has not been completed yet. Until it is, treat every deployment, testnet included, as unaudited software.
        </p>
      </Card>
    </div>
  );
}
