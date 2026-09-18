# Matcher Failure Procedure

The matcher (`client/scripts/matcher-service.ts`) matches the resting book off
chain and settles fills through `OrderGateway.settleFillsSigned`. One process
per shard: one operator key, one set of markets in `MATCHER_MARKETS`.

**Before anything else: never start a second process on the same operator key.**
`TxSender` allocates that key's nonce locally. Two allocators produce two
transactions at the same nonce, and one silently replaces the other.

## Symptoms

- Crossed book: bids at or above asks that never trade.
- `Fill` rows piling up `PENDING` and never reaching `SETTLED`.
- `Fill` rows carrying a `rejectReason` that keeps recurring.
- The health endpoint (`MATCHER_HEALTH_PORT`, `GET /health`) stops advancing
  `ticks`, or `tickErrors` climbs.

## Diagnosis

```bash
# The shard's own counters: ticks, matches, band drops, batch reverts, gas.
curl -s localhost:"$MATCHER_HEALTH_PORT"/health | jq

# Is the book actually crossed, or just thin?
psql "$DATABASE_URL" -c "
  SELECT \"isLong\", MIN(\"limitPrice\"), MAX(\"limitPrice\"), COUNT(*)
  FROM \"Order\"
  WHERE network = '$KRYON_NETWORK' AND \"marketId\" = 2
    AND status IN ('OPEN','PARTIALLY_FILLED') AND expiry > extract(epoch from now())
  GROUP BY \"isLong\";
"

# Fills the matcher reserved but the chain has not confirmed.
psql "$DATABASE_URL" -c "
  SELECT status, \"rejectReason\", COUNT(*), MIN(\"createdAt\")
  FROM \"Fill\" WHERE network = '$KRYON_NETWORK'
  GROUP BY 1, 2 ORDER BY 3 DESC;
"

# Settlement transactions still in flight for this key.
psql "$DATABASE_URL" -c "
  SELECT id, nonce, status, label, \"submittedHash\", \"createdAt\"
  FROM \"TxJob\"
  WHERE network = '$KRYON_NETWORK' AND service = 'matcher'
    AND status IN ('PENDING','SUBMITTED')
  ORDER BY nonce;
"
```

## Common causes, in the order they actually happen

### The oracle is stale, so the market is skipped

`oracle_unavailable` in the logs and `oracleSkips` rising. The matcher reads
`OracleAdapter.getPrice` with the market's own `maxOracleAge`, exactly as
`Engine.applyFill` does. If that read reverts, every fill would have reverted
with it, so the shard correctly declines to build a batch.

This is an oracle incident, not a matcher one → [oracle-failure.md](oracle-failure.md).

### Everything is outside the execution band

`band_dropped` in the logs and `bandDrops` rising. Orders are crossing at prices
more than `maxExecutionDeviationBps` from the index, and `Engine.applyFill`
would revert `PriceOutsideBand` on all of them. The book clears once the index
moves to them or the traders re-quote. Nothing to do.

### A batch keeps reverting `InsufficientBatchGas`

`batch_reverted` with that reason, and `gasResizes` rising. The shard halves the
batch and retries on its own, down to `MATCHER_MIN_BATCH_FILLS`. Check the
`batch_applied` lines for the size that did settle; if it is far below 40, the
per-fill gas has grown and `MAX_FILLS_PER_BATCH` in
`client/lib/chain/settlement.ts` needs re-measuring against the gas suite.

`batch_gas_floor_reached` means a single fill will not fit. That is a
contract-level problem, not an operational one: escalate, do not retry.

### Fills rejected for the same reason over and over

```bash
psql "$DATABASE_URL" -c "
  SELECT \"rejectReason\", COUNT(*) FROM \"Fill\"
  WHERE network = '$KRYON_NETWORK' AND \"createdAt\" > now() - interval '1 hour'
    AND \"rejectReason\" IS NOT NULL
  GROUP BY 1 ORDER BY 2 DESC;
"
```

