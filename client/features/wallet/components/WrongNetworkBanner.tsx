"use client";

import { toast } from "sonner";

import { useNetwork } from "@/features/network/NetworkContext";
import { describeSwitchError } from "@/features/wallet/errors";
import { useWallet } from "@/features/wallet/useWallet";

/**
 * Full-width notice while the connected wallet is on another chain.
 *
 * Every signature Kryon asks for is bound to a chain id (the EIP-712 domain,
 * the USDC permit, every transaction), so on the wrong chain nothing can be
 * signed or sent. The navbar button offers the switch too; this says why, in
 * words, where a screen reader and a distracted trader will both find it.
 */
export function WrongNetworkBanner() {
  const w = useWallet();
  const { config } = useNetwork();
  if (!w.wrongNetwork) return null;

  const onSwitch = async () => {
    try {
      await w.switchToExpected();
    } catch (e) {
      toast.error(describeSwitchError(e, config.label));
    }
  };

  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-amber-500/30 bg-amber-500/10 px-3 py-[6px] text-center text-[12px] text-amber-200"
    >
      <span>
        <strong className="font-semibold">Wrong network.</strong> Your wallet is on chain {w.chainId}; {config.label}{" "}
        runs on chain {w.expectedChainId}. Orders, deposits and withdrawals are disabled until you switch.
      </span>
      <button
        type="button"
        onClick={onSwitch}
        disabled={w.switching}
        className="rounded-[5px] font-semibold underline underline-offset-2 hover:text-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200 disabled:cursor-wait"
      >
        {w.switching ? "Switching…" : `Switch to ${config.shortLabel}`}
      </button>
    </div>
  );
}
