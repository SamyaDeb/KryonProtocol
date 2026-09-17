/**
 * External reference prices from Chainlink Data Feeds (plan §7 step 3).
 *
 * The oracle keeper halts its own pushes when Kryon's CEX median diverges from
 * the reference by more than the configured threshold. Feed proxy addresses
 * come from infra/deploy/environments/arc-*.toml (sources in docs/arc-facts.md);
 * none are hardcoded here.
 */

import { parseAbi, type Address, type PublicClient } from "viem";

export const aggregatorV3Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export interface ReferencePrice {
  /** Scaled to 1e18. */
  price: bigint;
  /** Unix seconds of the feed's last update. */
  updatedAt: number;
  roundId: bigint;
}

/** Scale an answer with `decimals` to 1e18. Checked: rejects decimals above 18. */
export function scaleTo1e18(answer: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`unsupported feed decimals ${decimals}`);
  }
  return answer * 10n ** BigInt(18 - decimals);
}

/**
 * The feed's latest answer, or null when it is non-positive, incomplete, or
 * older than `maxAgeSeconds`. Chainlink heartbeats on Arc are 24h, so a
 * reference is a sanity bound, not a mark price.
 */
export async function readReferencePrice(
  client: Pick<PublicClient, "multicall">,
  feed: Address,
  maxAgeSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<ReferencePrice | null> {
  const [decimals, round] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: feed, abi: aggregatorV3Abi, functionName: "decimals" },
      { address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" },
    ],
  });
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  if (answer <= 0n || updatedAt === 0n || answeredInRound < roundId) return null;
  if (nowSeconds - Number(updatedAt) > maxAgeSeconds) return null;
  return { price: scaleTo1e18(answer, decimals), updatedAt: Number(updatedAt), roundId };
}

/** Absolute divergence between two 1e18 prices, in basis points of `ref` (rounded down). */
export function divergenceBps(price: bigint, ref: bigint): number {
  if (ref <= 0n) return 0;
  const diff = price > ref ? price - ref : ref - price;
  return Number((diff * 10_000n) / ref);
}
