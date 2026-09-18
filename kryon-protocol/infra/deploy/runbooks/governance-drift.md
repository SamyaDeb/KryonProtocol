# Governance drift (`governance.roles`, `governance.implementations`, `vault.deposit-caps`)

**PAGE. Nothing here happens by accident: each one means somebody changed the
protocol.**

## Symptoms

```
🔴 PAGE governance.roles — ROLE DRIFT — a grant or revoke happened: oracleAdapter.PUBLISHER_ROLE: expected […] got […]
🔴 PAGE governance.implementations — IMPLEMENTATION DRIFT — an upgrade happened: vault: implementation 0x… ≠ recorded 0x…
🔴 PAGE vault.deposit-caps — deposit caps changed: total cap $500,000, expected $250,000
```

## What the monitor compares against

- **Invariants**, needing no configuration, straight from
  `evm/script/lib/DeploymentVerifier.sol`: the timelock is the sole holder of
  `DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE`, `RISK_ADMIN_ROLE` and `FEE_ADMIN_ROLE`
  on every proxy; `LEDGER_ROLE` is exactly {Engine, FeeRouter, Liquidation,
  Insurance}; `FEE_SOURCE_ROLE` is exactly {OrderGateway, Liquidation}.
- **The role baseline file** (`MONITOR_ROLE_BASELINE_FILE`) for service keys,
  the guardian and the timelock's proposers/executors.
- **`DeploymentArtifact`** rows, or `KRYON_DEPLOYMENT_FILE`'s
  `implementations`, for what each proxy should point at (plus the code hash
  where the artifact records one).
- **`MONITOR_EXPECTED_DEPOSIT_CAP_USDC` / `_ACCOUNT_CAP_USDC`** for the
  guarded-launch limits.

## First checks

1. **Was it us?** Look for the timelock operation that did it:
   ```sql
   SELECT "operationId", "status", "readyAt", "executedTxHash", "description"
   FROM "GovernanceOperation" WHERE "network" = :n ORDER BY "updatedAt" DESC LIMIT 20;
   ```
   An executed operation whose calls match the change is a planned change that
   nobody updated the baseline for. Confirm with the proposer, then update the
   baseline (below) and the alert resolves.
2. **If there is no operation**, treat it as a compromise until proven
   otherwise. A role granted or a proxy upgraded without the timelock means a
   key with admin rights is not where we think it is.
   ```bash
   cd client && npx tsx scripts/verify-decentralization.ts   # current holders, live
   ```
3. For an implementation change, get the bytecode and diff it against the build
   that should be deployed:
   ```bash
   cast code <implementation> --rpc-url "$ARC_RPC_URL" | sha256sum
   ```

## Actions

- **Unplanned drift:** pause (guardian, no delay), then revoke the unexpected
  holder or roll the proxy back — both are timelock operations, so start them
  immediately; the 48h delay runs whether or not you have finished diagnosing.
  See `rollback.md` § Contract rollback and `timelock-operations.md`
  § Revoking a hostile guardian.
- **Planned drift:** after the change is verified, re-record the baseline so
  the monitor watches the new state:
  ```bash
  cd client
  npx tsx scripts/monitor.ts --print-role-baseline > ../infra/deploy/roles.<network>.json
  # then point MONITOR_ROLE_BASELINE_FILE at it and restart the monitor
  ```
  Re-run `99_VerifyDeployment` first: the baseline records what *is*, so
  recording it while the deployment is wrong makes the wrong state the
  expectation.

## If the check says "unverified" or "no expected implementations"

That is the monitor telling you it cannot see drift at all — a WARN, not a
false alarm. Set `MONITOR_ROLE_BASELINE_FILE`, `KRYON_DEPLOYMENT_FILE` or the
expected caps. A monitor that cannot detect an upgrade is worse than no alert,
because it looks green.
