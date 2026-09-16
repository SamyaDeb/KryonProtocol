"use client";

import { CONTRACTS, ASSETS } from "@/config";
import { simulateRead, invokeContract } from "./invoke";
import { addressToScVal, u32ToScVal, i128ToScVal, scValToI128 } from "./scval";
import { rpc } from "@stellar/stellar-sdk";

// ─── Read-only calls (simulate, no signature needed) ─────────────────────────

export async function getPositions(userAddress: string): Promise<RawPosition[]> {
  const val = await simulateRead(
    CONTRACTS.engine,
    "positions",
    [addressToScVal(userAddress)]
  );
  if (!val) return [];
  const { scValToNative } = await import("@stellar/stellar-sdk");
  const native = scValToNative(val) as Record<string, unknown>[];
  return native.map(parsePosition);
}

export async function getOpenInterest(marketId: number): Promise<{ long: bigint; short: bigint; total: bigint }> {
  const [longVal, shortVal, totalVal] = await Promise.all([
    simulateRead(CONTRACTS.engine, "long_open_interest", [u32ToScVal(marketId)]),
    simulateRead(CONTRACTS.engine, "short_open_interest", [u32ToScVal(marketId)]),
    simulateRead(CONTRACTS.engine, "open_interest", [u32ToScVal(marketId)]),
  ]);
  return {
    long: longVal ? scValToI128(longVal) : 0n,
    short: shortVal ? scValToI128(shortVal) : 0n,
    total: totalVal ? scValToI128(totalVal) : 0n,
  };
}

export async function getBalance(
  userAddress: string,
  assetAddress: string = ASSETS.usdc
): Promise<bigint> {
  const val = await simulateRead(
    CONTRACTS.vault,
    "balance_of",
    [addressToScVal(userAddress), addressToScVal(assetAddress)]
  );
  return val ? scValToI128(val) : 0n;
}

// Returns the user's actual token wallet balance by querying the token contract directly.
export async function getTokenBalance(
  userAddress: string,
  assetAddress: string = ASSETS.usdc
): Promise<bigint> {
  const val = await simulateRead(
    assetAddress,
    "balance",
    [addressToScVal(userAddress)]
  );
  return val ? scValToI128(val) : 0n;
}

/** Raw `CollateralConfig` as listed on the vault, or null if never listed. */
export interface RawCollateralConfig {
  oracleSymbol: string;
  haircutBps: number;
  active: boolean;
}

/**
 * Reads the vault's own view of a collateral asset. This is the authority on
 * whether an asset is depositable — the client config only nominates
 * candidates, and an asset absent or inactive here would revert on deposit.
 */
export async function getCollateralConfig(
  assetAddress: string
): Promise<RawCollateralConfig | null> {
  const val = await simulateRead(CONTRACTS.vault, "collateral", [addressToScVal(assetAddress)]);
  if (!val) return null;
  const { scValToNative } = await import("@stellar/stellar-sdk");
  const native = scValToNative(val) as Record<string, unknown> | null;
  if (!native) return null;
  return {
    oracleSymbol: String(native["oracle_asset"] ?? ""),
    haircutBps: Number(native["haircut_bps"] ?? 0),
    active: Boolean(native["active"]),
  };
}

/** Per-asset gross deposit cap, or null when uncapped. */
export async function getDepositCap(assetAddress: string): Promise<bigint | null> {
  const val = await simulateRead(CONTRACTS.vault, "deposit_cap", [addressToScVal(assetAddress)]);
  if (!val) return null;
  const { scValToNative } = await import("@stellar/stellar-sdk");
  const native = scValToNative(val);
  return native === null || native === undefined ? null : BigInt(String(native));
}

/** Deposits minus withdrawals for an asset — what the cap is measured against. */
export async function getTotalDeposited(assetAddress: string): Promise<bigint> {
  const val = await simulateRead(CONTRACTS.vault, "total_deposited", [
    addressToScVal(assetAddress),
  ]);
  return val ? scValToI128(val) : 0n;
}

