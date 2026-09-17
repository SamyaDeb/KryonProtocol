/**
 * Encoding and receipt decoding for `OrderGateway.settleFillsSigned` (plan §6.3).
 *
 * The gateway settles each fill in its own try/catch: a bad fill emits
 * `FillRejected` and the rest of the batch still lands. So a batch's result
 * always comes from its receipt logs, never from whether the tx succeeded.
 * Server-side only.
 */

import {
  decodeErrorResult,
  encodeFunctionData,
  isHex,
  keccak256,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
  type Log,
} from "viem";

import { ALL_ERRORS_ABI, orderGatewayAbi } from "./contracts";
import type { Order } from "../market/eip712";

/**
 * Batch cap from the gas pass: 40 opening fills ≈ 15.1M gas, half the 30M block
 * limit. The contract allows 64; the matcher stays at 40.
 */
export const MAX_FILLS_PER_BATCH = 40;

export interface SignedFill {
  fillId: Hex;
  maker: Order;
  makerSignature: Hex;
  taker: Order;
  takerSignature: Hex;
  /** 1e18 */
  size: bigint;
  /** 1e18 */
  price: bigint;
}

/** A 32-byte fill id derived from the matcher's off-chain fill id. */
export function fillIdFor(offChainId: string): Hex {
  if (isHex(offChainId) && offChainId.length === 66) return offChainId;
  return keccak256(toHex(offChainId));
}

export function encodeSettleFills(fills: readonly SignedFill[]): Hex {
  if (fills.length === 0) throw new Error("settleFillsSigned needs at least one fill");
  if (fills.length > MAX_FILLS_PER_BATCH) {
    throw new Error(`batch of ${fills.length} exceeds MAX_FILLS_PER_BATCH (${MAX_FILLS_PER_BATCH})`);
  }
  const ids = new Set(fills.map((f) => f.fillId.toLowerCase()));
  if (ids.size !== fills.length) throw new Error("duplicate fillId in batch");
  return encodeFunctionData({ abi: orderGatewayAbi, functionName: "settleFillsSigned", args: [fills] });
}

/** Split fills into batches no larger than the cap, preserving order. */
export function chunkFills<T>(fills: readonly T[], size = MAX_FILLS_PER_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < fills.length; i += size) out.push(fills.slice(i, i + size));
  return out;
}

export interface SettledFill {
  fillId: Hex;
  makerOrderHash: Hex;
  takerOrderHash: Hex;
  marketId: number;
  maker: Address;
  taker: Address;
  takerIsBuy: boolean;
  size: bigint;
  price: bigint;
  /** USDC 1e6; negative is a rebate. */
  makerFee: bigint;
  takerFee: bigint;
  makerTier: number;
  takerTier: number;
  logIndex: number;
}

export interface RejectedFill {
  fillId: Hex;
  reason: Hex;
  /** Decoded error name, e.g. "OrderExpired", or null when unknown. */
  errorName: string | null;
  errorArgs: readonly unknown[];
  logIndex: number;
}

export interface BatchResult {
  settled: SettledFill[];
  rejected: RejectedFill[];
}

/** Decode a revert payload against every Kryon/OZ error plus Error(string)/Panic. */
export function decodeRevert(reason: Hex): { errorName: string | null; errorArgs: readonly unknown[] } {
  if (reason === "0x") return { errorName: null, errorArgs: [] };
  try {
    const decoded = decodeErrorResult({ abi: ALL_ERRORS_ABI, data: reason });
    return { errorName: decoded.errorName, errorArgs: decoded.args ?? [] };
  } catch {
    return { errorName: null, errorArgs: [] };
  }
}

/** Gateway logs from a receipt → settled and rejected fills. */
export function decodeBatchLogs(logs: readonly Log[], gateway: Address): BatchResult {
  const own = logs.filter((l) => l.address.toLowerCase() === gateway.toLowerCase());
  const events = parseEventLogs({
    abi: orderGatewayAbi,
    logs: own as Log[],
    eventName: ["FillSettled", "FillRejected"],
  });
  const result: BatchResult = { settled: [], rejected: [] };
  for (const e of events) {
    const logIndex = e.logIndex ?? -1;
    if (e.eventName === "FillSettled") {
      result.settled.push({ ...e.args, logIndex });
    } else {
      result.rejected.push({ fillId: e.args.fillId, reason: e.args.reason, ...decodeRevert(e.args.reason), logIndex });
    }
  }
  return result;
}

/**
 * Fills in the batch that neither settled nor were rejected. Non-empty means
 * the receipt is not the batch it claims to be; callers treat that as a bug.
 */
export function unaccountedFills(batch: readonly SignedFill[], result: BatchResult): Hex[] {
  const seen = new Set([...result.settled, ...result.rejected].map((f) => f.fillId.toLowerCase()));
  return batch.map((f) => f.fillId).filter((id) => !seen.has(id.toLowerCase()));
}