- `InsufficientCollateral` — the traders are underfunded. Nothing to fix.
- `InvalidSignature` / `OrderExpired` / `OrderCancelled` — the shard retires the
  order it can blame, so these should not recur for the same order. If they do,
  the orders are from contract wallets (ERC-1271) that the matcher cannot blame
  by recovery; look for `signature_rejection_unblamed` in the logs.
- `SelfTrade`, `DirectionMismatch`, `FillBelowMinNotional` — logged as
  `matcher_bug_rejections`. These mean the matcher offered a fill the gateway
  should never have been given. **Escalate**: stop the shard and read the fill.

### The process is stuck with fills reserved

A crash between reserving a batch and broadcasting it leaves PENDING `Fill` rows
that nothing is waiting for. **The fix is to restart the shard, not to delete
the rows.** Startup recovery finishes every open `TxJob` for the key, then
reconciles the leftover fills against `OrderGateway.filled` and releases only
the ones the chain provably never saw. Deleting them by hand can double-fill an
order whose batch did land.

`MATCHER_ORPHAN_GRACE_MS` (default 60s) is how long a reservation must sit
before recovery will judge it.

## Recovery

```bash
# 1. Restart the shard. Recovery runs before any new matching.
pm2 restart kryon-matcher && pm2 logs kryon-matcher --lines 100

# 2. Confirm recovery finished and the key has no stranded work:
#    recovery_started → recovery_orphans → recovery_finished
```

If the shard will not start:

- `MATCHER_MARKETS is not set` — required, and deliberately not defaulted.
- `MATCHER_OPERATOR_KEY is not set`, or it is not a 32-byte hex key.
- `RPC chain id … does not match` — `KRYON_NETWORK` and `ARC_RPC_URLS` disagree.
- `market N is not ready to match` — the indexer has not seen `MarketParamsSet`
  for that market, so there is no notional floor or band to match against. Fix
  the indexer, not the matcher.

## What the matcher must never be asked to do

- **Write `SETTLED` or `REJECTED` on a `Fill`.** Only the indexer does that,
  from the gateway's logs. A fill stuck `PENDING` with no `rejectReason` means
  the indexer is behind → [settlement-stuck.md](settlement-stuck.md).
- **Share an operator key with another process,** including a second shard, the
  oracle keeper, the funding keeper or the liquidator. One key, one service,
  one process.

## Prevention

- One key per shard, granted `OPERATOR_ROLE` at deploy (`[roles] operators` in
  `infra/deploy/environments/arc-*.toml`).
- Alert on the health endpoint's `matcherBugs`, `fillsUnaccounted` and
  `tickErrors`: all three are zero in normal operation.
- `fillsUnaccounted` above zero means a receipt did not account for a fill in
  its own batch. That should be impossible; treat it as data loss and escalate.

## Arc monitor alerts (`matcher.*`)

| Alert | Severity | Means |
|---|---|---|
| `matcher.crossed-book:market-<id>` | WARN | Best bid ≥ best ask among live, unexpired, unfilled orders for longer than `MONITOR_CROSSED_BOOK_SECS`. The matcher is not matching what it could. |
| `matcher.rejections` | WARN | More than `MONITOR_REJECTION_RATE_MAX_BPS` of fills decided in the window were rejected, with the reason classes in the alert's values. The chain is refusing what the matcher sends. |

A crossed book is not always the matcher's fault, and the reasons are already in
this runbook above: the oracle is stale so the market is skipped; everything is
outside the execution band; the two sides are the same owner. Check
`oracle.freshness:<SYM>` first — it will be firing too, and it is the cause.

`matcher.rejections` needs `MONITOR_REJECTION_MIN_SAMPLE` fills before it can
fire, so a single rejection on a quiet market says nothing. The reason class is
the diagnosis:

```sql
SELECT "rejectReason", count(*) FROM "Fill"
WHERE "network" = :n AND status = 'REJECTED' AND "updatedAt" > now() - interval '1 hour'
GROUP BY 1 ORDER BY 2 DESC;
```
