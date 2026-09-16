"use client";

import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "@/stores/wallet";
import { getAccountHealth } from "@/lib/stellar/contracts";
import { SETTLEMENT_ASSET } from "@/config";
import { amountToHuman } from "@/lib/format";
import { DepositWithdrawDialog } from "./DepositWithdrawDialog";
import { useCollateral } from "@/features/collateral/useCollateral";
import { AssetLogo } from "@/components/common/AssetLogos";
import type { ReactNode } from "react";

export function AccountBar() {
  const { address, connected } = useWalletStore();

  const { data: collateral } = useCollateral(connected ? address : null);

  const { data: health } = useQuery({
    queryKey: ["health", address],
    queryFn: () => getAccountHealth(address!, SETTLEMENT_ASSET.contract),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  if (!connected || !address) return null;

  // Deposited is the MARGIN value of every collateral asset — oracle value after
  // each asset's haircut — because that is the number the vault's health
  // calculation uses. Showing the raw sum would overstate borrowing power for
  // anyone holding a haircut asset.
  const deposited = collateral?.reduce((acc, p) => acc + p.marginValue, 0);
  const held = (collateral ?? []).filter((p) => p.raw !== 0n);

  // Free collateral = deposited − margin locked by open positions ± unrealized
  // PnL. Falls back to the deposited total before any position exists.
  const available =
    health?.freeCollateral !== undefined ? amountToHuman(health.freeCollateral) : deposited;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-[11px] border-b border-[#334155]">
      <div className="flex items-center gap-5">
        <Stat
          label="Deposited"
          value={deposited !== undefined ? `$${deposited.toFixed(2)}` : "—"}
          icon={
            // Stack the marks of what is actually posted, so a multi-collateral
            // account reads as one at a glance.
            <span className="flex items-center -space-x-1">
              {(held.length > 0 ? held : [{ code: SETTLEMENT_ASSET.code }]).map((p) => (
                <AssetLogo key={p.code} symbol={p.code} size={12} />
              ))}
            </span>
          }
        />
        <Stat
          label="Available"
          value={available !== undefined ? `$${available.toFixed(2)}` : "—"}
        />
        <Stat
          label="Used Margin"
          value={health ? `$${amountToHuman(health.usedMargin).toFixed(2)}` : "—"}
        />
      </div>
      <DepositWithdrawDialog />
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass,
  icon,
}: {
  label: string;
  value: string;
  valueClass?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="text-[10px] text-[#a3a3a3] uppercase tracking-wider">{label}</span>
      <span className={`flex items-center gap-[4px] tabular text-xs font-semibold ${valueClass ?? "text-[#f5f5f5]"}`}>
        {icon}
        {value}
      </span>
    </div>
  );
}
