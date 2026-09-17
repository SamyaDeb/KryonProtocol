/**
 * Turning matches into settleable batches (plan §4.2.3).
 *
 * A batch is `SignedFill[]`: both signed orders, both signatures, the size and
 * the price. The fill id is derived, not allocated —
 *
 *     keccak256(abi.encode(makerOrderHash, takerOrderHash, size, price, sequence))
 *
 * — so a retry after a crash regenerates the identical id and the
 * `(network, fillId)` unique key makes the re-insert a no-op instead of a
 * second fill. `sequence` disambiguates the rare case where the same pair
 * trades the same size at the same price more than once: it counts the `Fill`
 * rows already recorded for that shape, so it is stable across a replay of the
 * same state but advances after a rejected fill is re-matched.
 *
 * Gas: the gateway needs `MIN_GAS_PER_FILL` (900k) available at the top of
 * every fill, or it reverts `InsufficientBatchGas` for the whole batch.
 * `eth_estimateGas` accounts for that tail, so an estimate is authoritative;
 * what it cannot tell us is whether the batch is an antisocial share of the
 * block, which is what `MAX_BATCH_GAS` is for.
 *
 * Server-side only.
 */

import { encodeAbiParameters, keccak256, type Address, type Hex, type PublicClient } from "viem";

import { MAX_FILLS_PER_BATCH, chunkFills, encodeSettleFills, type SignedFill } from "@/lib/chain/settlement";
import type { EngineMatch } from "@/lib/market/matching-engine";
import type { Query } from "./db";
import { loadSignedOrders, type SignedOrderRow } from "./book";

/** `OrderGateway.MIN_GAS_PER_FILL`. */
export const MIN_GAS_PER_FILL = 900_000n;

/** Arc's fixed block gas limit. */
export const BLOCK_GAS_LIMIT = 30_000_000n;

/**
 * The most gas one settlement transaction may *use*: 60% of a block.
 *
 * The cap that matters is `MAX_FILLS_PER_BATCH` (40), measured at ~15.2M — a
 * shade over half the block. This budget sits above that so a full 40-fill
 * batch is not split on every tick, while still refusing a batch that would
 * take a block to itself. It is compared against the estimate, not against the
 * limit the transaction is signed with: the headroom is slack the block never
 * pays for, so counting it here would split batches that fit.
 */
export const MAX_BATCH_GAS = (BLOCK_GAS_LIMIT * 60n) / 100n;

/** Below this many fills, a batch is not split further even if it looks heavy. */
export const MIN_BATCH_FILLS = 1;

export interface PlannedFill extends SignedFill {
  marketId: number;
  makerOrderHash: Hex;
  takerOrderHash: Hex;
  /** True when the taker is the buy side, as `FillSettled` reports it. */
  takerIsBuy: boolean;
  /** 1e18. */
  notional: bigint;
}

/** `keccak256(abi.encode(bytes32,bytes32,uint256,uint256,uint256))`. */
export function deriveFillId(
  makerOrderHash: Hex,
  takerOrderHash: Hex,
  size: bigint,
  price: bigint,
  sequence: bigint
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [makerOrderHash, takerOrderHash, size, price, sequence]
    )
  );
}

export class MissingOrderError extends Error {
  constructor(readonly orderHash: Hex) {
    super(`order ${orderHash} is matched but not in the database`);
  }
}

function toOrder(row: SignedOrderRow) {
  return {
    owner: row.owner,
    marketId: row.marketId,
    isLong: row.isLong,
    size: row.size,
    limitPrice: row.limitPrice,
    reduceOnly: row.reduceOnly,
    nonce: row.nonce,
    expiry: row.expiry,
    referrer: row.referrer,
  };
}

/**
 * How many `Fill` rows already exist for each (maker, taker, size, price)
 * shape, so `sequence` starts above them. Counting rows in any status — a
 * rejected fill that gets re-matched must not reuse its id, because the row is
 * still there under the unique key.
 */
