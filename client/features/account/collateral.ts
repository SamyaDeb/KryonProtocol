"use client";

/**
 * Deposit and withdraw USDC, from the connected wallet.
 *
 * Deposit, in order of preference:
 *   1. the allowance already covers it → `deposit(amount)`, one transaction;
 *   2. an EIP-2612 permit signature → `depositWithPermit`, still one
 *      transaction (Arc USDC's permit domain comes from `/api/config`);
 *   3. the wallet cannot sign a permit → `approve` then `deposit`.
 * A user rejecting the permit prompt is a cancel, not a reason to fall back.
 *
 * Amounts here are USDC's 6 decimals: the vault's token-facing unit.
 */

import { useCallback, useState } from "react";
import { parseSignature, type Address, type Hex } from "viem";
import { BaseError, UserRejectedRequestError, erc20Abi } from "viem";
import { usePublicClient, useSignTypedData, useWriteContract } from "wagmi";
import { create } from "zustand";

import { useNetwork } from "@/features/network/NetworkContext";
import { vaultAbi } from "@/lib/chain/contracts";
import { arcNetwork } from "@/lib/network";
import type { PublicConfig } from "@/lib/public-config";

const permitNoncesAbi = [
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Which way the collateral dialog is open, shared so any panel can open it. */
export const useCollateralDialog = create<{
  open: "deposit" | "withdraw" | null;
  show: (tab: "deposit" | "withdraw") => void;
  hide: () => void;
}>((set) => ({ open: null, show: (tab) => set({ open: tab }), hide: () => set({ open: null }) }));

export type CollateralStep = "idle" | "signing" | "approving" | "confirming";

const rejected = (e: unknown) => e instanceof BaseError && !!e.walk((x) => x instanceof UserRejectedRequestError);

export function useCollateralActions(cfg: PublicConfig | undefined) {
  const { network } = useNetwork();
  const chainId = arcNetwork(network).chainId;
  const publicClient = usePublicClient({ chainId });
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const [step, setStep] = useState<CollateralStep>("idle");

  const wait = useCallback(
    async (hash: Hex) => {
      if (!publicClient) throw new Error("No RPC client for this network");
      setStep("confirming");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
      return hash;
    },
    [publicClient]
  );

  const deposit = useCallback(
    async (owner: Address, amount: bigint, allowance: bigint): Promise<Hex> => {
      if (!cfg || !publicClient) throw new Error("Network config is still loading");
      const { vault, usdc } = cfg.contracts;
      try {
        if (allowance >= amount) {
          setStep("signing");
          return await wait(await writeContractAsync({ chainId, address: vault, abi: vaultAbi, functionName: "deposit", args: [amount] }));
        }

        // Permit: one signature, one transaction.
        let permit: { v: number; r: Hex; s: Hex; deadline: bigint } | null = null;
        try {
          setStep("signing");
          const nonce = await publicClient.readContract({ address: usdc, abi: permitNoncesAbi, functionName: "nonces", args: [owner] });
          const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
          const sig = await signTypedDataAsync({
            domain: cfg.usdc_permit_domain,
            types: PERMIT_TYPES,
            primaryType: "Permit",
            message: { owner, spender: vault, value: amount, nonce, deadline },
          });
          const { v, r, s, yParity } = parseSignature(sig);
          permit = { v: Number(v ?? BigInt(27 + (yParity ?? 0))), r, s, deadline };
        } catch (e) {
          if (rejected(e)) throw e;
          permit = null; // the wallet cannot sign a permit: fall back to approve
        }

        if (permit) {
          return await wait(
            await writeContractAsync({
              chainId,
              address: vault,
              abi: vaultAbi,
              functionName: "depositWithPermit",
              args: [amount, permit.deadline, permit.v, permit.r, permit.s],
            })
          );
        }

        setStep("approving");
        await wait(await writeContractAsync({ chainId, address: usdc, abi: erc20Abi, functionName: "approve", args: [vault, amount] }));
        setStep("signing");
        return await wait(await writeContractAsync({ chainId, address: vault, abi: vaultAbi, functionName: "deposit", args: [amount] }));
      } finally {
        setStep("idle");
      }
    },
    [cfg, publicClient, chainId, writeContractAsync, signTypedDataAsync, wait]
  );

  const withdraw = useCallback(
    async (amount: bigint): Promise<Hex> => {
      if (!cfg) throw new Error("Network config is still loading");
      try {
        setStep("signing");
        return await wait(
          await writeContractAsync({ chainId, address: cfg.contracts.vault, abi: vaultAbi, functionName: "withdraw", args: [amount] })
        );
      } finally {
        setStep("idle");
      }
    },
    [cfg, chainId, writeContractAsync, wait]
  );

  return { deposit, withdraw, step, busy: step !== "idle" };
}
