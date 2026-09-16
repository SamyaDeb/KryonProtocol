"use client";

// Order intent — builds a signed Order struct for submission to the off-chain matcher.
// The matcher pairs maker+taker, queues settle_fill, and users sign Soroban
// auth entries before settlement is submitted on-chain.

export interface OrderIntent {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;       // i128 in AMOUNT_PRECISION (1e7)
  limitPrice: bigint; // i128 in PRICE_PRECISION (1e18)
  reduceOnly: boolean;
  nonce: bigint;
  expiryTs: bigint;   // unix seconds
}

// Nonce uniqueness is GLOBAL PER ACCOUNT, not per market: the DB enforces
// Order @@unique([owner, nonce]) and the gateway keys Filled(owner, nonce) /
// Cancelled(owner, nonce) the same way (perp-order-gateway/src/lib.rs).
//
// A bare Date.now() is millisecond-resolution, so a trader placing orders in
// two markets inside the same millisecond — routine once a quoting bot works
// eight books — collides. Off-chain that is a unique-constraint error; ON-CHAIN
// it means two different orders sharing one fill counter, so filling order A
// advances the limit on order B and cancelling one nonce cancels both. That is
// a settlement-correctness bug, not a nuisance.
//
// Appending a per-session counter gives 1000 distinct nonces per millisecond
// while keeping the value time-ordered. The `lastNonce` clamp makes uniqueness
// hold unconditionally rather than only while fewer than 1000 orders land in
// the same millisecond, and also survives a backwards clock step. No contract
// change — the value stays a plain u64.
let nonceCounter = 0;
let lastNonce = 0n;

export function nextOrderNonce(): bigint {
  const candidate = BigInt(Date.now()) * 1000n + BigInt(nonceCounter++ % 1000);
  lastNonce = candidate > lastNonce ? candidate : lastNonce + 1n;
  return lastNonce;
}

export function buildOrderIntent(params: {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  reduceOnly?: boolean;
  ttlSeconds?: number;
}): OrderIntent {
  return {
    owner: params.owner,
    marketId: params.marketId,
    isLong: params.isLong,
    size: params.size,
    limitPrice: params.limitPrice,
    reduceOnly: params.reduceOnly ?? false,
    nonce: nextOrderNonce(),
    expiryTs: BigInt(Math.floor(Date.now() / 1000) + (params.ttlSeconds ?? 300)),
  };
}

export function orderIntentToJson(o: OrderIntent): Record<string, string | number | boolean> {
  return {
    owner: o.owner,
    market_id: o.marketId,
    is_long: o.isLong,
    size: o.size.toString(),
    limit_price: o.limitPrice.toString(),
    reduce_only: o.reduceOnly,
    nonce: o.nonce.toString(),
    expiry_ts: o.expiryTs.toString(),
  };
}