export async function getAccountHealth(
  userAddress: string,
  assetAddress: string = ASSETS.usdc
): Promise<RawAccountHealth | null> {
  const val = await simulateRead(
    CONTRACTS.vault,
    "account_health",
    [addressToScVal(userAddress), addressToScVal(assetAddress)]
  );
  if (!val) return null;
  const { scValToNative } = await import("@stellar/stellar-sdk");
  const native = scValToNative(val) as Record<string, unknown>;
  // AccountHealth struct: collateral_value, unrealized_pnl, equity,
  // initial_margin_required, maintenance_margin_required, free_collateral,
  // margin_ratio (1e18 precision = equity/maintenance), liquidatable
  return {
    equity: BigInt(String(native["equity"] ?? "0")),
    usedMargin: BigInt(String(native["initial_margin_required"] ?? "0")),
    freeCollateral: BigInt(String(native["free_collateral"] ?? "0")),
    // margin_ratio = equity * 1e18 / maintenance_margin_required (1e18 precision)
    healthFactor: BigInt(String(native["margin_ratio"] ?? "0")),
    liquidatable: Boolean(native["liquidatable"]),
  };
}

export async function isCancelled(userAddress: string, nonce: bigint): Promise<boolean> {
  const { u64ToScVal } = await import("./scval");
  const val = await simulateRead(
    CONTRACTS.orderGateway,
    "is_cancelled",
    [addressToScVal(userAddress), u64ToScVal(nonce)]
  );
  if (!val) return false;
  const { scValToNative } = await import("@stellar/stellar-sdk");
  return Boolean(scValToNative(val));
}

// Cumulative filled size for an (owner, nonce) order, tracked on-chain by the
// gateway. Used to reconcile local "pending" orders against on-chain truth.
export async function getOrderFilled(userAddress: string, nonce: bigint): Promise<bigint> {
  const { u64ToScVal } = await import("./scval");
  const val = await simulateRead(
    CONTRACTS.orderGateway,
    "filled",
    [addressToScVal(userAddress), u64ToScVal(nonce)]
  );
  return val ? scValToI128(val) : 0n;
}

// ─── Write calls (require Freighter signature) ────────────────────────────────

export async function deposit(
  userAddress: string,
  amount: bigint,
  assetAddress: string = ASSETS.usdc
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  return invokeContract(
    CONTRACTS.vault,
    "deposit",
    [addressToScVal(userAddress), addressToScVal(assetAddress), i128ToScVal(amount)],
    userAddress
  );
}

export async function withdraw(
  userAddress: string,
  amount: bigint,
  assetAddress: string = ASSETS.usdc
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  return invokeContract(
    CONTRACTS.vault,
    "withdraw",
    [addressToScVal(userAddress), addressToScVal(assetAddress), i128ToScVal(amount)],
    userAddress
  );
}

// expiryTs must be the order's real expiry — the gateway keeps the cancel
// tombstone until then, after which reclaim_order_state may prune it.
export async function cancelOrder(
  userAddress: string,
  nonce: bigint,
  expiryTs: bigint
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const { u64ToScVal } = await import("./scval");
  return invokeContract(
    CONTRACTS.orderGateway,
    "cancel_order",
    [addressToScVal(userAddress), u64ToScVal(nonce), u64ToScVal(expiryTs)],
    userAddress
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawPosition {
  positionId: bigint;
  owner: string;
  marketId: number;
  size: bigint;
  entryPrice: bigint;
  margin: bigint;
  isLong: boolean;
  lastFundingIndex: bigint;
}

export interface RawAccountHealth {
  equity: bigint;
  usedMargin: bigint;       // initial_margin_required
  freeCollateral: bigint;
  healthFactor: bigint;     // margin_ratio in 1e18 precision (equity / maintenance * 1e18)
  liquidatable: boolean;
}

function parsePosition(raw: Record<string, unknown>): RawPosition {
  return {
    positionId: BigInt(String(raw["position_id"] ?? "0")),
    owner: String(raw["owner"] ?? ""),
    marketId: Number(raw["market_id"] ?? 0),
    size: BigInt(String(raw["size"] ?? "0")),
    entryPrice: BigInt(String(raw["entry_price"] ?? "0")),
    margin: BigInt(String(raw["margin"] ?? "0")),
    isLong: Boolean(raw["is_long"]),
    lastFundingIndex: BigInt(String(raw["last_funding_index"] ?? "0")),
  };
}
