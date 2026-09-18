# Vault solvency (`vault.solvency`)

**PAGE. This is the one that means money is missing.**

## Symptom

```
🔴 PAGE vault.solvency — INSOLVENT: liabilities exceed assets by N wei
```

`Vault.solvency()` returns `(assets, liabilities)` in 1e18 ledger units. The
check is exact: a shortfall of one wei fires, because the vault is supposed to
hold every credited balance at all times and a rounding leak is a bug, not
noise. It fires on the first failing tick (`failAfter: 1`).

## First checks

```bash
cd client
# The current numbers, straight from the chain.
npx tsx -e 'import {createArcPublicClient} from "@/lib/chain/clients";import {arcNetwork,serverNetworkId} from "@/lib/chain/networks";\
import {serverContracts} from "@/lib/chain/contracts-env";import {vaultAbi} from "@/lib/chain/contracts";\
const n=arcNetwork(serverNetworkId());const c=createArcPublicClient(n);\
c.readContract({address:serverContracts(n).vault,abi:vaultAbi,functionName:"solvency"}).then(console.log)'

# What the monitor has been seeing, and since when.
curl -s localhost:9464/status | jq '.checks[] | select(.key=="vault.solvency")'
psql "$DATABASE_URL" -c 'SELECT "createdAt", "event", "detail" FROM "MonitorAlert" WHERE "alertKey" = '"'"'vault.solvency'"'"' ORDER BY "createdAt" DESC LIMIT 10'
```

## Likely causes, in order

1. **An accounting path credited more than it debited.** Look at what changed:
   the most recent `PnlEvent`, `LiquidationEvent`, `DeleverageEvent` and
   `FeeAccrual` rows before the first firing, and whether one account's ledger
   moved without a matching counterparty.
   ```sql
   SELECT * FROM "PnlEvent" WHERE "network" = :n ORDER BY "blockNumber" DESC LIMIT 50;
   SELECT SUM("internalAmount") FROM "BalanceChange" WHERE "network" = :n;
   ```
2. **Bad debt that was socialised without being recorded** — cross-check
   `Insurance.badDebt()` and `insurance.shortfall`.
3. **An upgrade changed a storage layout.** Check `governance.implementations`
   and the `DeploymentArtifact` rows; if an implementation changed near the
   first firing, that is the suspect.
4. **A stale or manipulated price** made a liquidation pay out at the wrong
   mark. Check `oracle.freshness` and `oracle.divergence` around that time.

## Actions

1. **Pause first, diagnose second.** The guardian holds `PAUSER_ROLE` and needs
   no timelock delay. See `timelock-operations.md` § Protocol pauses.
   Pausing the Engine and OrderGateway stops new positions and withdrawals
   while the ledger is wrong.
2. Establish the size of the hole exactly (wei), and whether it is growing:
   re-read `solvency()` a few blocks apart.
3. Do **not** let anyone withdraw against a short vault: that converts a
   paper hole into a realised loss for whoever is last.
4. Reconstruct the cause from `ProtocolEvent` before touching state. The event
   log is the audit trail; every typed table is a projection of it.

## Escalation

Immediately, whatever the hour: this is the audit's KRY-Q class of finding.
Bring in whoever owns the contracts and whoever owns the keeper that last
moved balances. Do not resolve the alert by changing the threshold.
