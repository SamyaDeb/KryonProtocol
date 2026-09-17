# Timelock operations (Arc)

`KryonTimelock` (OZ `TimelockController`, 48h minimum delay) owns every proxy and every admin
role. Proposers and cancellers are the governance Safe; executors are listed in the environment
TOML. This runbook covers the guardian veto and pause limits. The full proposal workflow is
written in Step 6.

## Guardian veto

- `pauseExecution()` (guardian, `PAUSER_ROLE` on the timelock) blocks `execute` and
  `executeBatch` until `vetoUntil = now + 7 days`. `executionPaused()` turns false on its own
  when that time passes.
- **Scheduling is never blocked.** Queue the response (revoke, fix, lift) while the veto is active.
- `execute` of a scheduled `unpauseExecution()` is the one call allowed during a veto. It ends
  the veto immediately.
- After a veto ends, by expiry or by lift, the guardian cannot veto again until
  `vetoCooldownEndsAt() = vetoEnd + 3 days`. The cooldown is longer than the 48h delay, so an
  operation scheduled during the veto can always execute before the guardian can veto again.
- `unpauseExecution()` without an active veto does nothing, and it doesn't start a cooldown.

Reading state (read-only):

```bash
arc-cast call $TIMELOCK "executionPaused()(bool)"
arc-cast call $TIMELOCK "vetoUntil()(uint64)"
arc-cast call $TIMELOCK "vetoCooldownEndsAt()(uint64)"
```

## Protocol pauses

Every proxy inherits `KryonUpgradeable`:

- `pause()` (guardian): 72h, then it lapses. The guardian can't pause again until 24h after it
  ends. `pauseState()` returns `(guardianPauseExpiry, indefinite, guardianCooldownEndsAt)`.
- `pauseIndefinitely()` (timelock): no expiry. Schedule it in the first 24h of a guardian pause
  if the emergency needs longer than 72h.
- `unpause()` (timelock): ends both pause kinds immediately. Reverts `ExpectedPause` if nothing is
  paused, so don't queue it until it's needed, or accept that it may fail if the guardian pause
  has already lapsed.

## Revoking a hostile guardian

Queue all of these as one batch, the moment a guardian key is suspect:

1. `KryonTimelock.revokeRole(PAUSER_ROLE, guardian)` and `grantRole(PAUSER_ROLE, newGuardian)`.
2. The same pair on each of the eight proxies.

If the guardian vetoes, the batch still executes: at the latest 7 days after the veto starts,
inside the cooldown. `executeBatch` is blocked during a veto, so if you need the revoke sooner,
also schedule `unpauseExecution()` as a single operation.

## Deployment verification

`99_VerifyDeployment` fails if any contract is paused, a guardian pause cooldown is running, the
timelock is vetoed or in its veto cooldown, or the veto cooldown is not longer than the delay.
