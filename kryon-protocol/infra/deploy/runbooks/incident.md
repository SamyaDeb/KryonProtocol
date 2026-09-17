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

## Emergency pause and guardian veto (Arc contracts)

The guardian Safe's powers are time-bounded on purpose, so a compromised guardian can delay but
never freeze governance or user withdrawals.

| Action | Who | Effect | Limit |
|---|---|---|---|
| `pause()` on a protocol contract | guardian (`PAUSER_ROLE`) | stops the contract, incl. `Vault.withdraw` | lapses after **72h**; no new guardian pause for **24h** after it ends |
| `pauseIndefinitely()` | timelock (48h) | stops the contract with no expiry | ends only with `unpause()` |
| `unpause()` | timelock (48h) | ends both pause kinds now | the guardian's 24h cooldown still runs |
| `KryonTimelock.pauseExecution()` | guardian | vetoes `execute` / `executeBatch` | lapses after **7 days**; no new veto for **3 days** after it ends |
| `unpauseExecution()` | timelock self-call (48h) | lifts the veto now, starts the 3-day cooldown | no-op without an active veto |

**Real emergency (P0):**
1. The guardian pauses the affected contracts. The 72h clock starts.
2. Within the first 24h, governance schedules `pauseIndefinitely()` on the same contracts, so they
   stay paused when the guardian pause lapses. Schedule the fix (upgrade or parameter change) and
   the eventual `unpause()` at the same time.
3. If execution must be stopped too (a governance key is suspect), the guardian calls
   `pauseExecution()`. Scheduling still works during a veto, and nothing executes for 7 days
   unless the timelock lifts it.

**Hostile guardian:** schedule `revokeRole(PAUSER_ROLE, guardian)` on the timelock and on every
proxy (and `grantRole` to a replacement Safe) immediately. The guardian can't renew its veto or
its pauses: whatever it does, the revokes execute within ~7 days + 48h, and withdrawals are only
blocked during its bounded pauses.

## Escalation

- Contract bugs: roll back via governance (if timelock elapsed) or redeploy fresh instance
- DB corruption: restore from Neon point-in-time recovery
- Key compromise: rotate `ORACLE_PUBLISHER_SECRET` and `MATCHER_OPERATOR_SECRET`, update on-chain via `set_source_publisher` and new deployment

## Post-incident

1. Write a brief timeline (what happened, when detected, when resolved)
2. Update runbooks if any step was wrong or missing
3. Add a monitoring check for the failure mode if one didn't exist
