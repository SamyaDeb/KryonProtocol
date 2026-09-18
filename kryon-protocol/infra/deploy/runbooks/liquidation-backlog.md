# Liquidation backlog (`liquidation.backlog`)

**PAGE.** An account below maintenance margin that nobody liquidates is a
position whose losses the insurance fund (and then everyone else) absorbs. The
keeper normally clears one within seconds, so this check firing means it is not
working — the alert only fires after N consecutive failing ticks, so a
liquidation in flight does not trip it.

## Symptom

```
🔴 PAGE liquidation.backlog — 3 account(s) below maintenance margin (worst 0x…, short $1,250.00): the liquidation keeper is not clearing them
🔴 PAGE liquidation.backlog — 5 account(s) blocked on a stale price (e.g. 0x…): …
```

Candidates come from the indexer's `Position` table (every trader with a
non-zero position, the insurance backstop excluded) and their health from
`Engine.accountHealth` over Multicall3. An account whose health **cannot be
read** holds a market with an unusable price: reported as blocked, never as
healthy.

## First checks

```bash
pm2 logs kryon-liquidator --lines 200
psql "$DATABASE_URL" -c "SELECT status, count(*) FROM \"KeeperAction\" WHERE kind LIKE 'liquidation.%' GROUP BY 1"
psql "$DATABASE_URL" -c 'SELECT count(*) FROM "Position" WHERE size <> 0'
cast call "$CONTRACT_ENGINE" 'accountHealth(address)' <trader> --rpc-url "$ARC_RPC_URL"
```

## Likely causes

1. **"Blocked on a stale price" is the oracle, not the keeper.** Go to
   `oracle-failure.md` first: with a stale feed the keeper is *right* to send
   nothing, every call would revert, and liquidation is blocked protocol-wide
   for those markets.
2. **The keeper is down, or out of gas** (`signer-gas.md`).
3. **Something is paused.** The keeper idles when Engine, Liquidation or
   Insurance is paused rather than burning gas on guaranteed reverts — check
   `protocol.paused`.
4. **A transaction is stuck in flight.** The keeper will not decide anything new
   while one of its own sends is unresolved (a second liquidation of the same
   account is a second penalty). Check `settlement.txjobs` and
   `settlement.nonce-gap` for the liquidator key.
5. **The indexer is behind**, so `Position` names accounts that have already
   been closed, or misses ones that exist. Check `indexer.lag`.

## Actions

1. Fix the cause above; the keeper re-derives every decision from chain state
   each tick, so nothing needs replaying by hand.
2. If the keeper cannot be restored quickly, liquidation is permissionless:
   any funded key can call it, and the reward is on offer.
   ```bash
   cast send "$CONTRACT_LIQUIDATION" 'liquidate(address,uint32,int256)' <trader> <marketId> 0 \
     --private-key "$LIQUIDATOR_PRIVATE_KEY" --rpc-url "$ARC_RPC_URL"
   ```
3. Watch `insurance.shortfall` while the backlog clears: close-outs that exceed
   the fund's operating capital become bad debt and ADL follows.

## Escalation

A backlog during a fast market is how a perp DEX loses money. Page whoever owns
the keeper fleet, and keep `vault.solvency` and `insurance.shortfall` in view
throughout.
