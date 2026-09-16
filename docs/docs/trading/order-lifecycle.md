---
id: order-lifecycle
title: Order Lifecycle
sidebar_position: 3
---

# Order Lifecycle

## States

```
            submit              match (partial)          fully filled
  (none) ──────────▶ RESTING ───────────────▶ PARTIAL ──────────────▶ FILLED
                        │                         │
                        │ cancel                  │ cancel (remaining)
                        ▼                         ▼
                    CANCELLED                 CANCELLED
                        ▲
                        │ expiry_ts passed
                     EXPIRED (excluded from matching)
```

An order is represented by the `Order` row and tracked by `filledSize` vs
`size`. There is no explicit status column — state is derived:

| Derived state | Condition |
| --- | --- |
| RESTING | `cancelled = false`, `filledSize = 0`, not expired |
| PARTIAL | `0 < filledSize < size` |
| FILLED | `filledSize >= size` |
| CANCELLED | `cancelled = true` |
| EXPIRED | `expiryTs != 0 AND expiryTs <= now` |

The matcher only loads orders that are `cancelled = false`, not fully filled,
and not expired.

## Order intent fields

```ts
interface OrderIntent {
  owner: string;       // Stellar address (validated)
  marketId: number;    // must be a configured market
  isLong: boolean;
  size: bigint;        // 1e7, > 0
  limitPrice: bigint;  // 1e18; 0 = market order
  reduceOnly: boolean;
  nonce: bigint;       // unique per owner; idempotency key
  expiryTs: bigint;    // unix seconds; 0 = GTC
}
```

## Idempotency

The DB row id is `owner:nonce`, inserted `ON CONFLICT (id) DO NOTHING`.
Re-submitting the same nonce is a safe no-op — so a page refresh, retry, or
double-click cannot create duplicate orders.

## Placement

`POST /api/orders` → `validateOrderIntent` → auto-create `Account` (FK) →
upsert `Order`. Validation rejects:

- invalid Stellar address, unknown market, non-boolean flags
- `size <= 0` or above the max bound
- `limit_price < 0` or above the max bound
- non-numeric nonce
- past or absurdly-distant expiry

Invalid payloads get `400` with a safe message; valid ones return `{ ok: true }`.

## Cancellation

`POST /api/orders/cancel` with `{ owner, nonce }` sets `cancelled = true`
(validated, idempotent). On-chain, a trader may also call
`Gateway.cancel_order(owner, nonce)` which records cancellation in contract
storage; `settle_fill` rejects fills against cancelled orders. This gives a
trader an on-chain veto independent of the off-chain book.

## Partial fills

A single order may be matched across multiple ticks/counterparties. Each fill
increments `filledSize`. The remaining quantity stays in the book until filled,
cancelled, or expired. Overfill is impossible — both the matcher (`pendingFills`)
and the gateway (on-chain cumulative filled size) enforce `filledSize ≤ size`.

## Settlement coupling

A fill row in the DB is only *trustworthy* once its on-chain `settle_fill`
confirms. The matcher enforces this: on settlement failure it **rolls back** the
fill and restores `filledSize`, returning the order to RESTING for a clean
re-match. This prevents the orderbook/trade feed from showing trades that never
settled on-chain.
