// Server-side input validation for order intake. Keeps malformed / abusive
// payloads out of the DB and the matcher. Pure functions — no I/O.

import { StrKey } from "@stellar/stellar-sdk";
import { ACTIVE_MARKETS, AMOUNT_PRECISION, PRICE_PRECISION } from "@/config";
import { assertU64, orderSettlementMessage, pubkeyHexFromAddress } from "@/lib/market/signing-message";
import { verifySignedMessage } from "@/lib/market/signed-intent";

const VALID_MARKET_IDS = new Set(Object.values(ACTIVE_MARKETS).map((m) => m.marketId));

// Sane absolute bounds (defence-in-depth; on-chain checks are authoritative).
const MAX_SIZE = 1_000_000_000n * AMOUNT_PRECISION;     // 1e9 units
const MAX_PRICE = 10_000_000n * PRICE_PRECISION;        // $10M
const MAX_TTL_SECONDS = 7n * 24n * 3600n;               // 7 days
const MIN_TTL_SECONDS = 5n;                             // reject already-racy orders

export interface ValidatedOrder {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  reduceOnly: boolean;
  nonce: bigint;
  expiryTs: bigint;
}

export type ValidationResult =
  | { ok: true; order: ValidatedOrder }
  | { ok: false; error: string };

function parseBigInt(v: unknown): bigint | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  try {
    const s = String(v).trim();
    if (!/^-?\d+$/.test(s)) return null;
    return BigInt(s);
  } catch {
    return null;
  }
}

/**
 * @param networkPassphrase The passphrase of the network the CALLER selected,
 *   from `networkFromRequest(req)`. Required rather than defaulted on purpose:
 *   this runs on the server, where the module-scope `NETWORK` is the
 *   deployment's own network. Defaulting to it would verify a testnet-signed
 *   order against the mainnet passphrase (and vice versa), rejecting every
 *   order on the non-primary venue — or, worse, accepting a signature intended
 *   for the other network. Making it required means the compiler catches any
 *   new call site that forgets.
 */
export function validateOrderIntent(body: unknown, networkPassphrase: string): ValidationResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Body must be an object" };
  const b = body as Record<string, unknown>;

  // Owner — must be a valid Stellar public key.
  if (typeof b.owner !== "string" || !StrKey.isValidEd25519PublicKey(b.owner)) {
    return { ok: false, error: "Invalid owner address" };
  }

  // Market — must be a known, configured market.
  const marketId = Number(b.market_id);
  if (!Number.isInteger(marketId) || !VALID_MARKET_IDS.has(marketId)) {
    return { ok: false, error: "Unknown market_id" };
  }

  if (typeof b.is_long !== "boolean") return { ok: false, error: "is_long must be boolean" };
  if (typeof b.reduce_only !== "boolean") return { ok: false, error: "reduce_only must be boolean" };

  // Size — positive, within bounds.
  const size = parseBigInt(b.size);
  if (size === null || size <= 0n) return { ok: false, error: "size must be a positive integer" };
  if (size > MAX_SIZE) return { ok: false, error: "size exceeds maximum" };

  // Limit price — must be strictly positive.
  //
  // Zero used to be accepted here as a "market order" sentinel, and the matcher
  // still has a code path keyed on it. But the gateway's `validate_order`
  // rejects `limit_price <= 0` outright, so such an order can match off-chain
  // and then NEVER settle: the matcher loops match -> sim-fail -> rollback on it
  // every tick until it expires, holding book depth the whole time. That is the
  // same class of bug as accepting a signature scheme the chain won't verify —
  // an order in the book whose settlement is impossible by construction.
  //
  // Market orders are expressed the way the UI already expresses them: an
  // aggressive limit that crosses the book immediately (2x mark to buy, half to
  // sell). The on-chain execution band still caps the price actually filled, so
  // an aggressive limit is a crossing instruction, not a blank cheque.
  const limitPrice = parseBigInt(b.limit_price);
  if (limitPrice === null || limitPrice <= 0n) {
    return {
      ok: false,
      error:
        "limit_price must be a positive integer; for a market order send an " +
        "aggressive crossing limit (e.g. 2x mark to buy, 0.5x to sell) rather than 0",
    };
  }
  if (limitPrice > MAX_PRICE) return { ok: false, error: "limit_price exceeds maximum" };

  // Nonce — uint64, matching the contract ABI.
  const nonce = parseBigInt(b.nonce);
  if (nonce === null || !assertU64(nonce)) return { ok: false, error: "nonce must be a uint64 integer" };

  // Expiry — must be in the future and not absurdly far out. Non-expiring
  // off-chain orders are not acceptable for mainnet perps.
  const expiryTs = parseBigInt(b.expiry_ts);
  if (expiryTs === null || !assertU64(expiryTs)) return { ok: false, error: "expiry_ts must be a uint64 integer" };
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (expiryTs <= nowSec + MIN_TTL_SECONDS) return { ok: false, error: "expiry_ts is too soon" };
  if (expiryTs > nowSec + MAX_TTL_SECONDS) return { ok: false, error: "expiry_ts too far in the future" };

  if (typeof b.signature !== "string" || b.signature.length > 256) {
    return { ok: false, error: "Missing order signature" };
  }
  const signed = {
    owner: b.owner,
    market_id: marketId,
    is_long: b.is_long,
    size: size.toString(),
    limit_price: limitPrice.toString(),
    reduce_only: b.reduce_only,
    nonce: nonce.toString(),
    expiry_ts: expiryTs.toString(),
  };
  const pubkeyHex = pubkeyHexFromAddress(b.owner);
  if (!verifySignedMessage(b.owner, orderSettlementMessage(networkPassphrase, pubkeyHex, signed), b.signature)) {
    return { ok: false, error: "Invalid order signature" };
  }

  return {
    ok: true,
    order: { owner: b.owner, marketId, isLong: b.is_long, size, limitPrice, reduceOnly: b.reduce_only, nonce, expiryTs },
  };
}
