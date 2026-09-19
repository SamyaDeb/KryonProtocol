"use client";

import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { AssetLogo } from "@/components/common/AssetLogos";
import { useAccountState, useProtocolConfig } from "@/features/account/chain";
import { useCollateralActions, useCollateralDialog } from "@/features/account/collateral";
import { useNetwork } from "@/features/network/NetworkContext";
import { useWallet } from "@/features/wallet/useWallet";
import { formatFixed, formatUsd, formatUsdc, parseAmount } from "@/lib/format";
import { describeTxError } from "@/lib/market/errors";
import { explorerTxUrl } from "@/lib/network";
import { GAS_RESERVE_WEI } from "@/lib/wallet/gas";

const USDC = 6;
/** The gas reserve in USDC's 6 decimals (native gas USDC is 18). */
const GAS_RESERVE_USDC = GAS_RESERVE_WEI / 10n ** 12n;

/**
 * Deposit USDC into the vault, or withdraw it.
 *
 * Deposits keep a gas reserve in the wallet (USDC is Arc's gas) and respect
 * both deposit caps. Withdrawals are bounded by what the vault will release
 * now: the ledger balance and the free collateral above open positions'
 * initial margin, whichever is smaller.
 */
export function DepositWithdrawDialog({
  triggerLabel = "Deposit / Withdraw",
  triggerClassName = "min-h-9 py-2 text-xs leading-tight rounded-[6px] border border-[#334155] bg-[#212128] hover:border-[#475569] text-[#f5f5f5] px-3 max-w-[100px] text-center transition-colors",
  defaultTab = "deposit",
}: {
  triggerLabel?: string;
  triggerClassName?: string;
  defaultTab?: "deposit" | "withdraw";
} = {}) {
  const { open, show, hide } = useCollateralDialog();
  return (
    <>
      <button onClick={() => show(defaultTab)} className={triggerClassName}>
        {triggerLabel}
      </button>
      {open && typeof document !== "undefined" && createPortal(<Dialog tab={open} setTab={show} close={hide} />, document.body)}
    </>
  );
}

