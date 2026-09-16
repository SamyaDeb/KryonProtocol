# Settlement Stuck Procedure

## Symptoms

- Settlement modal appears in UI but transaction never submits
- Settlement row in DB stays `status = 'pending'` indefinitely
- Console shows "settlement submit failed" or RPC timeout

## Diagnosis

```bash
# Find stuck settlements
psql "$DATABASE_URL" -c "
  SELECT id, \"fillId\", status, \"createdAt\", \"makerSig\", \"takerSig\"
  FROM \"Settlement\"
  WHERE status = 'pending'
  ORDER BY \"createdAt\" ASC;
"

# Check if both signatures are present
psql "$DATABASE_URL" -c "
  SELECT id, status,
    (\"makerSig\" IS NOT NULL) AS has_maker_sig,
    (\"takerSig\" IS NOT NULL) AS has_taker_sig
  FROM \"Settlement\" WHERE status = 'pending';
"

# Check matcher logs for settlement errors
railway logs --service matcher --lines 200 | grep -i "settle\|error\|fail"

# Check Soroban RPC availability
curl -s https://soroban-testnet.stellar.org -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' -H 'Content-Type: application/json'
```

## Recovery steps

### Case 1 — Missing one or both signatures

The maker or taker didn't sign. The settlement modal may have closed prematurely.

- UI will re-show the modal on next page load (it polls `/api/settlements`)
- Ask the user to re-open the trade page and sign
- If user is unreachable, the settlement will expire and orders can be re-placed

### Case 2 — Both signatures present but submission failed

```bash
# Manually trigger settlement retry via diagnostics script
cd client
FILL_ID=<fill-id> npx tsx --env-file=.env.local scripts/diag-usdc-settle.ts

# Or run the full settlement test
npx tsx --env-file=.env.local scripts/test-settle-debug.ts
```

### Case 3 — RPC node unavailable

Testnet Soroban RPC (`https://soroban-testnet.stellar.org`) has occasional downtime.

- Wait 2–5 minutes and retry
- Monitor at: https://status.stellar.org
- The matcher auto-retries failed settlements

### Case 4 — Sequence number conflict

If the matcher operator key (`MATCHER_OPERATOR_SECRET`) was used for another transaction concurrently:

- The matcher will auto-retry after detecting the error
- If stuck > 5 minutes, restart the matcher service

### Case 5 — Oracle price stale at settlement time

The settle_fill call validates that oracle price is fresh. If stale:

1. Restart oracle keeper (see [oracle-failure.md](oracle-failure.md))
2. Wait for a fresh price to be published (up to 8s)
3. Retry the settlement

## Force-expire a stuck settlement (last resort)

```bash
psql "$DATABASE_URL" -c "
  UPDATE \"Settlement\" SET status = 'expired' WHERE id = '<settlement-id>' AND status = 'pending';
"
```

This unblocks the orders so they can be re-matched. The positions are not affected — no on-chain state was changed.

## Prevention

- Ensure oracle keeper is always running before the matcher
- Use separate key for matcher to avoid sequence conflicts with oracle keeper
- Monitor settlement age: alert if any settlement is `pending` > 2 minutes
