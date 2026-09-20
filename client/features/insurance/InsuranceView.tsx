"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { erc20Abi, type Hex } from "viem";
import { usePublicClient, useReadContracts, useWriteContract } from "wagmi";

import { Card, Stat } from "@/components/common/PageShell";
import { useProtocolConfig } from "@/features/account/chain";
import { useNetwork } from "@/features/network/NetworkContext";
import { useWallet } from "@/features/wallet/useWallet";
import { insuranceAbi } from "@/lib/chain/contracts";
import { formatFixed, formatUsd, formatUsdc, parseAmount } from "@/lib/format";
import { describeTxError } from "@/lib/market/errors";
import { arcNetwork } from "@/lib/network";
import { GAS_RESERVE_WEI } from "@/lib/wallet/gas";

const E18 = 10n ** 18n;
const GAS_RESERVE_USDC = GAS_RESERVE_WEI / 10n ** 12n;

export function InsuranceView() {
  const { network } = useNetwork();
  const chainId = arcNetwork(network).chainId;
  const { address, ready, connected, connect } = useWallet();
  const { data: cfg } = useProtocolConfig();
  const ins = cfg?.contracts.insurance;
  const usdc = cfg?.contracts.usdc;
  const queryClient = useQueryClient();
  const publicClient = usePublicClient({ chainId });
  const { writeContractAsync } = useWriteContract();
  const [stakeText, setStakeText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const pool = useReadContracts({
    allowFailure: false,
    contracts: ins
      ? ([
          { chainId, address: ins, abi: insuranceAbi, functionName: "effectiveBalance" },
          { chainId, address: ins, abi: insuranceAbi, functionName: "stakedBalance" },
          { chainId, address: ins, abi: insuranceAbi, functionName: "totalShares" },
          { chainId, address: ins, abi: insuranceAbi, functionName: "sharePrice" },
          { chainId, address: ins, abi: insuranceAbi, functionName: "badDebt" },
          { chainId, address: ins, abi: insuranceAbi, functionName: "redeemableStake" },
        ] as const)
      : [],
    query: { enabled: !!ins, refetchInterval: 15_000 },
  });
  const mine = useReadContracts({
    allowFailure: false,
    contracts:
      ins && usdc && address
        ? ([
            { chainId, address: ins, abi: insuranceAbi, functionName: "sharesOf", args: [address] },
            { chainId, address: ins, abi: insuranceAbi, functionName: "pendingUnstake", args: [address] },
            { chainId, address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] },
            { chainId, address: usdc, abi: erc20Abi, functionName: "allowance", args: [address, ins] },
          ] as const)
        : [],
    query: { enabled: !!ins && !!usdc && !!address, refetchInterval: 10_000 },
  });

  const [effective, staked, totalShares, sharePrice, badDebt, redeemable] = (pool.data ?? []) as unknown as (bigint | undefined)[];
  const [shares, pending, wallet, allowance] = (mine.data ?? []) as unknown as [
    bigint | undefined,
    { shares: bigint; unlockTime: bigint; epoch: number } | undefined,
    bigint | undefined,
    bigint | undefined,
  ];
  const myValue = shares !== undefined && sharePrice !== undefined ? (shares * sharePrice) / E18 : undefined;
  const nowSec = useNowSec(30_000);
  const hasPending = !!pending && pending.shares > 0n;
  const unlocked = hasPending && pending!.unlockTime <= nowSec;

  const amount = parseAmount(stakeText, 6);
  const maxStake = wallet !== undefined ? (wallet > GAS_RESERVE_USDC ? wallet - GAS_RESERVE_USDC : 0n) : 0n;
  const stakeProblem =
    stakeText === "" ? null : amount === null || amount === 0n ? "Enter an amount in USDC." : amount > maxStake ? `At most ${formatUsdc(maxStake, { rounding: "down" })}, keeping gas in the wallet.` : null;

  async function send(label: string, fn: () => Promise<Hex>, done: string) {
    if (!publicClient) return;
    setBusy(label);
    try {
      const hash = await fn();
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction reverted.");
      toast.success(done);
      void queryClient.invalidateQueries({ queryKey: pool.queryKey });
      void queryClient.invalidateQueries({ queryKey: mine.queryKey });
      return true;
    } catch (e) {
      toast.error(describeTxError(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function stake() {
    if (!ins || !usdc || amount === null || amount === 0n || stakeProblem) return;
    if ((allowance ?? 0n) < amount) {
      const ok = await send("approve", () => writeContractAsync({ chainId, address: usdc, abi: erc20Abi, functionName: "approve", args: [ins, amount] }), "USDC approved for staking.");
      if (!ok) return;
    }
    const ok = await send("stake", () => writeContractAsync({ chainId, address: ins, abi: insuranceAbi, functionName: "stake", args: [amount] }), `Staked ${formatUsdc(amount)}.`);
    if (ok) setStakeText("");
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="The fund">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Capacity" value={effective !== undefined ? formatUsd(effective, { rounding: "down" }) : "—"} hint="Operating capital net of bad debt, marked to market" />
          <Stat label="Staked" value={staked !== undefined ? formatUsd(staked, { rounding: "down" }) : "—"} />
          <Stat label="Redeemable now" value={redeemable !== undefined ? formatUsd(redeemable, { rounding: "down" }) : "—"} hint="What all stakers could redeem together at the current backstop mark" />
          <Stat label="Share price" value={sharePrice !== undefined ? formatFixed(sharePrice, 18, 6) : "—"} hint="USDC per share; starts at 1" />
          <Stat label="Total shares" value={totalShares !== undefined ? formatFixed(totalShares, 18, 2) : "—"} />
          <Stat label="Bad debt" value={badDebt !== undefined ? formatUsd(badDebt, { rounding: "up" }) : "—"} />
        </div>
      </Card>

      <Card title="Your stake">
        {!connected ? (
          <button onClick={connect} className="rounded-[8px] bg-[#f5f5f5] px-4 py-2 text-[13px] font-semibold text-[#19191A]">
            Connect Wallet
          </button>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="Shares" value={shares !== undefined ? formatFixed(shares, 18, 4) : "—"} />
              <Stat label="Value" value={myValue !== undefined ? formatUsd(myValue, { rounding: "down" }) : "—"} />
              <Stat label="Wallet USDC" value={wallet !== undefined ? formatUsdc(wallet, { rounding: "down" }) : "—"} />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="flex flex-1 flex-col gap-1 text-[12px] text-[#a3a3a3]">
                Stake USDC
                <input
                  inputMode="decimal"
                  value={stakeText}
                  onChange={(e) => setStakeText(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="0.00"
                  className="rounded-[8px] border border-[#334155] bg-[#19191A] px-3 py-2 font-mono text-[14px] text-[#f5f5f5] outline-none focus:border-[#475569]"
                />
              </label>
              <button
                onClick={() => void stake()}
                disabled={!ready || busy !== null || amount === null || amount === 0n || !!stakeProblem}
                className="rounded-[8px] bg-[#f5f5f5] px-4 py-2 text-[13px] font-semibold text-[#19191A] disabled:opacity-40"
              >
                {busy === "approve" ? "Approving…" : busy === "stake" ? "Staking…" : "Stake"}
              </button>
            </div>
            {stakeProblem && <p className="text-[12px] text-[#ff9b9b]">{stakeProblem}</p>}

            <div className="rounded-[8px] border border-[#2A2A31] p-3 text-[13px]">
              {hasPending ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-[#a3a3a3]">
                    {formatFixed(pending!.shares, 18, 4)} shares {unlocked ? "ready to withdraw" : `unlock ${new Date(Number(pending!.unlockTime) * 1000).toLocaleString()}`}.
                    Paid at the share price when withdrawn.
                  </span>
                  <button
                    disabled={!ready || !unlocked || busy !== null}
                    onClick={() => ins && void send("withdraw", () => writeContractAsync({ chainId, address: ins, abi: insuranceAbi, functionName: "withdrawUnstaked" }), "Unstaked USDC sent to your wallet.")}
                    className="rounded-[8px] border border-[#334155] px-3 py-1.5 font-semibold text-[#f5f5f5] disabled:opacity-40"
                  >
                    {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-[#a3a3a3]">Unstaking starts a 7-day cooldown; losses during it are shared.</span>
                  <button
                    disabled={!ready || !shares || shares <= 0n || busy !== null}
                    onClick={() => ins && shares && void send("request", () => writeContractAsync({ chainId, address: ins, abi: insuranceAbi, functionName: "requestUnstake", args: [shares] }), "Unstake requested: withdraw after the cooldown.")}
                    className="rounded-[8px] border border-[#334155] px-3 py-1.5 font-semibold text-[#f5f5f5] disabled:opacity-40"
                  >
                    {busy === "request" ? "Requesting…" : "Request unstake (all)"}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card title="Risks of staking">
        <ul className="list-disc space-y-2 pl-5 text-[13px] leading-6 text-[#a3a3a3]">
          <li>Staked capital absorbs losses from liquidations the fund takes over. If governance sweeps stake to cover them, every staker&apos;s share price falls.</li>
          <li>A withdrawal pays the share price at withdrawal time, not at request time.</li>
          <li>The contracts have not completed an external audit.</li>
        </ul>
      </Card>
    </div>
  );
}

/** Unix seconds, refreshed on an interval, so an unlock time flips to ready on its own. */
function useNowSec(everyMs: number): bigint {
  const [now, setNow] = useState(0n);
  useEffect(() => {
    const tick = () => setNow(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
