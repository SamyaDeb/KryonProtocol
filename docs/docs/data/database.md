---
id: database
title: Database Structure
sidebar_position: 1
---

# Database Structure

Postgres (Neon serverless). Schema source of truth:
`kryon-protocol/prisma/schema.prisma`; migrations in
`kryon-protocol/prisma/migrations/`. All monetary values are stored as
**decimal strings** to preserve `1e18`/`1e7` precision without float loss.

## Core trading tables

| Model | Purpose | Key indexes |
| --- | --- | --- |
| `Account` | Trader record (collateral cache, cancelled nonces) | PK `address` |
| `Order` | Off-chain order intents | unique `(owner, nonce)`; `(marketId, isLong, limitPrice)` |
| `Fill` | Matched fills (trade feed source) | unique `(network, txHash, maker, makerNonce, taker, takerNonce)` |
| `Position` | Indexed on-chain positions | unique `(owner, positionId)` |
| `Market` | Per-market state (price, OI, funding, volume) | PK `id` |
| `OracleSnapshot` | Published oracle prices | `(asset, publishTime)` |
| `FundingUpdate` | Market-level funding index history | `(marketId, ledger)` |
| `TxJob` | Settlement/keeper job queue | `(status, nextAttemptAt)` |

## Leaderboard tables

| Model | Purpose |
| --- | --- |
| `TraderStat` | Rolling aggregated stats per `(network, address, period)` — realized PnL, volume, trade/win/loss counts, win rate, ROI, fees, funding, liquidations, peak collateral, referral metrics |
| `LeaderboardSnapshot` | Point-in-time ranked board (JSON `rankings`) for historical boards & rank deltas |

`TraderStat` carries composite indexes on `(network, period, realizedPnl)`,
`(network, period, volume)`, and `(network, period, roi)` so ranked queries
(`ORDER BY metric DESC`) are index-served.

## Portfolio tables

| Model | Purpose |
| --- | --- |
| `BalanceChange` | Deposits / withdrawals / transfers (vault events) |
| `PnlEvent` | Discrete realized-PnL events: `REALIZED_TRADE`, `FUNDING`, `LIQUIDATION`, `FEE` — summing reconstructs the realized-PnL curve |
| `FundingPayment` | Per-account funding debits/credits |
| `PortfolioSnapshot` | Periodic equity / exposure / margin snapshots for charts |
| `AccountAnalytics` | Denormalised all-time aggregates for instant portfolio header rendering |

### Idempotency keys

Event tables use natural unique constraints so re-processing is exactly-once:

- `PnlEvent`: `(network, address, kind, refKey)` where `refKey = "{txHash}:{side}"`.
- `BalanceChange`: `(network, txHash, address, kind)`.
- `FundingPayment`: `(network, address, marketId, fundingIndex)`.

## Enums

```prisma
enum StatsPeriod       { DAY  WEEK  MONTH  ALL }
enum PnlEventKind      { REALIZED_TRADE  FUNDING  LIQUIDATION  FEE }
enum BalanceChangeKind { DEPOSIT  WITHDRAWAL  TRANSFER_IN  TRANSFER_OUT }
```

## Applying migrations

The schema is documented in Prisma, but migrations are applied to the live Neon
DB with an idempotent SQL migration (`...leaderboard_portfolio/migration.sql`)
run via `scripts/apply-migration.ts` — `CREATE TABLE IF NOT EXISTS` / guarded
enum creation make it safe to re-run without a destructive `prisma migrate
reset`:

```bash
cd client
npx tsx --env-file=.env.local scripts/apply-migration.ts \
  ../kryon-protocol/prisma/migrations/20260529130000_leaderboard_portfolio/migration.sql
```

## Aggregation pipeline

`scripts/stats-aggregator.ts` (`runAggregation`) rolls `Fill` + `PnlEvent` +
`BalanceChange` into `TraderStat` (per period) and `AccountAnalytics`
(all-time), and writes a `LeaderboardSnapshot`. The **state indexer invokes it
every ~30s**, so analytics stay fresh without a separate cron. It can also run
standalone (`--loop`).
