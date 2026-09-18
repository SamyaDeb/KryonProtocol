# Funding not accruing (`funding.freshness`)

**PAGE, per market.** `Engine.updateFunding` charges at most **one hour** of
funding per call. Past that hour, the funding nobody charged is gone: the
market drifts from its index, longs and shorts are mispriced against each
other, and nothing else says so. Funding sat at zero for the entire life of the
previous deployment (audit KRY-Q1/Q2) precisely because no alert looked.

## Symptom

```
🔴 PAGE funding.freshness:BTC — funding last updated 1.4h ago; the Engine accrues at most 1h per update, so funding is being lost
🔴 PAGE funding.freshness:SOL — funding has never been initialised on chain
```

Judged on `Engine.fundingState(marketId).lastUpdate` against the **chain**
clock, not on an indexed event: a market's funding clock can start without a
`FundingUpdated` log, so an indexer-only check would cry wolf. The indexed row
rides along as `indexedAgeSecs`, which is how an indexer that is missing
updates shows up here too.

## First checks

```bash
pm2 logs kryon-funding --lines 200
psql "$DATABASE_URL" -c "SELECT \"marketId\", \"status\", \"payload\"->>'elapsed' AS elapsed, \"updatedAt\"
  FROM \"KeeperAction\" WHERE kind = 'funding.update' ORDER BY id DESC LIMIT 20"
curl -s localhost:9464/status | jq '.checks[] | select(.check=="funding.freshness")'
```

## Likely causes

1. **The keeper is not running.** `FUNDING_DUE_AFTER_SECS` defaults to 3300s,
   under the hour on purpose; if the process is down, every market ages out
   together — which is what a per-market alert set firing at once looks like.
2. **It lost `KEEPER_ROLE`.** The keeper logs `not-keeper`; cross-check
   `governance.roles`.
3. **Out of gas** — see `signer-gas.md`. This is the most common cause and the
   quietest.
4. **A stale oracle on that market.** `updateFunding` needs a price; the keeper
   reports it and sends nothing. Fix the feed (`oracle-failure.md`); funding
   catches up on the next tick, charging its one-hour maximum.
5. **The market was never initialised** (`lastUpdate == 0`): its first
   `updateFunding` starts the clock. Nothing accrues before it, so this is a
   deployment gap, not a keeper outage — one call fixes it permanently.

## Actions

```bash
pm2 restart kryon-funding
# One-off, if the keeper cannot be restarted quickly (any KEEPER_ROLE key):
cast send "$CONTRACT_ENGINE" 'updateFunding(uint32)' <marketId> \
  --private-key "$FUNDING_KEEPER_PRIVATE_KEY" --rpc-url "$ARC_RPC_URL"
```

Record the shortfall: the keeper logs `shortfallSecs` per update, which is the
funding that was never charged. It cannot be recovered retroactively; it is a
number the market participants are owed an explanation for, not a number to
quietly drop.

## Escalation

More than a couple of hours on a market with real open interest is a fairness
issue, not just an operational one. Say so publicly rather than letting it be
found later.
