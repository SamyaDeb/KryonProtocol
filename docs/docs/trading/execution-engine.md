---
id: execution-engine
title: Execution Engine
sidebar_position: 2
---

# Execution Engine

The execution engine is the matcher service (`scripts/matcher-service.ts`)
plus the settlement library (`lib/stellar/settlement.ts`). It turns resting
order intents into settled on-chain positions.

## Matching algorithm

`matchAll(limitOrders, marketOrders)` runs in two passes with shared
partial-fill accounting:

### Pass 1 — market orders vs the resting book

- **Market sells** sweep the highest bids first.
- **Market buys** sweep the lowest asks first.
- Fill price = the resting limit order's price (the taker crosses the book).

### Pass 2 — limit vs limit (price-time priority)

- Bids sorted by price desc then time asc; asks by price asc then time asc.
- A bid/ask pair crosses when `bid.price ≥ ask.price`.
- Maker = the earlier order; fill price = the maker's limit price.

### Invariants

- **Self-trade prevention**: `if (a.owner === b.owner) continue`.
- **No double-spend of liquidity**: a `pendingFills` map tracks size consumed
  within the tick so an order is never over-matched before the DB updates.
- **Overfill protection**: the gateway also tracks cumulative filled size per
  `(owner, nonce)` on-chain and rejects fills beyond the order size.

## Settlement pipeline

```
match → persistFill (DB, idempotent)
      → submitSettleFillSigned (operator fee-payer, stored maker/taker sigs)
            ├─ simulate → assemble → sign → send → poll
            └─ any failure → SettleResult.reason (recorded verbatim)
      → success: mark the settle_fill TxJob CONFIRMED
      → failure: rollbackFill (orders return to book)
```

Orders without stored settlement signatures take the fallback path instead:
`simulateSettleFill` returns auth entries for the maker and taker to sign, and
the fill is queued until both signatures arrive.

### Idempotency & consistency

- `persistFill` inserts the `Fill` row with `ON CONFLICT DO NOTHING` keyed on
  `(network, txHash, maker, makerNonce, taker, takerNonce)` — replays are no-ops.
- `recordFillPnl` writes `PnlEvent` rows with a unique
  `(network, address, kind, refKey)` constraint — exactly-once accounting.
- If settlement permanently fails, `rollbackFill` deletes the fill and restores
  `filledSize`, so the DB orderbook never diverges from chain.

## Operator authorisation

Settlement is signed by the **operator** key (`MATCHER_OPERATOR_SECRET`,
registered via `Gateway.set_operator`). Because the operator equals the
transaction source account, `require_operator()` is satisfied by the source
signature — no per-trader auth entries. The operator can only settle fills that
pass on-chain validation.

## Sequence-collision handling

The operator key is **dedicated** (separate from the oracle keeper). Earlier,
sharing a key caused `tx_bad_seq` and dropped settlements (surfacing as
"confirmation timeout").

## Throughput characteristics

- Tick cadence: 1s (configurable `POLL_INTERVAL_MS`).
- The loop is sequential per matcher instance — strict ordering, no overlap.
- On-chain settlement latency (testnet) dominates end-to-end time (~2–5s).
- Scale by sharding markets across matcher instances (one writer per market).
