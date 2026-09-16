---
id: lifecycle
title: Trading Lifecycle
sidebar_position: 1
---

# Trading Lifecycle

End-to-end, a trade moves through five stages. Every stage is real — there is
no simulated execution.

```
 1. Deposit        2. Place order      3. Match         4. Settle          5. Sync
 ─────────         ───────────────     ────────         ─────────          ──────
 trader →          intent →            matcher pairs    operator signs     indexer +
 Vault.deposit     POST /api/orders    maker+taker      settle_fill →      chain reads
 (Freighter)       (validated → DB)    (price-time)     Engine creates     update FE
                                                        position           (≤10s)
```

## 1. Deposit collateral

The trader deposits USDC (or XLM) into the **vault** via Freighter
(`Vault.deposit`, user-authorised). Equity and free collateral update in the
Account Bar within ~10s. No deposit → settlement fails because the engine
cannot collect initial margin.

## 2. Place an order

The order ticket builds an **intent** (`lib/market/order-intent.ts`) and
`POST`s it to `/api/orders`. The route **validates** (address, market, size,
price, nonce, expiry) and upserts it into Postgres. Orders are off-chain
intents — placing one costs no gas and requires no signature beyond the
session.

- **Market order**: `limit_price = 0` sentinel; matched at the resting book price.
- **Limit order**: rests until a crossing counterparty appears.
- **Reduce-only**: may only shrink/close an existing position.

## 3. Match

The matcher polls every 1s and runs **price-time priority** matching:

- Market sells hit the highest bids; market buys hit the lowest asks.
- Limit vs limit crosses when `bid.price ≥ ask.price`, oldest first.
- **Self-trade prevention**: the same owner never matches itself.
- Partial fills are tracked in-memory across a tick so the same liquidity is
  never double-consumed.

A match produces a `MatchedFill { maker, taker, fillSize, fillPrice }`.

## 4. Settle (on-chain, automatic)

1. The matcher reads **both sides' positions before settlement** (to book PnL).
2. It submits `settle_fill` to the gateway, **signed by the operator key**
   (no trader signature needed).
3. The gateway validates the fill and calls the engine, which **opens,
   increases, or reduces** each side's position and charges fees.
4. On success the matcher records **realized-PnL events**; on failure it
   **rolls the fill back** so the orders return to the book.

Settlement confirms in ~2–5s on testnet.

## 5. Synchronise

- The **state indexer** pulls updated positions, open interest, and funding
  from the chain and refreshes market + analytics tables.
- The **frontend** reads positions and `account_health` directly from the
  chain every 10s and recomputes unrealized PnL against the live mark price
  (which ticks every 8s from the oracle).

The position appears as a **single row per market** with a volume-weighted
entry price, live PnL, and liquidation price.

## Closing / reducing

Closing is just an opposing order. Clicking **Close** in the Positions table
submits a `reduce_only` order in the opposite direction. When it matches and
settles, `settle_user_side` reduces (or closes) the position and books realized
PnL. A full close removes the row; equity reflects the realized result.

## Worked example

```
GCBOM6CQ deposits $15, opens LONG 2 XLM @ $0.2079
  → later adds LONG 1 @ $0.2050  ⇒ LONG 3 @ VWAP $0.2069 (single row)
  → sells (reduce) 1 @ $0.2030   ⇒ LONG 2 @ $0.2069, realized −$0.0039
GA3QI2KH is the counterparty on each fill, mirrored as SHORT.
```

This exact sequence is reproducible on testnet — see [Order
Lifecycle](/trading/order-lifecycle) and [PnL & Funding](/trading/pnl-funding).
