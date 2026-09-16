---
id: portfolio
title: Portfolio Tracking System
sidebar_position: 3
---

# Portfolio Tracking System

The portfolio system gives each trader a full account picture: live positions
and equity (from chain) plus historical analytics (from the indexed event
tables).

## Data sources

| Surface | Source | Cadence |
| --- | --- | --- |
| Open positions | chain read (`getPositions`) | 10s |
| Equity / margin / liquidatable | chain (`account_health`) | 10s |
| Unrealized PnL | computed from positions × mark | 8–10s |
| Realized PnL, volume, win rate, fees, funding | `AccountAnalytics` via API | 15s |
| Deposit/withdrawal, PnL, funding history | event tables via API | on load |

## API

```
GET /api/portfolio/<address>
```

Returns:

```json
{
  "address": "G…",
  "analytics": {
    "realizedPnl": 0.0, "volume": 4.79, "tradeCount": 18, "winRate": 1.0,
    "totalDeposited": 0.0, "totalWithdrawn": 0.0,
    "totalFundingPaid": 0.0, "totalFeesPaid": 0.0, "liquidationCount": 0,
    "firstTradeAt": "…", "lastTradeAt": "…"
  },
  "pnlHistory":     [ { "kind": "REALIZED_TRADE", "amount": -0.0039, "size": 1, "marketId": 1, "at": "…" } ],
  "balanceHistory": [ { "kind": "DEPOSIT", "asset": "USDC", "amount": 15, "at": "…" } ],
  "fundingHistory": [ { "marketId": 1, "amount": 0.0, "at": "…" } ],
  "equityCurve":    [ { "equity": 15, "unrealizedPnl": 0, "realizedPnlCum": 0, "at": "…" } ]
}
```

All five queries run in parallel. Amounts are returned in human units
(USDC `1e7` → float; prices `1e18` → float). Cached `s-maxage=5,
stale-while-revalidate=15`.

## Frontend

`app/portfolio/page.tsx`:

- **Live header** combines chain reads (equity, positions, unrealized PnL) with
  API analytics (realized PnL, volume, win rate, fees, net funding). Total PnL =
  realized + unrealized.
- **Tabs**: Balances, Positions, Open Orders, Trade History, Funding History,
  Order History, Deposits & Withdrawals — backed by the event tables and chain
  reads. Reuses the same `PositionsTable` / `OpenOrdersTable` /
  `TradeHistoryTable` components as the trade terminal.

## How analytics are produced

`AccountAnalytics` is upserted by the stats aggregator (in the indexer loop)
from `Fill`, `PnlEvent`, and `BalanceChange`. `PortfolioSnapshot` rows capture
the equity curve over time. Because realized PnL is event-sourced, the
portfolio's realized-PnL number always reconciles with the sum of the trader's
`PnlEvent` rows.

## Accuracy note

Realized PnL and funding accrue **from the moment event capture is enabled**.
Fills that settled before the realized-PnL hook existed contribute volume and
trade count (derivable from `Fill`) but not historical realized PnL — there is
no pre-state to reconstruct. This is by design: the system never fabricates
PnL it cannot prove from recorded events.
