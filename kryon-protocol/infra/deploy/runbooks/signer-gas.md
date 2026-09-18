# Service key out of gas (`gas.balance`, `gas.funder`)

On Arc, **USDC is the gas token**. A keeper with an empty balance does not
crash: it simply stops getting transactions included. The oracle stops
publishing, funding stops accruing, liquidations stop — and the only symptom is
silence, which is indistinguishable from a quiet market. That is why this is a
balance alert and not an outage alert.

## Symptoms

```
🔴 PAGE gas.balance:matcher — matcher (0x…) has $0.40 gas: below $1.20, its next transaction can fail
🟠 WARN gas.balance:funding — funding has $4.00 gas, under the refill floor $5.00: keeper-refill has not topped it up
🟠 WARN gas.funder — refill funder 0x… has $80.00 (< $100.00): top-ups will stop
```

Two thresholds, deliberately:

- **WARN** at `MONITOR_GAS_WARN_USDC`, which defaults to `REFILL_FLOOR_USDC`.
  Below the floor, `keeper-refill` should already have topped the key up, so a
  key that is still below it means refill did not act.
- **PAGE** at `max(MONITOR_GAS_PAGE_USDC, the key's next-transaction cost)`,
  where the cost is the largest `gasLimit × maxFeePerGas` among that key's
  recent `TxJob` rows. Below that, the next send fails.

## First checks

```bash
cast balance <key> --rpc-url "$ARC_RPC_URL"     # wei of 18-decimal native USDC
pm2 logs kryon-refill --lines 100               # did refill try, and what stopped it?
psql "$DATABASE_URL" -c "SELECT \"status\", \"payload\" FROM \"KeeperAction\" WHERE kind = 'refill.top-up' ORDER BY id DESC LIMIT 10"
```

## Likely causes

1. **keeper-refill is not running**, or is running without `--execute`.
2. **A cap was hit.** Refill caps per run and per target per UTC day; a capped
   top-up logs `service key below its gas floor and refill is capped` with the
   cap that bit (`run`, `day` or `funder`). A key burning its daily allowance
   repeatedly is a key sending far more transactions than expected — find out
   why before raising the cap.
3. **The funder itself is empty** (`gas.funder`). Then nothing gets topped up;
   fund the funder from the treasury.
4. **The key is not a refill target at all.** Compare `MONITOR_GAS_TARGETS`
   (or `REFILL_TARGETS`) with the keys the services actually sign with. A key
   nobody tops up will drain eventually.

## Actions

```bash
# Immediate, manual top-up (the funder key, not a service key):
cast send <key> --value <wei> --private-key "$REFILL_FUNDER_PRIVATE_KEY" --rpc-url "$ARC_RPC_URL"
# Then make it not recur:
pm2 restart kryon-refill
```

Do not raise `MONITOR_GAS_PAGE_USDC` to silence it — the PAGE threshold is
derived from what that key's own transactions cost, so silencing it means
accepting that its next transaction fails.

## Escalation

The publisher's key is the one to treat as an outage: a stale feed blocks
withdrawals protocol-wide. See `oracle-failure.md`.
