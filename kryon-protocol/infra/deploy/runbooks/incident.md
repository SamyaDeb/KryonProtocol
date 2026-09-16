# Incident Runbook

## Severity levels

| Level | Description | Response time |
|---|---|---|
| P0 | Total outage — trading halted, funds at risk | Immediate |
| P1 | Partial outage — one service down, degraded experience | < 15 min |
| P2 | Degraded — oracle stale, WS disconnected, indexer lagging | < 1 hour |
| P3 | Minor — UI glitch, slow query, cosmetic | Next business day |

## First response checklist

1. Run monitor: `cd client && npm run dev:monitor`
2. Check Railway service logs for the failing service
3. Check Vercel function logs at vercel.com/samyadebs-projects/client
4. Check Neon DB status at console.neon.tech
5. Confirm contracts are alive on testnet: `stellar contract invoke --network testnet --source-account kryon-deployer --id <CONTRACT> -- --help`

## Triage by symptom

### Oracle price stale
→ See [oracle-failure.md](oracle-failure.md)

### Trades not matching
→ See [matcher-failure.md](matcher-failure.md)

### Settlement stuck / pending forever
→ See [settlement-stuck.md](settlement-stuck.md)

### Portfolio/leaderboard not updating
→ Indexer is down. See logs in Railway indexer service.
→ Restart: `cd client && npm run dev:indexer`

### App 500 errors
1. Check `DATABASE_URL` is set in Vercel env
2. Check Neon DB is reachable: `psql "$DATABASE_URL" -c "SELECT 1"`
3. Check for Prisma migration drift: `cd kryon-protocol && ./node_modules/.bin/prisma migrate status`

### WebSocket disconnects
1. Check Railway ws-server service is running
2. Verify `NEXT_PUBLIC_WS_URL` is correct in Vercel env
3. Client auto-reconnects — usually self-healing

## Escalation

- Contract bugs: roll back via governance (if timelock elapsed) or redeploy fresh instance
- DB corruption: restore from Neon point-in-time recovery
- Key compromise: rotate `ORACLE_PUBLISHER_SECRET` and `MATCHER_OPERATOR_SECRET`, update on-chain via `set_source_publisher` and new deployment

## Post-incident

1. Write a brief timeline (what happened, when detected, when resolved)
2. Update runbooks if any step was wrong or missing
3. Add a monitoring check for the failure mode if one didn't exist
