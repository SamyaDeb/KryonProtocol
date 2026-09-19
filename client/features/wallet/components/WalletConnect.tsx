"use client";

import { useAccountModal } from "@rainbow-me/rainbowkit";
import { formatUnits } from "viem";
import { toast } from "sonner";

import { useWallet } from "@/features/wallet/useWallet";
import { useNetwork } from "@/features/network/NetworkContext";
import { NATIVE_USDC_DECIMALS } from "@/lib/wallet/chains";
import { describeSwitchError } from "@/features/wallet/errors";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Gas USDC for the chrome: two decimals, rounded down so it never overstates. */
function gasLabel(wei: bigint): string {
  const [whole, frac = ""] = formatUnits(wei, NATIVE_USDC_DECIMALS).split(".");
  return `${BigInt(whole).toLocaleString("en-US")}.${frac.padEnd(2, "0").slice(0, 2)}`;
}

/**
 * Navbar wallet control: connect → (switch network) → account.
 *
 * Three states, each with one obvious action: connect when there is no wallet,
 * switch when the wallet is on another chain (nothing can be signed until it
 * is), and the account otherwise — address, gas USDC, and a low-gas warning,
 * because on Arc gas is paid from the same USDC a trader deposits.
 */
export function WalletConnect() {
  const w = useWallet();
  const { config } = useNetwork();
  const { openAccountModal } = useAccountModal();

  if (!w.connected) {
    return (
      <button
        type="button"
        onClick={w.connect}
        disabled={w.connecting}
        className="shrink-0 whitespace-nowrap rounded-[8px] bg-[#f5f5f5] px-3 py-2 text-[12.5px] font-semibold tracking-[.01em] text-[#19191A] transition-colors hover:bg-[#e5e7eb] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f5f5f5] disabled:opacity-50 sm:px-[18px] sm:py-[10px] sm:text-[13.5px]"
      >
        {w.connecting ? "Connecting…" : "Connect Wallet"}
      </button>
    );
  }

  if (w.wrongNetwork) {
    const onSwitch = async () => {
      try {
        await w.switchToExpected();
        toast.success(`Switched to ${config.label}`);
      } catch (e) {
        toast.error(describeSwitchError(e, config.label));
      }
    };
    return (
      <button
        type="button"
        onClick={onSwitch}
        disabled={w.switching}
        className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-[8px] border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[12.5px] font-semibold text-amber-300 transition-colors hover:bg-amber-500/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 disabled:cursor-wait disabled:opacity-60 sm:text-[13.5px]"
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        {w.switching ? "Switching…" : `Switch to ${config.shortLabel}`}
      </button>
    );
  }

  const gas = w.gasBalance === null ? null : gasLabel(w.gasBalance);
  const accountLabel =
    `Account ${w.address}` +
    (gas === null ? "" : `, ${gas} USDC for gas`) +
    (w.lowGas ? ", low: the next transaction may fail" : "");

  return (
    <button
      type="button"
      onClick={openAccountModal}
      aria-label={accountLabel}
      title={w.lowGas ? "Low USDC for gas — top up the wallet before your next transaction" : "Account"}
      className={`flex shrink-0 items-center gap-2 rounded-[7px] border bg-[#212128] px-3 py-2 transition-colors hover:bg-[#2A2A31] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f5f5f5] sm:px-[14px] sm:py-[8px] ${
        w.lowGas ? "border-amber-500/50" : "border-[#2A2A31]"
      }`}
    >
      {gas !== null && (
        <span className={`hidden font-mono text-[12px] sm:inline ${w.lowGas ? "text-amber-300" : "text-[#a3a3a3]"}`}>
          {gas} USDC
        </span>
      )}
      {w.lowGas && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-400 sm:hidden" />}
      <span className="font-mono text-[12.5px] text-[#f5f5f5] sm:text-[14px]">{short(w.address!)}</span>
    </button>
  );
}