export async function priorFillCounts(
  q: Query,
  network: string,
  matches: readonly EngineMatch[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (matches.length === 0) return out;
  const makers = matches.map((m) => m.maker.orderHash);
  const takers = matches.map((m) => m.taker.orderHash);
  const rows = await q.query(
    `SELECT "makerOrderHash", "takerOrderHash", "size"::text AS size, "price"::text AS price, COUNT(*)::int AS n
     FROM "Fill"
     WHERE "network" = $1 AND "makerOrderHash" = ANY($2::text[]) AND "takerOrderHash" = ANY($3::text[])
     GROUP BY 1, 2, 3, 4`,
    [network, [...new Set(makers)], [...new Set(takers)]]
  );
  for (const r of rows) {
    out.set(shapeKey(String(r.makerOrderHash) as Hex, String(r.takerOrderHash) as Hex, BigInt(String(r.size)), BigInt(String(r.price))), Number(r.n));
  }
  return out;
}

function shapeKey(maker: Hex, taker: Hex, size: bigint, price: bigint): string {
  return `${maker}:${taker}:${size}:${price}`;
}

/**
 * Matches → fills, with ids, the signed orders attached and duplicates
 * dropped. Order is preserved, so the batch is a deterministic function of the
 * matches.
 */
export async function buildFills(
  q: Query,
  network: string,
  matches: readonly EngineMatch[]
): Promise<PlannedFill[]> {
  if (matches.length === 0) return [];
  const hashes = matches.flatMap((m) => [m.maker.orderHash, m.taker.orderHash]);
  const [orders, prior] = await Promise.all([
    loadSignedOrders(q, network, hashes),
    priorFillCounts(q, network, matches),
  ]);

  const seen = new Set<string>();
  const out: PlannedFill[] = [];
  for (const m of matches) {
    const maker = orders.get(m.maker.orderHash);
    const taker = orders.get(m.taker.orderHash);
    if (!maker) throw new MissingOrderError(m.maker.orderHash);
    if (!taker) throw new MissingOrderError(m.taker.orderHash);

    const key = shapeKey(m.maker.orderHash, m.taker.orderHash, m.size, m.price);
    const sequence = BigInt((prior.get(key) ?? 0) + m.sequence);
    const fillId = deriveFillId(m.maker.orderHash, m.taker.orderHash, m.size, m.price, sequence);
    // `encodeSettleFills` rejects a duplicate id anyway; catching it here keeps
    // the rest of the batch instead of losing the whole tick to one collision.
    if (seen.has(fillId.toLowerCase())) continue;
    seen.add(fillId.toLowerCase());

    out.push({
      fillId,
      maker: toOrder(maker),
      makerSignature: maker.signature,
      taker: toOrder(taker),
      takerSignature: taker.signature,
      size: m.size,
      price: m.price,
      marketId: maker.marketId,
      makerOrderHash: m.maker.orderHash,
      takerOrderHash: m.taker.orderHash,
      takerIsBuy: taker.isLong,
      notional: m.notional,
    });
  }
  return out;
}

export interface SizedBatch {
  fills: PlannedFill[];
  /** The gas limit to send with, estimate plus headroom. */
  gas: bigint;
  /** The raw `eth_estimateGas` result, for the gas metrics. */
  estimate: bigint;
}

export type GasEstimator = (fills: readonly PlannedFill[]) => Promise<bigint>;

/** `eth_estimateGas` for one `settleFillsSigned` batch from the operator key. */
export function chainGasEstimator(
  client: Pick<PublicClient, "estimateGas">,
  gateway: Address,
  operator: Address
): GasEstimator {
  return async (fills) =>
    client.estimateGas({ account: operator, to: gateway, data: encodeSettleFills(fills) });
}

/**
 * Split matches into batches that fit both the fill cap and the gas budget.
 *
 * The first split is by `MAX_FILLS_PER_BATCH`; anything still over
 * `maxBatchGas` is halved and re-estimated, down to `MIN_BATCH_FILLS`. A
 * single fill that will not fit is returned anyway with the estimate attached:
 * the caller logs it and lets the chain give the real answer, because refusing
 * to send it silently would wedge the market.
 */
export async function sizeBatches(
  fills: readonly PlannedFill[],
  estimate: GasEstimator,
  options: { maxBatchGas?: bigint; headroomPercent?: bigint; maxFills?: number; minBatchFills?: number } = {}
): Promise<SizedBatch[]> {
  const maxBatchGas = options.maxBatchGas ?? MAX_BATCH_GAS;
  const headroomPercent = options.headroomPercent ?? 120n;
  const maxFills = options.maxFills ?? MAX_FILLS_PER_BATCH;
  const minBatchFills = options.minBatchFills ?? MIN_BATCH_FILLS;

  const out: SizedBatch[] = [];
  const queue = chunkFills(fills, maxFills);
  while (queue.length > 0) {
    const chunk = queue.shift()!;
    if (chunk.length === 0) continue;
    const used = await estimate(chunk);
    const gas = withHeadroom(used, headroomPercent);
    if (used > maxBatchGas && chunk.length > minBatchFills) {
      const half = Math.ceil(chunk.length / 2);
      queue.unshift(chunk.slice(0, half), chunk.slice(half));
      continue;
    }
    out.push({ fills: chunk, gas, estimate: used });
  }
  return out;
}

/**
 * How to retry a batch that reverted `InsufficientBatchGas`.
 *
 * The revert says the batch was too big for the gas it was given, and says
 * nothing about any individual fill — so the answer is to halve and re-estimate,
 * not to blame a fill. An empty result means the batch is already at the floor
 * and retrying the same shape would just loop: the caller logs and moves on.
 */
export function halveAfterGasRevert<T>(fills: readonly T[], minBatchFills = MIN_BATCH_FILLS): T[][] {
  if (fills.length <= minBatchFills || fills.length < 2) return [];
  const half = Math.ceil(fills.length / 2);
  return [fills.slice(0, half), fills.slice(half)].filter((part) => part.length > 0);
}

/**
 * Estimate plus headroom, never below the gateway's per-fill floor. The floor
 * matters on a resize after `InsufficientBatchGas`, where the estimate came
 * from a chain state that has since moved.
 */
export function withHeadroom(estimate: bigint, percent: bigint): bigint {
  const bumped = (estimate * percent) / 100n;
  return bumped < MIN_GAS_PER_FILL ? MIN_GAS_PER_FILL : bumped;
}

export { MAX_FILLS_PER_BATCH, chunkFills, encodeSettleFills };
export type { SignedFill };
