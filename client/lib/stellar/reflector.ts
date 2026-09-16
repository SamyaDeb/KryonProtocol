// Reflector "External CEX & DEX" oracle — SEP-40 read-only client.
//
// Reflector is NOT Kryon's mark price and must never become one: its feeds
// refresh on a 300s `resolution`, while the on-chain OracleGuard enforces
// max_oracle_age_secs = 120. A 5-minute mark would spend most of its life
// outside that window, and widening the guard to accommodate it would mean
// liquidating traders against a five-minute-old price.
//
// It is used instead as a fourth, INDEPENDENT cross-check on the keeper's
// 3-source CEX median (see scripts/oracle-keeper.ts): if the two diverge
// beyond REFLECTOR_DIVERGENCE_HALT_BPS, the keeper stops publishing that
// market and the on-chain staleness guard fail-stops settlement. An attacker
// who moves Binance, Coinbase and Kraken together still has to move
// Reflector's independent node consensus to land a bad mark. Cost: one
// simulate-read per tick, zero gas.
//
// Coverage (verified live 2026-08-22, identical on mainnet and testnet):
//   BTC ETH USDT XRP SOL USDC ADA AVAX DOT MATIC LINK DAI ATOM XLM UNI EURC
// BNB and TRX are absent — markets without a `reflectorSymbol` skip the guard.

import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { simulateRead } from "./simulate";
import { NETWORK, PRICE_PRECISION } from "@/config";

// Reflector quotes at 1e14; Kryon's internal precision is 1e18.
const REFLECTOR_DECIMALS = 14n;
const REFLECTOR_SCALE = PRICE_PRECISION / 10n ** REFLECTOR_DECIMALS; // 1e4

export const REFLECTOR_CONTRACT_MAINNET = "CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN";
export const REFLECTOR_CONTRACT_TESTNET = "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";

/** Explicit override wins; otherwise pick by the configured Stellar network. */
export function reflectorContractId(): string {
  return (
    process.env.REFLECTOR_CONTRACT_ID ||
    (NETWORK.name === "mainnet" ? REFLECTOR_CONTRACT_MAINNET : REFLECTOR_CONTRACT_TESTNET)
  );
}

export interface ReflectorPrice {
  /** 1e18 precision, normalized from Reflector's native 1e14. */
  price: bigint;
  /** Unix seconds of the Reflector round this price belongs to. */
  timestamp: number;
}

/**
 * `lastprice(Asset::Other(symbol))`. Returns null when the feed is absent, the
 * asset is unknown to Reflector, or the RPC read fails — every one of which
 * the caller must treat as "no cross-check available", never as agreement.
 */
export async function reflectorLastPrice(symbol: string): Promise<ReflectorPrice | null> {
  try {
    // Asset::Other(Symbol) — an enum variant encodes as a vec of [tag, value].
    const assetArg = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Other"),
      nativeToScVal(symbol, { type: "symbol" }),
    ]);

    const val = await simulateRead(reflectorContractId(), "lastprice", [assetArg]);
    if (!val) return null;

    // Option<PriceData>::None comes back as ScVoid.
    if (val.switch().name === "scvVoid") return null;

    const native = scValToNative(val) as Record<string, unknown> | null;
    if (!native) return null;

    const raw = native["price"];
    const timestamp = native["timestamp"];
    if (raw === undefined || raw === null) return null;

    const price = BigInt(String(raw)) * REFLECTOR_SCALE;
    if (price <= 0n) return null;

    // Reflector stamps rounds in milliseconds; normalize to unix seconds.
    const tsRaw = Number(timestamp ?? 0);
    const ts = tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : tsRaw;

    return { price, timestamp: ts };
  } catch {
    return null;
  }
}

/** Absolute divergence between two 1e18 prices, in basis points of `ref`. */
export function divergenceBps(price: bigint, ref: bigint): number {
  if (ref <= 0n) return 0;
  const diff = price > ref ? price - ref : ref - price;
  return Number((diff * 10_000n) / ref);
}
