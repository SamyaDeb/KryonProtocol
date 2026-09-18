# Incident Runbook

## Severity levels

| Level | Description | Response time |
|---|---|---|
| P0 | Total outage — trading halted, funds at risk | Immediate |
| P1 | Partial outage — one service down, degraded experience | < 15 min |
| P2 | Degraded — oracle stale, WS disconnected, indexer lagging | < 1 hour |
| P3 | Minor — UI glitch, slow query, cosmetic | Next business day |

## The monitor's two severities

The Arc monitor (`client/scripts/monitor.ts`) has two levels, and each alert
carries the runbook to open:

| Monitor | Meaning | Maps to |
|---|---|---|
| **PAGE** | Money or availability at risk: solvency, an unfunded shortfall, a stale feed on a market with open interest, a signer out of gas, the indexer stalled, an unreconciled transaction or nonce gap, funding not accruing, a liquidation backlog, role/implementation/cap drift, the API down. | P0 / P1 |
| **WARN** | Degraded but safe: RPC fallback in use, fees below gas, elevated rejection rate, a thin insurance fund, replica lag, a queued timelock operation, a pause. | P2 / P3 |

Alerts fire only after N consecutive failing ticks, re-notify on an interval
while they persist, and resolve on their own. A check that could not run at all
reports at WARN rather than passing — a blind spot is reported, not hidden.

```bash
curl -s localhost:9464/healthz    # is the monitor itself ticking?
curl -s localhost:9464/status | jq   # every check, its verdict and its values
psql "$DATABASE_URL" -c 'SELECT "createdAt","event","severity","alertKey","detail" FROM "MonitorAlert" ORDER BY id DESC LIMIT 20'
```

## First response checklist

1. Run monitor: `cd client && npm run dev:monitor`
2. Check Railway service logs for the failing service
3. Check the web tier logs in the hosting provider (`<HOSTING_PROVIDER>`)
4. Check the database provider status page (`<DB_PROVIDER>`)
5. Confirm contracts respond on the target Arc network: `cast call <CONTRACT> "paused()(bool)" --rpc-url "${ARC_RPC_URLS%%,*}"`

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
1. Check `DATABASE_URL` is set in the web tier env
2. Check the database is reachable: `psql "$DATABASE_URL" -c "SELECT 1"`
3. Check for Prisma migration drift: `cd kryon-protocol && ./node_modules/.bin/prisma migrate status`

### WebSocket disconnects
1. Check Railway ws-server service is running
2. Verify `NEXT_PUBLIC_WS_URL` is correct in the web tier env
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
- DB corruption: restore from the database provider's point-in-time recovery
- Key compromise: rotate `ORACLE_PUBLISHER_SECRET` and `MATCHER_OPERATOR_SECRET`, update on-chain via `set_source_publisher` and new deployment

## Post-incident

1. Write a brief timeline (what happened, when detected, when resolved)
2. Update runbooks if any step was wrong or missing
3. Add a monitoring check for the failure mode if one didn't exist
