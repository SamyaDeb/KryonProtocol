# Insurance fund (`insurance.shortfall`, `insurance.coverage`, `insurance.backstop`)

## Symptoms

```
🔴 PAGE insurance.shortfall — unfunded shortfall $X: the backstop is under water; ADL should be running
🔴 PAGE insurance.shortfall — unfundedShortfall() cannot be priced (StaleOracle)
🟠 WARN insurance.coverage — insurance covers X% of $Y open interest (< 20%)
🟠 WARN insurance.backstop  — backstop holds $X (…), unrealized $Y
```

Liquidation closes a distressed position with no counterparty, so the insurance
fund is the protocol's implicit other side (audit KRY-Q4). These three checks
watch that side of the book.

## `insurance.shortfall` > 0

The backstop's positions are worth less than the capital behind them, so
auto-deleveraging (ADL) should be haircutting in-profit counterparties until it
is zero.

1. Is the liquidation/ADL keeper alive and making progress?
   ```bash
   pm2 logs kryon-liquidator --lines 100
   psql "$DATABASE_URL" -c "SELECT status, count(*) FROM \"KeeperAction\" WHERE kind = 'liquidation.adl' GROUP BY 1"
   ```
2. If it is idle, why: check `gas.balance` for the liquidator key, and
   `oracle.freshness` for the backstop's markets (ADL cannot price a haircut
   against a stale feed).
3. If ADL is running, watch the shortfall shrink tick by tick. Each haircut is
   bounded by the shortfall the keeper saw, so several steps are normal.
4. If the shortfall is not shrinking and no keeper error explains it, the
   fund needs capital: the treasury Safe approves USDC to the Insurance proxy
   and calls `Insurance.donate(amount)` (operating capital, no claim back).
   Donations need no timelock; anyone can make one.

## `unfundedShortfall()` cannot be priced

`StaleOracle`. The shortfall is **unknown**, never zero — that distinction is
deliberate. Fix the feed first (`oracle-failure.md`); the shortfall check will
answer once a price exists.

## `insurance.coverage` below the floor

The fund's operating balance has thinned against open interest. Not urgent by
itself, but it is the early warning for the PAGE above: raise capital, or
reduce exposure through `max_open_interest` / `oi_policy_bps` (a RISK_ADMIN
change, so a timelock operation).

## `insurance.backstop` holding positions

Expected right after a liquidation: the fund absorbed the position and will
unwind it. Alarming if the notional keeps growing, or the unrealized loss does:
that is exposure nobody chose to take.

## Escalation

A shortfall that ADL cannot clear, or a fund below its floor with open
interest, goes to whoever can authorise treasury capital — before the next
volatile session, not after.
