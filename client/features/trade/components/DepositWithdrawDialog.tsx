"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useWalletStore } from "@/stores/wallet";
import { deposit, withdraw, getBalance, getTokenBalance } from "@/lib/stellar/contracts";
import {
  listVaultCollateral,
  hasTrustline,
  addTrustline,
  roundToBridgeable,
  type ListedCollateral,
} from "@/lib/stellar/collateral";
import { humanToAmount, amountToHuman } from "@/lib/format";
import { SETTLEMENT_ASSET, STELLAR_EXPERT_URL, NETWORK_LABEL } from "@/config";
import { isOnExpectedNetwork } from "@/lib/stellar/freighter";
import { AssetLogo } from "@/components/common/AssetLogos";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";

export function DepositWithdrawDialog({
  triggerLabel = "Deposit / Withdraw",
  triggerClassName = "min-h-9 py-2 text-xs leading-tight rounded-[6px] border border-[#334155] bg-[#212128] hover:border-[#475569] text-[#f5f5f5] px-3 max-w-[100px] text-center transition-colors",
  defaultTab = "deposit",
}: {
  triggerLabel?: string;
  triggerClassName?: string;
  defaultTab?: "deposit" | "withdraw";
} = {}) {
  const { address, setWrongNetwork } = useWalletStore();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"deposit" | "withdraw">(defaultTab);
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [assetCode, setAssetCode] = useState(SETTLEMENT_ASSET.code);
  const [addingTrustline, setAddingTrustline] = useState(false);

  // What the vault actually accepts right now. Config only nominates
  // candidates; an asset the vault has not listed would revert on deposit, so
  // it must never reach the picker.
  const { data: collateral } = useQuery({
    queryKey: ["vaultCollateral"],
    queryFn: listVaultCollateral,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const assets: ListedCollateral[] = collateral ?? [];
  // Falls back to the first listed asset if the selected one is de-listed while
  // the dialog is open — derived, so no effect and no cascading render.
  const asset = assets.find((a) => a.code === assetCode) ?? assets[0];
  const assetAddress = asset?.contract;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const { data: balance } = useQuery({
    queryKey: ["balance", address, assetAddress],
    queryFn: () => getBalance(address!, assetAddress!),
    enabled: !!address && !!assetAddress && open,
  });
  const balanceHuman = balance !== undefined ? amountToHuman(balance) : 0;

  const { data: walletBalance } = useQuery({
    queryKey: ["walletBalance", address, assetAddress],
    queryFn: () => getTokenBalance(address!, assetAddress!),
    enabled: !!address && !!assetAddress && open,
  });
  const walletBalanceHuman = walletBalance !== undefined ? amountToHuman(walletBalance) : null;

  // Stellar needs a trustline before an account can hold an issued asset. Without
  // this check the deposit fails inside the token transfer with an error that
  // does not say why.
  const { data: trustline } = useQuery({
    queryKey: ["trustline", address, assetAddress],
    queryFn: () => hasTrustline(address!, asset!),
    enabled: !!address && !!asset && open,
  });
  const missingTrustline = trustline === false;

  // Staged-rollout cap. A deposit past it reverts, so show the ceiling.
  const capHeadroomHuman =
    asset?.capHeadroom === null || asset?.capHeadroom === undefined
      ? null
      : amountToHuman(asset.capHeadroom);

  function onAmount(v: string) {
    const cleaned = v.replace(/[^0-9.]/g, "");
    const parts = cleaned.split(".");
    setAmount(parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : cleaned);
  }

  /** Opens the trustline in Freighter, then re-checks so the form unlocks. */
  async function onAddTrustline() {
    if (!address || !asset) return;
    const onCorrectNetwork = await isOnExpectedNetwork();
    if (!onCorrectNetwork) {
      setWrongNetwork(true);
      toast.error(`Freighter is on the wrong network — switch to ${NETWORK_LABEL} and try again.`);
      return;
    }
    setAddingTrustline(true);
    try {
      const hash = await addTrustline(address, asset);
      toast.success(`${asset.code} trustline added`, {
        action: {
          label: "Explorer",
          onClick: () => window.open(`${STELLAR_EXPERT_URL}/tx/${hash}`, "_blank"),
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["trustline", address] });
      await queryClient.invalidateQueries({ queryKey: ["walletBalance", address] });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAddingTrustline(false);
    }
  }

  async function run(kind: "deposit" | "withdraw") {
    if (!address || !amount || !asset) return;
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    // Re-check network on every action — Freighter may have switched networks since connect
    const onCorrectNetwork = await isOnExpectedNetwork();
    if (!onCorrectNetwork) {
      setWrongNetwork(true);
      toast.error(`Freighter is on the wrong network — switch to ${NETWORK_LABEL} and try again.`);
      return;
    }
    setWrongNetwork(false);
    // Withdrawals round down to what the asset can bridge out at, so no dust
    // gets stranded in the wallet; the remainder stays as vault balance.
    const raw =
      kind === "withdraw"
        ? roundToBridgeable(humanToAmount(parsedAmount), asset)
        : humanToAmount(parsedAmount);
    if (raw <= 0n) {
      toast.error("Amount is below the smallest withdrawable unit");
      return;
    }
    setLoading(true);
    try {
      const res = kind === "deposit"
        ? await deposit(address, raw, asset.contract)
        : await withdraw(address, raw, asset.contract);
      toast.success(`${kind === "deposit" ? "Deposit" : "Withdrawal"} confirmed`, {
        action: {
          label: "Explorer",
          onClick: () =>
            window.open(`${STELLAR_EXPERT_URL}/tx/${(res as { hash?: string }).hash ?? ""}`, "_blank"),
        },
      });
      setAmount("");
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["balance", address] });
      queryClient.invalidateQueries({ queryKey: ["walletBalance", address] });
      queryClient.invalidateQueries({ queryKey: ["health", address] });
      queryClient.invalidateQueries({ queryKey: ["vaultCollateral"] });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  const amt = parseFloat(amount) || 0;
  const overCap = tab === "deposit" && capHeadroomHuman !== null && amt > capHeadroomHuman;
  const overMax =
    (tab === "withdraw" && amt > balanceHuman) ||
    (tab === "deposit" && walletBalanceHuman !== null && amt > walletBalanceHuman);
  const pill = (active: boolean) =>
    `rounded-[8px] py-2 text-[13px] font-semibold transition-colors ${
      active ? "bg-[#212128] text-[#f5f5f5]" : "text-[#a3a3a3] hover:text-[#f5f5f5]"
    }`;

  return (
    <>
      <button onClick={() => { setTab(defaultTab); setOpen(true); }} className={triggerClassName}>
        {triggerLabel}
      </button>

      {open && typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-4">
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
            <div
              className="relative max-h-[92dvh] w-full max-w-full overflow-y-auto rounded-t-2xl border border-[#334155] bg-[#19191A] text-[#f5f5f5] shadow-[0_20px_60px_rgba(0,0,0,.6)] sm:w-[380px] sm:rounded-xl"
              style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            >
              <div className="p-5">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <h2 className="text-[17px] font-bold text-[#f5f5f5]">Collateral</h2>
                  <button
                    onClick={() => setOpen(false)}
                    aria-label="Close"
                    className="w-7 h-7 grid place-items-center rounded-[6px] text-[#a3a3a3] hover:text-[#f5f5f5] hover:bg-[#212128] transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Tabs */}
                <div className="mt-4 grid grid-cols-2 gap-1 rounded-[10px] border border-[#334155] bg-[#212128] p-1">
                  <button className={pill(tab === "deposit")} onClick={() => setTab("deposit")}>Deposit</button>
                  <button className={pill(tab === "withdraw")} onClick={() => setTab("withdraw")}>Withdraw</button>
                </div>

                {/* Asset picker — only when the vault lists more than one */}
                {assets.length > 1 && (
                  <div className="mt-4 flex gap-1.5">
                    {assets.map((a) => (
                      <button
                        key={a.code}
                        onClick={() => { setAssetCode(a.code); setAmount(""); }}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border px-3 py-2 text-[13px] font-semibold transition-colors ${
                          a.code === assetCode
                            ? "border-[#e2a9f1] bg-[#212128] text-[#f5f5f5]"
                            : "border-[#334155] bg-[#19191A] text-[#a3a3a3] hover:text-[#f5f5f5]"
                        }`}
                      >
                        <AssetLogo symbol={a.code} size={15} />
                        {a.code}
                      </button>
                    ))}
                  </div>
                )}

                {/* Amount panel */}
                <div className="mt-4 rounded-[12px] border border-[#334155] bg-[#212128] p-4">
                  <div className="mb-2 flex items-center justify-between text-[12px] text-[#a3a3a3]">
                    <span>Amount</span>
                    {tab === "deposit" && walletBalanceHuman !== null && (
                      <div className="flex items-center gap-2 text-[11.5px]">
                        <button
                          onClick={() => setAmount((walletBalanceHuman / 2).toFixed(2))}
                          className="rounded-full bg-[#212128] border border-[#334155] px-2.5 py-0.5 font-semibold text-[#a3a3a3] hover:text-[#f5f5f5] transition-colors"
                        >
                          50%
                        </button>
                        <button
                          onClick={() => setAmount(walletBalanceHuman.toFixed(2))}
                          className="rounded-full bg-[#212128] border border-[#334155] px-2.5 py-0.5 font-semibold text-[#a3a3a3] hover:text-[#f5f5f5] transition-colors"
                        >
                          Max
                        </button>
                      </div>
                    )}
                    {tab === "withdraw" && (
                      <div className="flex items-center gap-2 text-[11.5px]">
                        <button
                          onClick={() => setAmount((balanceHuman / 2).toFixed(2))}
                          className="rounded-full bg-[#212128] border border-[#334155] px-2.5 py-0.5 font-semibold text-[#a3a3a3] hover:text-[#f5f5f5] transition-colors"
                        >
                          50%
                        </button>
                        <button
                          onClick={() => setAmount(balanceHuman.toFixed(2))}
                          className="rounded-full bg-[#212128] border border-[#334155] px-2.5 py-0.5 font-semibold text-[#a3a3a3] hover:text-[#f5f5f5] transition-colors"
                        >
                          Max
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <input
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => onAmount(e.target.value)}
                      className="flex-1 min-w-0 bg-transparent outline-none border-0 text-[26px] font-semibold text-[#f5f5f5] tabular"
                    />
                    <span className="flex shrink-0 items-center gap-1.5 text-[15px] font-semibold text-[#f5f5f5]">
                      <AssetLogo symbol={asset?.code ?? ""} size={18} /> {asset?.code ?? "—"}
                    </span>
                  </div>
                </div>

                {/* Balance row */}
                <div className="mt-3 flex flex-col gap-1 px-1 text-[12.5px]">
                  {tab === "deposit" && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#a3a3a3]">Wallet balance</span>
                      <span className="flex items-center gap-1.5 tabular text-[#f5f5f5]">
                        <AssetLogo symbol={asset?.code ?? ""} size={12} />
                        {walletBalanceHuman === null ? "—" : `$${walletBalanceHuman.toFixed(2)}`}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-[#a3a3a3]">
                      {tab === "deposit" ? "Vault balance" : "Available to withdraw"}
                    </span>
                    <span className="flex items-center gap-1.5 tabular text-[#f5f5f5]">
                      <AssetLogo symbol={asset?.code ?? ""} size={12} />
                      {balance === undefined ? "—" : `$${balanceHuman.toFixed(2)}`}
                    </span>
                  </div>
                </div>

                {/* Asset facts that change what a deposit is worth */}
                {asset && (
                  <div className="mt-2 flex flex-col gap-1 px-1 text-[12.5px]">
                    {asset.haircutBps > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-[#a3a3a3]">Margin haircut</span>
                        <span className="tabular text-[#f5f5f5]">
                          {(asset.haircutBps / 100).toFixed(2)}%
                        </span>
                      </div>
                    )}
                    {tab === "deposit" && capHeadroomHuman !== null && (
                      <div className="flex items-center justify-between">
                        <span className="text-[#a3a3a3]">Remaining capacity</span>
                        <span className="tabular text-[#f5f5f5]">
                          ${capHeadroomHuman.toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {asset?.note && (
                  <p className="mt-2 px-1 text-[11.5px] text-[#737373]">{asset.note}</p>
                )}

                {missingTrustline && tab === "deposit" && asset && (
                  <p className="mt-3 rounded-[8px] border border-[#7c5e2a] bg-[#2a2116] px-3 py-2 text-[11.5px] text-[#e8c17a]">
                    Stellar accounts cannot hold an issued asset without a trustline. Adding
                    one is a single signature and costs a small XLM reserve.
                  </p>
                )}

                {/* Primary */}
                <button
                  onClick={() =>
                    tab === "deposit" && missingTrustline ? onAddTrustline() : run(tab)
                  }
                  disabled={
                    addingTrustline ||
                    (tab === "deposit" && missingTrustline
                      ? !asset
                      : loading || !amount || amt <= 0 || overMax || overCap || !asset)
                  }
                  className="mt-5 w-full h-12 rounded-[10px] text-[14px] font-bold text-[#19191A] bg-[#e2a9f1] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  {addingTrustline
                    ? "Adding trustline…"
                    : loading
                    ? "Confirming…"
                    : !asset
                    ? "No collateral listed"
                    : tab === "deposit" && missingTrustline
                    ? `Add ${asset.code} trustline`
                    : tab === "deposit" && walletBalanceHuman !== null && amt > walletBalanceHuman
                    ? `Insufficient ${asset.code} in wallet`
                    : overCap
                    ? "Over the deposit cap"
                    : tab === "withdraw" && amt > balanceHuman
                    ? "Insufficient vault balance"
                    : tab === "deposit"
                    ? `Deposit ${asset.code}`
                    : `Withdraw ${asset.code}`}
                </button>

                <p className="mt-3 text-[11px] text-[#737373] text-center">
                  Signed via Freighter and submitted to {NETWORK_LABEL}.
                </p>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
