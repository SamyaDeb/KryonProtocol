"use client";

import type { ReactNode } from "react";

import { AssetLogo } from "@/components/common/AssetLogos";
import { useAccountState } from "@/features/account/chain";
import { useWallet } from "@/features/wallet/useWallet";
import { formatUsd } from "@/lib/format";
import { DepositWithdrawDialog } from "./DepositWithdrawDialog";

/**
 * The account at a glance, from the engine's own health read: equity
 * (collateral plus unrealized PnL), what is free for new orders, and the
 * initial margin open positions hold.
 */
export function AccountBar() {
  const { address, connected, lowGas } = useWallet();
  const { data: a } = useAccountState(address);

  if (!connected || !address) return null;

  return (
    <div className="flex flex-col gap-2 border-b border-[#334155] px-4 py-[11px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-5">
          <Stat
            label="Equity"
            value={a ? formatUsd(a.equity, { rounding: "down" }) : "—"}
            icon={<AssetLogo symbol="USDC" size={12} />}
            title="Vault balance plus unrealized PnL, at the index price"
          />
          <Stat
            label="Available"
            value={a ? formatUsd(a.freeCollateral > 0n ? a.freeCollateral : 0n, { rounding: "down" }) : "—"}
            title="Free collateral: equity above the initial margin your positions need"
          />
          <Stat
            label="Margin Used"
            value={a ? formatUsd(a.initialMarginRequired, { rounding: "up" }) : "—"}
            title="Initial margin held by open positions"
          />
        </div>
        <DepositWithdrawDialog />
      </div>
      {a?.liquidatable && (
        <p className="rounded-[6px] bg-[#3a1717] px-2 py-1 text-[11.5px] text-[#ff9b9b]">
          Below maintenance margin: this account can be liquidated. Deposit or reduce positions.
        </p>
      )}
      {lowGas && (
        <p className="text-[11px] text-[#fbbf24]">
          Low USDC for gas in your wallet. Keep a little for deposits, withdrawals and cancels.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, icon, title }: { label: string; value: string; icon?: ReactNode; title?: string }) {
  return (
    <div className="flex flex-col items-start gap-0.5" title={title}>
      <span className="text-[10px] uppercase tracking-wider text-[#a3a3a3]">{label}</span>
      <span className="flex items-center gap-[4px] text-xs font-semibold text-[#f5f5f5] tabular">
        {icon}
        {value}
      </span>
    </div>
  );
}
