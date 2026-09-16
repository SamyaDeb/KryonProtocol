---
id: pnl-funding
title: PnL & Funding Logic
sidebar_position: 4
---

# PnL & Funding Logic

All math is fixed-point: prices `1e18`, sizes/amounts `1e7`, results `1e7`.
Reference implementation: `client/lib/math.ts` and `client/lib/stats.ts`.

## Unrealized PnL

Computed live in the UI against the current mark price:

```
long:  pnl = size · (mark − entry) / 1e18
short: pnl = size · (entry − mark) / 1e18
```

`size` is `1e7`, prices are `1e18`, so the result is `1e7` (USDC units). The
Positions table recomputes this every 10s as positions refresh and every 8s as
the oracle mark ticks.

## Realized PnL

Booked when a fill **reduces** an opposite-side position
(`realizedPnlForFill` in `lib/stats.ts`):

```
closeSize = min(existingOppositeSize, fillSize)
long close:  realized = closeSize · (exit − entry) / 1e18
short close: realized = closeSize · (entry − exit) / 1e18
```

Only the closing portion realizes PnL; any residual that opens/increases a
position realizes nothing.

:::caution Not yet recorded
`recordFillPnl` is the only writer of `PnlEvent` rows and is not yet called from
the matcher's settlement path, so no `REALIZED_TRADE` or `FEE` rows are
produced. The realized-PnL, fees and win/loss figures that
`scripts/stats-aggregator.ts` derives from `PnlEvent` therefore read as zero on
the leaderboard and portfolio pages. Unrealized PnL, positions, fills and volume
are unaffected — they come from `Fill` and on-chain position state.
:::

### Example

```
LONG 3 @ entry $0.2069, sell (close) 1 @ $0.2030
realized = 1 · (0.2030 − 0.2069) = −$0.0039   (long loses as price falls)
counterparty SHORT closing 1 @ $0.2030:
realized = 1 · (0.2069 − 0.2030) = +$0.0039   (short profits)
```

Signs are symmetric and sum to zero across the two sides (minus fees) — verified
end-to-end on testnet.

## Equity & account health

The vault's `account_health` is the source of truth for margin:

```
equity            = collateral_value + unrealized_pnl
free_collateral   = equity − initial_margin_required
margin_ratio      = equity · 1e18 / maintenance_margin_required
liquidatable      = equity < maintenance_margin_required
```

Kryon is **cross-margin**: a single collateral pool backs all positions, so
`position.margin` is always 0 — leverage and liq price derive from
account-level equity, never per-position margin.

## Leverage

Displayed leverage is **derived**, not the slider value at order time:

```
leverage = round( totalNotional / equity )   (floored to 1×)
```

A small position against a large collateral balance shows `1×` even if the
order ticket used `15×` — the ticket only sizes the order; actual leverage is
exposure ÷ equity. To realize 15× you need notional ≈ 15 × equity.

## Liquidation price

Cross-margin liq price from current equity (`calcLiqPrice` / PositionsTable):

```
long:  P = (size·mark − equity) / (size·(1 − mm))
short: P = (equity + size·mark) / (size·(1 + mm))
```

where `mm` = maintenance margin rate (`maintenanceMarginBps / 10000`). When the
mark crosses this price the vault flags the account `liquidatable` and the
liquidation contract may close the position, routing the liquidation fee to
insurance.

## Funding

Funding keeps the perp price tethered to the index. The engine maintains
`fundingLongIndex` / `fundingShortIndex` per market; positions snapshot the
index at open (`lastFundingIndex`). On position changes the engine settles the
funding delta. Per-account funding is recorded as `FundingPayment` rows and
`PnlEvent(FUNDING)` for the portfolio funding ledger. Market-level funding
history is in `FundingUpdate`.
