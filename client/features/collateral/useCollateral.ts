"use client";

// One source of truth for "what collateral does this account hold, and what is
// it worth as margin". Every surface that shows a balance reads this, so the
// account bar, the portfolio table and the deposit dialog cannot disagree.

import { useQuery } from "@tanstack/react-query";
import { getBalance, getTokenBalance } from "@/lib/stellar/contracts";
import { getOraclePrice } from "@/lib/stellar/oracle";
import { listVaultCollateral, type ListedCollateral } from "@/lib/stellar/collateral";
import { amountToHuman } from "@/lib/format";
import { PRICE_PRECISION } from "@/config";

export interface CollateralPosition extends ListedCollateral {
  /** Vault balance in contract units. Negative means the vault is owed. */
  raw: bigint;
  /** Vault balance, human units. */
  balance: number;
  /** Wallet (undeposited) balance, human units. */
  walletBalance: number;
  /** Oracle price in USD. */
  price: number;
  /** balance × price — what the collateral is worth. */
  value: number;
  /** value × (1 − haircut) — what it is worth as MARGIN, which is what the
   *  vault's health calculation actually uses. */
  marginValue: number;
}

const toUsd = (raw: bigint, price: bigint): number =>
  amountToHuman(raw) * (Number(price) / Number(PRICE_PRECISION));

/**
 * Every listed collateral asset with this account's balances and values.
 *
 * Assets with a zero balance are kept, not filtered: a trader needs to see
 * USDT0 sitting at zero to know they *can* deposit it. A NEGATIVE balance is
 * kept too, and matters more — it is a settlement debit the vault has already
 * paid out, and hiding it would make equity look unexplained.
 */
export function useCollateral(address: string | null | undefined) {
  const { data: listed } = useQuery({
    queryKey: ["vaultCollateral"],
    queryFn: listVaultCollateral,
    staleTime: 5 * 60_000,
  });

  return useQuery({
    queryKey: ["collateralPositions", address, (listed ?? []).map((l) => l.code).join(",")],
    enabled: !!address && !!listed?.length,
    refetchInterval: 15_000,
    queryFn: async (): Promise<CollateralPosition[]> =>
      Promise.all(
        (listed ?? []).map(async (asset) => {
          const [raw, wallet, price] = await Promise.all([
            getBalance(address!, asset.contract),
            getTokenBalance(address!, asset.contract).catch(() => 0n),
            getOraclePrice(asset.oracleSymbol).catch(() => null),
          ]);
          // A missing price shows as zero value rather than crashing the table,
          // and is never treated as free margin.
          const px = price?.price ?? 0n;
          const value = toUsd(raw, px);
          return {
            ...asset,
            raw,
            balance: amountToHuman(raw),
            walletBalance: amountToHuman(wallet),
            price: Number(px) / Number(PRICE_PRECISION),
            value,
            marginValue: value * (1 - asset.haircutBps / 10_000),
          };
        })
      ),
  });
}
