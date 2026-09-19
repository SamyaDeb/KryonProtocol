/**
 * Applying a batch's receipt (plan §4.2.5).
 *
 * A settlement transaction's result is in its logs, never in its status: the
 * gateway settles each fill in its own try/catch, so a batch can succeed with
 * half its fills rejected. Three outcomes per fill, and they are not symmetric:
 *
 *   - **settled** — nothing to do. The indexer owns SETTLED and writes it from
 *     `FillSettled`, together with fees, tiers and the block coordinates. The
 *     matcher's PENDING row is the same row, keyed on the same `fillId`.
 *   - **rejected** — the size must go back on the book now, and why must be
 *     recorded. The matcher writes `rejectReason` and leaves `status` alone;
 *     `book.ts` stops counting a PENDING row once it has a reason, so the size
 *     is free this tick, and the indexer still flips the row to REJECTED when
 *     it reaches the log. A rejection the order can never recover from —
 *     a bad signature, a lapsed expiry, a cancelled nonce — also retires the
 *     order, or the matcher would re-match it forever.
 *   - **unaccounted** — a fill in the batch that neither settled nor was
 *     rejected. That should be impossible; it means the receipt is not the
 *     batch it claims to be. Assume nothing, touch nothing, hand it to the
 *     reconciler.
 *
 * A whole-batch revert is a different thing again: `InsufficientBatchGas` says
 * the batch was too big for the gas it was given, and the answer is to halve
 * it and try again, not to blame any fill.
 *
 * Server-side only.
 */

import { recoverTypedDataAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";

import { decodeRevert, decodeBatchLogs, unaccountedFills, type BatchResult } from "@/lib/chain/settlement";
import { hashOrder, orderTypedData } from "@/lib/market/eip712";
import type { Erc1271Checker } from "@/lib/validation";
import type { Query } from "./db";
import type { PlannedFill } from "./batch";

/** What a rejection means for the two orders behind the fill. */
export type RejectionAction =
  /** Nothing durable is wrong; the fill can be attempted again later. */
  | { kind: "retryable"; reason: string }
  /** One or both orders are finished and must leave the book. */
  | { kind: "poison"; reason: string; status: "CANCELLED" | "EXPIRED" }
  /** The matcher produced a fill the gateway should never have been offered. */
  | { kind: "matcher-bug"; reason: string };

/**
 * Errors that retire an order rather than the fill.
 *
 * `OrderOverfilled` is deliberately not here: it means this matcher's idea of
 * the order's remaining size is behind the chain's, which the indexer fixes on
 * its own. Retiring the order for that would cancel a live order over a
 * bookkeeping lag.
 */
const POISON: Record<string, "CANCELLED" | "EXPIRED"> = {
  InvalidSignature: "CANCELLED",
  OrderCancelled: "CANCELLED",
  NonceReused: "CANCELLED",
  OrderExpired: "EXPIRED",
};

/** Rejections that can only come from the matcher offering an invalid fill. */
const MATCHER_BUGS = new Set([
  "SelfTrade",
  "DirectionMismatch",
  "InvalidConfig",
  "InvalidAmount",
  "FillBelowMinNotional",
  "BatchTooLarge",
  "OnlySelf",
]);

export function classifyRejection(errorName: string | null, raw: Hex): RejectionAction {
  const reason = errorName ?? `unknown revert ${raw.slice(0, 18)}`;
  if (errorName && errorName in POISON) {
    return { kind: "poison", reason, status: POISON[errorName] };
  }
  if (errorName && MATCHER_BUGS.has(errorName)) return { kind: "matcher-bug", reason };
  return { kind: "retryable", reason };
}

/**
 * Which of a fill's two orders a poison rejection belongs to.
 *
 * `FillRejected` carries only the fill id and the revert data, so the matcher
 * has to work out which side was at fault; retiring both would cancel an
 * innocent order. Expiry and nonce are decided from the order itself.
 *
 * A signature is decided the way `OrderLib.isValidSignature` decides it:
 * ECDSA first, then — only for a side that fails it — ERC-1271 against the
 * owner, through the same gas-capped `eth_call` the intake uses. Recovery
 * alone is not enough: a contract wallet's signature (the Insurance backstop's
 * unwind orders, any smart-account order) never recovers to its owner, so
 * blaming on recovery retired a valid order whenever the OTHER side was the
 * invalid one. A check that cannot be completed, or that is not configured,
 * clears the side: a fill is rejected as a whole, and an unanswerable question
 * must not cancel an order that may be perfectly good. The caller counts an
 * unblamed rejection instead of guessing.
 */
export async function blameForPoison(
  fill: PlannedFill,
  action: Extract<RejectionAction, { kind: "poison" }>,
  ctx: {
    nowSec: bigint;
    chainId: number;
    gateway: Address;
    minValidNonce: ReadonlyMap<string, bigint>;
    /** ERC-1271 check for a side ECDSA cannot clear. Absent = cannot decide. */
    erc1271?: Erc1271Checker;
  }
): Promise<Hex[]> {
  const sides: { hash: Hex; order: PlannedFill["maker"]; signature: Hex }[] = [
    { hash: fill.makerOrderHash, order: fill.maker, signature: fill.makerSignature },
    { hash: fill.takerOrderHash, order: fill.taker, signature: fill.takerSignature },
  ];

  if (action.status === "EXPIRED") {
    return sides.filter((s) => s.order.expiry <= ctx.nowSec).map((s) => s.hash);
  }
  if (action.reason === "OrderCancelled") {
    return sides
      .filter((s) => s.order.nonce < (ctx.minValidNonce.get(s.order.owner.toLowerCase()) ?? 0n))
      .map((s) => s.hash);
  }
  if (action.reason === "InvalidSignature") {
    const bad: Hex[] = [];
    for (const s of sides) {
      let ok = false;
      try {
        const signer = await recoverTypedDataAddress({
          ...orderTypedData(ctx.chainId, ctx.gateway, s.order),
          signature: s.signature,
        });
        ok = signer.toLowerCase() === s.order.owner.toLowerCase();
      } catch {
        ok = false;
      }
      if (ok) continue;
      // ECDSA cleared nobody: ask the owner, as the gateway does.
      if (!ctx.erc1271) continue;
      try {
        const digest = hashOrder(ctx.chainId, ctx.gateway, s.order);
        if (!(await ctx.erc1271(s.order.owner, digest, s.signature))) bad.push(s.hash);
      } catch {
        // No answer (timeout, transport, a node that will not run the call).
      }
    }
    return bad;
  }
  // NonceReused: the chain bound this nonce to a different digest, so this
  // order can never fill. Both sides look valid on their own, so neither is
  // singled out; the caller records it and the order ages out at its expiry.
  //
  // A single-nonce `cancelOrder` lands here too, since it moves no
  // `minValidNonce` for this check to see. That is the indexer's to fix: its
  // `OrderCancelled` handler marks exactly the cancelled order, which is more
  // than this function could tell from the fill alone.
  return [];
}

/** Record the reason on a fill without claiming its final status. */
export async function recordRejection(
  q: Query,
  network: string,
  fillId: Hex,
  reason: string
): Promise<void> {
  await q.query(
    `UPDATE "Fill" SET "rejectReason" = $3, "updatedAt" = now()
     WHERE "network" = $1 AND "fillId" = $2 AND "status" = 'PENDING'`,
    [network, fillId.toLowerCase(), reason.slice(0, 500)]
  );
}

/** Retire an order the chain will never settle again. */
export async function retireOrder(
  q: Query,
  network: string,
  orderHash: Hex,
  status: "CANCELLED" | "EXPIRED"
): Promise<boolean> {
  const rows = await q.query(
    `UPDATE "Order" SET "status" = $3::"OrderStatus", "updatedAt" = now()
     WHERE "network" = $1 AND "orderHash" = $2 AND "status" IN ('OPEN', 'PARTIALLY_FILLED')
     RETURNING "orderHash"`,
    [network, orderHash.toLowerCase(), status]
  );
  return rows.length > 0;
}

export interface AppliedBatch {
  settled: Hex[];
  rejected: { fillId: Hex; reason: string; kind: RejectionAction["kind"] }[];
  /** Orders retired because a rejection was terminal for them. */
  retired: { orderHash: Hex; status: "CANCELLED" | "EXPIRED" }[];
  /** Fills in the batch the receipt accounts for neither way. */
  unaccounted: Hex[];
  /** Rejections that could only come from a matcher bug. Non-empty means alert. */
  matcherBugs: { fillId: Hex; reason: string }[];
  /** Signature rejections where neither side could be blamed (contract wallets). */
  unblamed: Hex[];
}

export interface ApplyContext {
  q: Query;
  network: string;
  chainId: number;
  gateway: Address;
  nowSec: bigint;
  minValidNonce: ReadonlyMap<string, bigint>;
  /** Decides a signature ECDSA cannot clear (contract wallets). */
  erc1271?: Erc1271Checker;
}

/**
 * Apply one receipt's logs to the database. Settled fills are left entirely to
 * the indexer; only rejections and the orders behind them are written here.
 */
export async function applyBatchResult(
  ctx: ApplyContext,
  fills: readonly PlannedFill[],
  result: BatchResult
): Promise<AppliedBatch> {
  const byId = new Map(fills.map((f) => [f.fillId.toLowerCase(), f]));
  const applied: AppliedBatch = {
    settled: result.settled.map((s) => s.fillId),
    rejected: [],
    retired: [],
    unaccounted: unaccountedFills(fills, result),
    matcherBugs: [],
    unblamed: [],
  };

  for (const r of result.rejected) {
    const action = classifyRejection(r.errorName, r.reason);
    applied.rejected.push({ fillId: r.fillId, reason: action.reason, kind: action.kind });
    await recordRejection(ctx.q, ctx.network, r.fillId, action.reason);

    if (action.kind === "matcher-bug") {
      applied.matcherBugs.push({ fillId: r.fillId, reason: action.reason });
      continue;
    }
    if (action.kind !== "poison") continue;

    const fill = byId.get(r.fillId.toLowerCase());
    if (!fill) continue; // unaccounted: reported above, not acted on
    const blamed = await blameForPoison(fill, action, {
      nowSec: ctx.nowSec,
      chainId: ctx.chainId,
      gateway: ctx.gateway,
      minValidNonce: ctx.minValidNonce,
      erc1271: ctx.erc1271,
    });
    if (blamed.length === 0) {
      applied.unblamed.push(r.fillId);
      continue;
    }
    for (const orderHash of blamed) {
      if (await retireOrder(ctx.q, ctx.network, orderHash, action.status)) {
        applied.retired.push({ orderHash, status: action.status });
      }
    }
  }

  return applied;
}

/** Decode the batch's own logs out of a receipt. */
export function resultFromReceipt(receipt: TransactionReceipt, gateway: Address): BatchResult {
  return decodeBatchLogs(receipt.logs, gateway);
}

export class InsufficientBatchGasError extends Error {
  constructor(readonly fills: number) {
    super(`settleFillsSigned reverted InsufficientBatchGas with ${fills} fills`);
  }
}

/**
 * Why a batch transaction reverted outright.
 *
 * A receipt carries no revert data, so the call is replayed at the block it
 * was mined in to recover it. When the replay cannot answer, the reason is
 * null and the caller must not assume gas: resizing on an unknown revert would
 * loop forever on a batch that is wrong for some other reason.
 */
export async function revertReasonFor(
  client: Pick<PublicClient, "call">,
  receipt: TransactionReceipt,
  request: { from: Address; to: Address; data: Hex; gas: bigint }
): Promise<{ errorName: string | null; errorArgs: readonly unknown[] }> {
  try {
    await client.call({
      account: request.from,
      to: request.to,
      data: request.data,
      gas: request.gas,
      blockNumber: receipt.blockNumber,
    });
    return { errorName: null, errorArgs: [] };
  } catch (err) {
    const data = revertDataOf(err);
    return data ? decodeRevert(data) : { errorName: null, errorArgs: [] };
  }
}

function revertDataOf(err: unknown): Hex | null {
  let node: unknown = err;
  for (let depth = 0; node && depth < 8; depth++) {
    const candidate = (node as { data?: unknown }).data;
    if (typeof candidate === "string" && candidate.startsWith("0x")) return candidate as Hex;
    if (typeof candidate === "object" && candidate !== null) {
      const inner = (candidate as { data?: unknown }).data;
      if (typeof inner === "string" && inner.startsWith("0x")) return inner as Hex;
    }
    node = (node as { cause?: unknown }).cause;
  }
  return null;
}
