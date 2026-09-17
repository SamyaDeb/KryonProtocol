/**
 * Account and collateral reads. On Arc the only collateral is USDC.
 *
 * Units: the vault ledger and every AccountHealth field are 1e18; wallet USDC
 * and withdrawable amounts are the token's 6 decimals. Conversions go through
 * `ledgerToUsdcDown` (credits to the user round down, per the §3 Decimals rule).
 *
 * Scans batch through Multicall3 so the liquidation keeper and monitor read
 * hundreds of accounts in a handful of RPC calls.
 */

import { erc20Abi, type Address, type PublicClient } from "viem";

import { engineAbi, vaultAbi } from "./contracts";

export const USDC_DECIMALS = 6;
export const LEDGER_DECIMALS = 18;
const SCALE = 10n ** 12n;

/** 1e18 ledger → 1e6 USDC, rounding toward zero for credits (never pays out dust). */
export function ledgerToUsdcDown(ledger: bigint): bigint {
  return ledger <= 0n ? 0n : ledger / SCALE;
}

/** 1e6 USDC → 1e18 ledger. Exact. */
export function usdcToLedger(amount: bigint): bigint {
  return amount * SCALE;
}

export interface AccountHealth {
  collateralValue: bigint;
  unrealizedPnl: bigint;
  equity: bigint;
  initialMarginRequired: bigint;
  maintenanceMarginRequired: bigint;
  freeCollateral: bigint;
  marginRatio: bigint;
  liquidatable: boolean;
}

export interface AccountSnapshot {
  account: Address;
  /** Vault ledger, 1e18, may be negative after losses. */
  ledger: bigint;
  /** USDC 1e6 */
  withdrawable: bigint;
  /** USDC 1e6 in the wallet */
  wallet: bigint;
}

type Reader = Pick<PublicClient, "multicall">;

/** Health for many accounts in Multicall3 batches. Failed calls come back as null. */
export async function readAccountHealth(
  client: Reader,
  engine: Address,
  accounts: readonly Address[],
  batchSize = 200
): Promise<Map<Address, AccountHealth | null>> {
  const out = new Map<Address, AccountHealth | null>();
  for (let i = 0; i < accounts.length; i += batchSize) {
    const slice = accounts.slice(i, i + batchSize);
    const results = await client.multicall({
      allowFailure: true,
      contracts: slice.map((account) => ({
        address: engine,
        abi: engineAbi,
        functionName: "accountHealth" as const,
        args: [account] as const,
      })),
    });
    results.forEach((r, j) => out.set(slice[j], r.status === "success" ? (r.result as AccountHealth) : null));
  }
  return out;
}

export async function readAccountSnapshot(
  client: Reader,
  vault: Address,
  usdc: Address,
  account: Address
): Promise<AccountSnapshot> {
  const [ledger, withdrawable, wallet] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account] },
      { address: vault, abi: vaultAbi, functionName: "withdrawableBalance", args: [account] },
      { address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] },
    ],
  });
  return { account, ledger, withdrawable, wallet };
}

/** Vault-wide caps and totals, USDC 1e6. A cap of 0 blocks deposits (the post-deploy default). */
export async function readDepositCaps(client: Reader, vault: Address) {
  const [[total, perAccount], deposited] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: vault, abi: vaultAbi, functionName: "depositCaps" },
      { address: vault, abi: vaultAbi, functionName: "totalDeposited" },
    ],
  });
  return { totalCap: total, perAccountCap: perAccount, totalDeposited: deposited };
}
