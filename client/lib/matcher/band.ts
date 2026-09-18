/**
 * The execution band (plan §4.2.2).
 *
 * `Engine.applyFill` reads the index price and reverts `PriceOutsideBand` for
 * any fill more than `maxExecutionDeviationBps` away from it. A match outside
 * the band is therefore not a trade but a guaranteed `FillRejected`, paid for
 * in gas. The matcher applies the same test before building a batch.
 *
 * It reads the price through `OracleAdapter.getPrice(id, maxAge, maxConfBps)`
 * — the exact call `Engine._indexPrice` makes — rather than `latest()`, so the
 * staleness and confidence checks are the contract's own. A stale feed makes
 * that call revert, and the matcher skips the market for the tick instead of
 * building a batch that cannot settle.
 *
 * Server-side only.
 */

import type { Address, PublicClient } from "viem";

import { oracleAdapterAbi } from "@/lib/chain/contracts";
import type { EngineMatch } from "@/lib/market/matching-engine";
import type { MarketConfig } from "./book";

const BPS = 10_000n;

export interface IndexPrice {
  /** 1e18. */
  price: bigint;
  /** 1e18. */
  confidence: bigint;
  publishTime: number;
  writeTime: number;
  sourceCount: number;
}

export class OracleUnavailableError extends Error {
  constructor(symbol: string, readonly cause: unknown) {
    super(`no usable index price for ${symbol}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * The index price the Engine would use for this market, on the caller's block.
 * Throws `OracleUnavailableError` when the adapter rejects the feed as stale
 * or too wide — the same condition that would revert every fill.
 */
export async function readIndexPrice(
  client: Pick<PublicClient, "readContract">,
  adapter: Address,
  market: MarketConfig
): Promise<IndexPrice> {
  try {
    const snap = await client.readContract({
      address: adapter,
      abi: oracleAdapterAbi,
      functionName: "getPrice",
      args: [market.oracleId, market.maxOracleAge, market.maxOracleConfidenceBps],
    });
    if (snap.price <= 0n) throw new Error(`index price is ${snap.price}`);
    return {
      price: snap.price,
      confidence: snap.confidence,
      publishTime: Number(snap.publishTime),
      writeTime: Number(snap.writeTime),
      sourceCount: snap.sourceCount,
    };
  } catch (err) {
    throw new OracleUnavailableError(market.symbol, err);
  }
}

export interface Band {
  index: bigint;
  low: bigint;
  high: bigint;
}

/** `[index - index*bps/1e4, index + index*bps/1e4]`, as `Engine.applyFill` computes it. */
export function bandFor(index: bigint, maxExecutionDeviationBps: number): Band {
  const delta = (index * BigInt(maxExecutionDeviationBps)) / BPS;
  return { index, low: index - delta, high: index + delta };
}

export function withinBand(price: bigint, band: Band): boolean {
  return price >= band.low && price <= band.high;
}

export interface BandFilterResult {
  kept: EngineMatch[];
  /** Matches dropped because the Engine would have reverted `PriceOutsideBand`. */
  dropped: EngineMatch[];
  band: Band;
}

/** Drop the matches the Engine would refuse. */
export function filterByBand(
  matches: readonly EngineMatch[],
  index: bigint,
  maxExecutionDeviationBps: number
): BandFilterResult {
  const band = bandFor(index, maxExecutionDeviationBps);
  const kept: EngineMatch[] = [];
  const dropped: EngineMatch[] = [];
  for (const m of matches) (withinBand(m.price, band) ? kept : dropped).push(m);
  return { kept, dropped, band };
}
