import { StrKey } from "@stellar/stellar-sdk";
import { NETWORK } from "@/config";
import type { OrderIntent } from "./order-intent";

const APP_DOMAIN = "kryon.perps";
const MAX_U64 = (1n << 64n) - 1n;

export interface SignedOrderPayload {
  owner: string;
  market_id: number;
  is_long: boolean;
  size: string;
  limit_price: string;
  reduce_only: boolean;
  nonce: string;
  expiry_ts: string;
  signature: string;
}

export interface SignedCancelPayload {
  owner: string;
  nonce: string;
  signature: string;
}

function canonicalPairs(pairs: Array<[string, string | number | boolean]>): string {
  return pairs.map(([k, v]) => `${k}=${String(v)}`).join("\n");
}

/** See `cancelSigningMessage` on the `networkPassphrase` parameter. */
export function orderSigningMessage(
  o: OrderIntent | Omit<SignedOrderPayload, "signature">,
  networkPassphrase: string = NETWORK.passphrase
): string {
  const marketId = "marketId" in o ? o.marketId : o.market_id;
  const limitPrice = "limitPrice" in o ? o.limitPrice.toString() : o.limit_price;
  const reduceOnly = "reduceOnly" in o ? o.reduceOnly : o.reduce_only;
  const expiryTs = "expiryTs" in o ? o.expiryTs.toString() : o.expiry_ts;
  const isLong = "isLong" in o ? o.isLong : o.is_long;

  return canonicalPairs([
    ["domain", APP_DOMAIN],
    ["action", "place_order"],
    ["network", networkPassphrase],
    ["owner", o.owner],
    ["market_id", marketId],
    ["is_long", isLong],
    ["size", o.size.toString()],
    ["limit_price", limitPrice],
    ["reduce_only", reduceOnly],
    ["nonce", o.nonce.toString()],
    ["expiry_ts", expiryTs],
  ]);
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Lowercase hex of the ed25519 public key behind a Stellar G-address. */
export function pubkeyHexFromAddress(address: string): string {
  return toHex(StrKey.decodeEd25519PublicKey(address));
}

/**
 * Canonical settlement message for the on-chain signature-verified settlement
 * path (perp-order-gateway::settle_fill_signed). This MUST byte-match the
 * contract's `order_canonical_bytes`, which is enforced by the cross-language
 * golden test `canonical_digest_matches_offchain_golden` in the gateway crate.
 *
 * Layout (ASCII, '|'-separated):
 *   <domain>|place_order|<pubkey_hex>|<market_id>|<is_long 0/1>|<size>|
 *   <limit_price>|<reduce_only 0/1>|<nonce>|<expiry_ts>
 *
 * `domain` is the value passed to gateway.set_domain (the network passphrase).
 * The wallet signs this via SEP-53 (sha256("Stellar Signed Message:\n" || msg)).
 */
export function orderSettlementMessage(
  domain: string,
  pubkeyHex: string,
  o: Omit<SignedOrderPayload, "signature">,
): string {
  return [
    domain,
    "place_order",
    pubkeyHex,
    o.market_id,
    o.is_long ? 1 : 0,
    o.size,
    o.limit_price,
    o.reduce_only ? 1 : 0,
    o.nonce,
    o.expiry_ts,
  ].join("|");
}

/**
 * `networkPassphrase` binds the signature to one Stellar network, so a message
 * signed for testnet can never be replayed against mainnet. It defaults to the
 * active network, which is correct in the browser — but SERVER callers must
 * pass the requesting network's passphrase explicitly, because on the server
 * `NETWORK` is the deployment's own network, not the caller's.
 */
export function cancelSigningMessage(
  owner: string,
  nonce: bigint | string,
  networkPassphrase: string = NETWORK.passphrase
): string {
  return canonicalPairs([
    ["domain", APP_DOMAIN],
    ["action", "cancel_order"],
    ["network", networkPassphrase],
    ["owner", owner],
    ["nonce", nonce.toString()],
  ]);
}

/**
 * Canonical message for a bulk cancel.
 *
 * Unlike a single cancel there is no nonce to bind the signature to, so a
 * captured signature would otherwise cancel every future order the account
 * places, forever. `issuedAt` bounds that: the server rejects a message whose
 * timestamp is outside a short window, making a captured signature useless
 * within a minute.
 *
 * `marketId` scopes the cancel; the literal string "all" means every market.
 * It is part of the signed bytes so a signature for one market cannot be
 * replayed to wipe the account's whole book.
 */
export function cancelAllSigningMessage(
  owner: string,
  issuedAt: bigint | number | string,
  marketId: number | "all",
  networkPassphrase: string = NETWORK.passphrase
): string {
  return canonicalPairs([
    ["domain", APP_DOMAIN],
    ["action", "cancel_all"],
    ["network", networkPassphrase],
    ["owner", owner],
    ["market_id", String(marketId)],
    ["issued_at", issuedAt.toString()],
  ]);
}

/** How far from the server's clock a `cancel_all` signature stays valid. */
export const CANCEL_ALL_WINDOW_SECONDS = 60;

export function assertU64(n: bigint): boolean {
  return n >= 0n && n <= MAX_U64;
}
