---
id: risk
title: Risk, margin and limits
sidebar_position: 5
---

# Risk, margin and limits

## Margin

Cross-margined per account, in USDC, held in the vault contract.

| Market | Max leverage | Initial margin | Maintenance |
|---|---|---|---|
| XLM-PERP | 10× | 10% | 5% |
| BTC-PERP | 50× | 2% | 1% |
| ETH-PERP | 20× | 5% | 2.5% |
| SOL-PERP | 10× | 10% | 5% |
| XRP-PERP | 10× | 10% | 5% |
| ADA-PERP | 5× | 20% | 10% |
| BNB-PERP | 10× | 10% | 5% |
| TRX-PERP | 5× | 20% | 10% |

Below maintenance margin, a keeper can liquidate you and take a liquidation fee
(25–50 bps by market). Watch `account_health.liquidatable` and
`margin_ratio` — do not wait to find out.

## Rate limits

Per minute, keyed on `(owner, IP)`:

| Endpoint | Limit |
|---|---|
| `POST /api/orders` | 30 |
| `POST /api/orders/cancel` | 60 |
| `POST /api/orders/cancel-all` | 30 |
| `GET /api/fills`, `/positions`, `/orders/list`, `/portfolio` | 120 |
| `GET /api/markets/*`, `/leaderboard`, `/ready` | unlimited |

Bodies over 4096 bytes get a `413`.

30 orders a minute is the real constraint on a quoting strategy: a ladder of 6
levels, two-sided, re-quoted every 5 seconds is 144 orders a minute — far over.
Re-quote on price movement, not on a timer.

`@kryon/agent` defaults to 25 orders/minute so it trips before the venue does.

## Guards worth having

These are on by default in `@kryon/agent`:

```ts
risk: {
  maxPositionSize: { "BTC-PERP": 0.5 },
  defaultMaxPositionSize: 100,
  maxGrossNotionalUsd: 10_000,
  maxOrderNotionalUsd: 500,
  maxOpenOrders: 12,
  maxOrdersPerMinute: 25,
  maxDrawdownUsd: 200,      // one-way halt
  refuseCrossedBook: true,
  maxOracleAgeSeconds: 120,
}
```

Two of these matter more than the rest.

**`maxDrawdownUsd`** is the limit that ends a bad day instead of letting it
compound. It halts the agent permanently for the session — deliberately
one-way, because a bot that can un-halt itself will, for exactly the reason it
halted.

**`refuseCrossedBook`** stops your bot chasing a spread that is not takeable.
A crossed book (bid above ask) or a locked one (bid equal to ask) means resting
orders that should have matched and did not — because their owner cannot settle,
or because settlement itself is broken. It looks like free money and is not.
Both Kryon venues have shown this; see [Going to mainnet](./mainnet).

## Stale oracles

The contract rejects a mark price older than 120 seconds. Trading against a
stale mark is how a position gets liquidated at a price that never existed —
check oracle freshness before sizing, especially on a venue you do not operate.

## Shutdown

The most under-rated safety property: **cancel your orders when you stop.**

A bot that exits with orders resting has left live limit orders on a real venue
with nothing watching them. They can fill an hour later at a price that has
moved, and the resulting position sits unmanaged.

`@kryon/agent` handles `SIGINT`/`SIGTERM` and cancels before resolving `run()`.
If you write your own loop, do the same, and log loudly if the cancel fails.
