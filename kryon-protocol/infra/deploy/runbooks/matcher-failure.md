# Matcher Failure Procedure

## Symptoms

- Monitor shows: `matcher-lag FAIL: oldest pending order is Xs old`
- Orders placed but never matched/filled
- Settlement modal never appears after two opposing orders are placed

## Diagnosis

```bash
# Check matcher service logs
railway logs --service matcher --lines 100

# Check pending orders in DB
psql "$DATABASE_URL" -c "
  SELECT id, \"marketId\", \"isLong\", \"limitPrice\", \"size\", \"filledSize\", \"createdAt\"
  FROM \"Order\"
  WHERE cancelled = false AND \"filledSize\"::numeric < \"size\"::numeric
  ORDER BY \"createdAt\" ASC LIMIT 10;
"

# Check for pending settlements
psql "$DATABASE_URL" -c "
  SELECT id, status, \"createdAt\" FROM \"Settlement\" ORDER BY \"createdAt\" DESC LIMIT 10;
"
```

## Recovery steps

### Step 1 — Restart matcher

```bash
railway redeploy --service matcher

# Local fallback:
cd client && npm run dev:matcher
```

### Step 2 — If matcher crashes on startup (DB connection error)

Check `DATABASE_URL` is set correctly in Railway matcher service env vars.

```bash
railway variable list --service matcher
railway variable set DATABASE_URL="<neon-url>" --service matcher
railway redeploy --service matcher
```

### Step 3 — If stale/stuck orders are blocking the book

```bash
# Clear orders older than 24h that are still pending (they likely won't match)
cd client && npx tsx --env-file=.env.local scripts/clear-stale-jobs.ts
```

### Step 4 — If matcher sequence number collision with oracle keeper

Both services share the same `ORACLE_PUBLISHER_SECRET` — this causes Stellar sequence number conflicts. Ensure:
- Oracle keeper uses `ORACLE_PUBLISHER_SECRET`
- Matcher uses `MATCHER_OPERATOR_SECRET` (different key)

Verify in Railway env:
```bash
railway variable list --service matcher | grep SECRET
railway variable list --service oracle-keeper | grep SECRET
```

They must use **different** secret keys.

## Settlement stuck (separate runbook)

If orders match but settlement never confirms → [settlement-stuck.md](settlement-stuck.md)

## Prevention

- Use separate keys for oracle keeper and matcher (sequence isolation)
- Matcher polls every 1s and auto-reconnects to DB
- Set Railway restart policy to always-restart on failure
