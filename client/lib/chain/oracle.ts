/**
 * OracleAdapter reads and the `pushPrices` payload. Prices are 1e18.
 */

import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";

import { oracleAdapterAbi } from "./contracts";
import { oracleId } from "./networks";

export interface OracleSnapshot {
  price: bigint;
  confidence: bigint;
  /** Unix seconds, as reported by the publishers. */
  publishTime: number;
  /** Block timestamp of the write. */
  writeTime: number;
  source: number;
  sourceCount: number;
}

/**
 * The latest aggregated price for `symbol`, or null when none has been
 * written. `symbol` is required: a default here once showed one market's
 * price on every other market.
 */
export async function readOraclePrice(
  client: Pick<PublicClient, "readContract">,
  adapter: Address,
  symbol: string
): Promise<OracleSnapshot | null> {
  const s = await client.readContract({
    address: adapter,
    abi: oracleAdapterAbi,
    functionName: "latest",
    args: [oracleId(symbol)],
  });
  if (s.price === 0n && s.writeTime === 0n) return null;
  return {
    price: s.price,
    confidence: s.confidence,
    publishTime: Number(s.publishTime),
    writeTime: Number(s.writeTime),
    source: s.source,
    sourceCount: s.sourceCount,
  };
}

export interface PriceUpdate {
  symbol: string;
  /** 1e18, > 0 */
  price: bigint;
  /** 1e18, >= 0 */
  confidence: bigint;
}

/** Calldata for one `pushPrices` batch. `publishTime` must not be in the future on-chain. */
export function encodePushPrices(updates: readonly PriceUpdate[], publishTime: number): Hex {
  if (updates.length === 0) throw new Error("pushPrices needs at least one update");
  const symbols = new Set(updates.map((u) => u.symbol));
  if (symbols.size !== updates.length) throw new Error("duplicate symbol in pushPrices batch");
  for (const u of updates) {
    if (u.price <= 0n) throw new Error(`non-positive price for ${u.symbol}`);
    if (u.confidence < 0n) throw new Error(`negative confidence for ${u.symbol}`);
  }
  return encodeFunctionData({
    abi: oracleAdapterAbi,
    functionName: "pushPrices",
    args: [
      updates.map((u) => oracleId(u.symbol)),
      updates.map((u) => u.price),
      updates.map((u) => u.confidence),
      BigInt(publishTime),
    ],
  });
}
