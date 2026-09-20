/**
 * Signing and sending orders and cancels from the browser.
 *
 * Orders are EIP-712 typed data signed by the wallet and posted to
 * `/api/orders`; nothing is sent on chain until the matcher settles a fill.
 * The domain comes from `/api/config`, the same deployment record the intake
 * verifies against, so a UI signature is exactly one the API accepts.
 *
 * Cancels come in two strengths:
 *   - signed off-chain cancel (`/api/orders/cancel`, `/cancel-all`): free and
 *     instant, but BEST-EFFORT. It stops the matcher; it does not invalidate
 *     the signature on chain.
 *   - on-chain `cancelUpTo(nonce)` (sent by the wallet, not here): costs gas,
 *     and is AUTHORITATIVE: every order below the nonce is dead for good.
 *
 * `sign` is the wallet's `signTypedData`, passed in so this module needs no
 * React and can be tested with a local account.
 */

import type { Address, Hex, TypedDataDomain } from "viem";

import { CANCEL_TYPES, ORDER_TYPES, type Order } from "@/lib/market/eip712";

/** `CancelAll(address owner, uint32 marketId, uint64 deadline)`: API-only, never valid on chain. */
export const CANCEL_ALL_TYPES = {
  CancelAll: [
    { name: "owner", type: "address" },
    { name: "marketId", type: "uint32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

/** `OrderGateway.MAX_ORDER_TTL`: an order may live at most seven days. */
export const MAX_ORDER_TTL_SECONDS = 7n * 24n * 3600n;
/** The API keeps a replayable cancel-all short (≤ 300s); two minutes leaves room for clock skew. */
const CANCEL_ALL_WINDOW_SECONDS = 120n;
const CANCEL_WINDOW_SECONDS = 300n;

export type Domain = TypedDataDomain & { chainId: number; verifyingContract: Address };

/** What wagmi's `signTypedDataAsync` accepts, narrowed to what is used here. */
export type SignTypedData = (args: {
  domain: Domain;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}) => Promise<Hex>;

export type Outcome<T = object> = ({ ok: true } & T) | { ok: false; code: string; message: string };

/** Plain-language text for the intake's rejection codes (lib/validation.ts). */
export const REJECTION_TEXT: Record<string, string> = {
  bad_signature: "The signature did not verify. Sign again from the connected wallet.",
  expired: "The order expired before it arrived. Check your computer's clock and try again.",
  expiry_too_far: "Orders can last at most seven days.",
  wrong_chain: "The wallet signed for a different network. Switch networks and sign again.",
  unknown_market: "This market does not exist on this network.",
  market_inactive: "This market is paused and accepts no new orders.",
  market_not_configured: "This market is not configured yet.",
  nonce_cancelled: "This order's nonce was cancelled on chain. Place a new order.",
  nonce_reused: "That nonce is already used by another order. Try again.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  unavailable: "Order entry is not available right now.",
  internal: "The order service had a problem. Nothing was placed; try again.",
  overflow: "The size or price is too large.",
  invalid_field: "The order was malformed.",
  invalid_body: "The order was malformed.",
  body_too_large: "The order was malformed.",
};

export function rejectionText(code: string, fallback?: string): string {
  return REJECTION_TEXT[code] ?? fallback ?? "The order was rejected.";
}

/**
 * Nonces are the owner's to choose; they only have to be unused and at or
 * above the on-chain `minNonce` floor. Millisecond timestamps are unique per
 * device and keep increasing, so a later `cancelUpTo(now)` covers every
 * earlier order. `last` guards two orders in the same millisecond.
 */
export function allocateNonce(opts: { minNonce: bigint; last: bigint; nowMs: number }): bigint {
  const candidates = [opts.minNonce, opts.last + 1n, BigInt(opts.nowMs)];
  return candidates.reduce((a, b) => (a > b ? a : b));
}

export function orderExpiry(nowSec: bigint, ttlSeconds: bigint): bigint {
  const ttl = ttlSeconds > MAX_ORDER_TTL_SECONDS ? MAX_ORDER_TTL_SECONDS : ttlSeconds;
  return nowSec + ttl;
}

async function post(path: string, body: unknown, fetcher: typeof fetch): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetcher(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error page */
  }
  return { status: res.status, json };
}

function failure(status: number, json: Record<string, unknown>): Outcome<never> {
  const code = typeof json.code === "string" ? json.code : status === 429 ? "rate_limited" : "internal";
  return { ok: false, code, message: rejectionText(code, typeof json.error === "string" ? json.error : undefined) };
}

/** Sign an order and submit it. `path` carries the network (`apiPath`). */
export async function placeOrder(opts: {
  domain: Domain;
  order: Order;
  sign: SignTypedData;
  path: string;
  fetcher?: typeof fetch;
}): Promise<Outcome<{ orderHash: string; duplicate: boolean }>> {
  const { domain, order, sign, path, fetcher = fetch } = opts;
  const signature = await sign({ domain, types: ORDER_TYPES, primaryType: "Order", message: { ...order } });
  const { status, json } = await post(path, { ...order, signature, chainId: domain.chainId }, fetcher);
  if (json.ok === true && typeof json.orderHash === "string") {
    return { ok: true, orderHash: json.orderHash, duplicate: json.duplicate === true };
  }
  return failure(status, json);
}

/** Best-effort off-chain cancel of one order by nonce. */
export async function cancelOrder(opts: {
  domain: Domain;
  owner: Address;
  nonce: bigint;
  nowSec: bigint;
  sign: SignTypedData;
  path: string;
  fetcher?: typeof fetch;
}): Promise<Outcome> {
  const message = { owner: opts.owner, nonce: opts.nonce, deadline: opts.nowSec + CANCEL_WINDOW_SECONDS };
  const signature = await opts.sign({ domain: opts.domain, types: CANCEL_TYPES, primaryType: "Cancel", message });
  const { status, json } = await post(opts.path, { ...message, signature }, opts.fetcher ?? fetch);
  return json.ok === true ? { ok: true } : failure(status, json);
}

/** Best-effort off-chain cancel of every working order (marketId 0 = all markets). */
export async function cancelAllOrders(opts: {
  domain: Domain;
  owner: Address;
  marketId: number;
  nowSec: bigint;
  sign: SignTypedData;
  path: string;
  fetcher?: typeof fetch;
}): Promise<Outcome<{ cancelled: number }>> {
  const message = { owner: opts.owner, marketId: opts.marketId, deadline: opts.nowSec + CANCEL_ALL_WINDOW_SECONDS };
  const signature = await opts.sign({ domain: opts.domain, types: CANCEL_ALL_TYPES, primaryType: "CancelAll", message });
  const { status, json } = await post(opts.path, { ...message, signature }, opts.fetcher ?? fetch);
  if (json.ok === true) return { ok: true, cancelled: typeof json.cancelled === "number" ? json.cancelled : 0 };
  return failure(status, json);
}