function Dialog({
  tab,
  setTab,
  close,
}: {
  tab: "deposit" | "withdraw";
  setTab: (t: "deposit" | "withdraw") => void;
  close: () => void;
}) {
  const { address, ready, wrongNetwork, switchToExpected } = useWallet();
  const { network } = useNetwork();
  const queryClient = useQueryClient();
  const { data: cfg } = useProtocolConfig();
  const account = useAccountState(address);
  const a = account.data;
  const { deposit, withdraw, step, busy } = useCollateralActions(cfg);
  const [text, setText] = useState("");

  const amount = parseAmount(text, USDC);
  const depositMax = a ? clamp(min(a.walletUsdc - GAS_RESERVE_USDC, a.depositRoom)) : null;
  const withdrawMax = a ? a.maxWithdraw : null;
  const max = tab === "deposit" ? depositMax : withdrawMax;
  const closed = a !== undefined && a.depositCapTotal === 0n && !a.capExempt;

  let problem: string | null = null;
  if (text !== "" && amount === null) problem = "Enter an amount in USDC, up to 6 decimals.";
  else if (amount !== null && amount === 0n) problem = "Enter an amount above zero.";
  else if (tab === "deposit" && closed) problem = "Deposits are not open yet on this venue.";
  else if (amount !== null && a && tab === "deposit" && amount > a.walletUsdc - GAS_RESERVE_USDC)
    problem = `Keep at least ${formatUsdc(GAS_RESERVE_USDC)} in the wallet for gas.`;
  else if (amount !== null && a && tab === "deposit" && amount > a.depositRoom)
    problem = `Above the deposit cap: at most ${formatUsdc(a.depositRoom, { rounding: "down" })} more can be deposited.`;
  else if (amount !== null && a && tab === "withdraw" && amount > a.maxWithdraw)
    problem =
      a.initialMarginRequired > 0n
        ? `At most ${formatUsdc(a.maxWithdraw, { rounding: "down" })} while your positions need their initial margin.`
        : `At most ${formatUsdc(a.maxWithdraw, { rounding: "down" })}.`;

  const setFraction = (num: bigint, den: bigint) => {
    if (max === null) return;
    setText(formatFixed((max * num) / den, USDC, 2, { grouping: false, rounding: "down" }));
  };

  async function submit() {
    if (!address || amount === null || amount === 0n || problem || !a) return;
    try {
      const hash = tab === "deposit" ? await deposit(address, amount, a.allowance) : await withdraw(amount);
      toast.success(`${tab === "deposit" ? "Deposited" : "Withdrew"} ${formatUsdc(amount)}`, {
        action: { label: "Explorer", onClick: () => window.open(explorerTxUrl(network, hash), "_blank", "noopener") },
      });
      setText("");
      close();
      void queryClient.invalidateQueries({ queryKey: account.queryKey });
    } catch (e) {
      toast.error(describeTxError(e));
    }
  }

  const pill = (active: boolean) =>
    `rounded-[8px] py-2 text-[13px] font-semibold transition-colors ${active ? "bg-[#19191A] text-[#f5f5f5]" : "text-[#a3a3a3] hover:text-[#f5f5f5]"}`;
  const stepText: Record<string, string> = {
    signing: "Confirm in your wallet…",
    approving: "Approving USDC…",
    confirming: "Waiting for confirmation…",
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={busy ? undefined : close} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Collateral"
        className="relative max-h-[92dvh] w-full max-w-full overflow-y-auto rounded-t-2xl border border-[#334155] bg-[#19191A] text-[#f5f5f5] shadow-[0_20px_60px_rgba(0,0,0,.6)] sm:w-[380px] sm:rounded-xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[17px] font-bold">Collateral</h2>
            <button
              onClick={close}
              disabled={busy}
              aria-label="Close"
              className="grid h-7 w-7 place-items-center rounded-[6px] text-[#a3a3a3] transition-colors hover:bg-[#212128] hover:text-[#f5f5f5] disabled:opacity-40"
            >
              <X size={16} />
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-1 rounded-[10px] border border-[#334155] bg-[#212128] p-1">
            <button className={pill(tab === "deposit")} onClick={() => { setTab("deposit"); setText(""); }} disabled={busy}>
              Deposit
            </button>
            <button className={pill(tab === "withdraw")} onClick={() => { setTab("withdraw"); setText(""); }} disabled={busy}>
              Withdraw
            </button>
          </div>

          <div className="mt-4 rounded-[12px] border border-[#334155] bg-[#212128] p-4">
            <div className="mb-2 flex items-center justify-between text-[12px] text-[#a3a3a3]">
              <label htmlFor="collateral-amount">Amount</label>
              {max !== null && max > 0n && (
                <div className="flex items-center gap-2 text-[11.5px]">
                  {([["50%", 1n, 2n], ["Max", 1n, 1n]] as const).map(([label, n, d]) => (
                    <button
                      key={label}
                      onClick={() => setFraction(n, d)}
                      className="rounded-full border border-[#334155] bg-[#19191A] px-2.5 py-0.5 font-semibold text-[#a3a3a3] transition-colors hover:text-[#f5f5f5]"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <input
                id="collateral-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={text}
                onChange={(e) => setText(e.target.value.replace(/[^0-9.,]/g, ""))}
                className="min-w-0 flex-1 border-0 bg-transparent text-[26px] font-semibold text-[#f5f5f5] outline-none tabular"
              />
              <span className="flex shrink-0 items-center gap-1.5 text-[15px] font-semibold">
                <AssetLogo symbol="USDC" size={18} /> USDC
              </span>
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-1 px-1 text-[12.5px]">
            {tab === "deposit" ? (
              <>
                <Row label="Wallet balance" value={a ? formatUsdc(a.walletUsdc, { rounding: "down" }) : "—"} />
                <Row label="Vault balance" value={a ? formatUsd(a.ledger, { rounding: "down" }) : "—"} />
                <Row
                  label="Deposit room under the caps"
                  value={a ? (a.capExempt ? "No cap" : formatUsdc(a.depositRoom, { rounding: "down" })) : "—"}
                />
              </>
            ) : (
              <>
                <Row label="Vault balance" value={a ? formatUsd(a.ledger, { rounding: "down" }) : "—"} />
                <Row label="Available to withdraw" value={a ? formatUsdc(a.maxWithdraw, { rounding: "down" }) : "—"} />
                {a && a.initialMarginRequired > 0n && (
                  <p className="pt-1 text-[11.5px] leading-5 text-[#a3a3a3]">
                    Open positions hold {formatUsd(a.initialMarginRequired, { rounding: "up" })} of initial margin. If a
                    price feed for a market you hold goes stale, withdrawals wait until it updates.
                  </p>
                )}
              </>
            )}
          </div>

          {problem && <p className="mt-3 px-1 text-[12px] text-[#ff9b9b]">{problem}</p>}

          {wrongNetwork ? (
            <button
              onClick={() => void switchToExpected()}
              className="mt-5 w-full rounded-[10px] bg-[#f5f5f5] py-3 text-[14px] font-semibold text-[#19191A]"
            >
              Switch network
            </button>
          ) : (
            <button
              onClick={() => void submit()}
              disabled={!ready || busy || amount === null || amount === 0n || !!problem || !a}
              className="mt-5 w-full rounded-[10px] bg-[#f5f5f5] py-3 text-[14px] font-semibold text-[#19191A] transition-opacity disabled:opacity-40"
            >
              {busy ? stepText[step] : tab === "deposit" ? "Deposit" : "Withdraw"}
            </button>
          )}
          {tab === "deposit" && (
            <p className="mt-3 text-center text-[11px] text-[#737373]">
              One signature and one transaction when your wallet supports USDC permits; otherwise an approval first.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[#a3a3a3]">{label}</span>
      <span className="tabular text-[#f5f5f5]">{value}</span>
    </div>
  );
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const clamp = (x: bigint) => (x < 0n ? 0n : x);
