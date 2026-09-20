# Deployment

Kryon deploys to Arc with the Foundry scripts in `evm/script/`. Everything a
deployment needs that is public lives in `environments/`; keys and RPC
credentials come from the environment, never source control.

## Environments

| File | Network | Chain id |
|---|---|---|
| `environments/arc-local.toml` | local arc-anvil fork of Arc testnet | 5042002 |
| `environments/arc-testnet.toml` | Arc testnet | 5042002 |
| `environments/arc-mainnet.toml` | Arc mainnet | 5042 |

`KRYON_NETWORK` (default `arc-testnet`) selects the file. The scripts write the
resulting addresses to `evm/deployments/<network>.json`.

## Arc testnet: keys and roles

`arc-testnet.toml` ships with its role addresses empty, and the deploy
preflight refuses placeholders. Generate the testnet key set and fill them in:

```bash
cd client
npm run testnet:keys -- --write-toml     # keystores in ~/.kryon/arc-testnet, mode 0600
```

This creates one encrypted keystore per service role (matcher operator, two
oracle publishers, funding keeper, liquidator, refill funder, fee-tier bot,
backstop signer) plus testnet stand-ins for the deployer, governance
(timelock proposer and executor), guardian and treasury. Plain wallets are
allowed there on testnet only; mainnet requires Safes and KMS
(`infra/signers/README.md`). The script prints the service env lines, the
addresses to fund from `https://faucet.circle.com`, and the `DeployAll`
command. Commit the TOML change; never commit the keystores or passphrase.

The timelock's 48-hour minimum applies on testnet too, so every parameter
change after the deploy waits two days. `BACKSTOP_SIGNER_ROLE` is not granted
at deploy; grant it through the timelock when backstop unwinding is wanted.

## Scripts

Run from `kryon-protocol/evm/`, in order, or all at once with `DeployAll`:

| Script | Purpose |
|---|---|
| `00_DeployImpls.s.sol` | implementation contracts |
| `01_DeployProxies.s.sol` | proxies and timelock |
| `02_Wire.s.sol` | cross-contract wiring |
| `03_ConfigureMarkets.s.sol` | market parameters |
| `04_ConfigureFees.s.sol` | fee routing |
| `05_Handover.s.sol` | move admin roles to governance |
| `99_VerifyDeployment.s.sol` | read-only post-deploy checks |
| `DeployAll.s.sol` | 00–05 in one broadcast, then the 99 checks |

Mainnet broadcasts additionally require `KRYON_ALLOW_MAINNET=true`. Storage layout
checks for upgrades: `script/storage-layout.sh`.

## Before opening a venue

Three questions, in order:

```bash
# 1. The contracts match the environment config (read-only, any time)
cd kryon-protocol/evm
KRYON_NETWORK=arc-testnet arc-forge script script/99_VerifyDeployment.s.sol --rpc-url $ARC_RPC

# 2. The venue agrees with itself, and every monitor check passes
cd ../../client
npm run gate:venue            # exits non-zero if a check fails
npm run gate:venue -- --strict # a check that could not run also fails

# 3. Write the role baseline the monitor compares against, once 1 and 2 pass
npx tsx scripts/monitor.ts --print-role-baseline > /path/to/roles.json
```

`gate:venue` answers what neither of the others does: do the deployment
record, the chain, the app's API and the indexed database describe the SAME
venue? A venue fails quietly here — an app on yesterday's addresses, a
database indexed from another deployment, or markets the index calls inactive
while the chain has them live, which rejects every order.

## Operating the venue

Every admin function belongs to `KryonTimelock`, so nothing is changed by
calling a contract directly. A change is scheduled, waits the 48-hour minimum
(testnet included), and is then executed:

```bash
cd client
npm run ops -- status                     # caps, markets, fees as the chain has them
npm run ops -- queue                      # scheduled operations, decoded, with their ready time

npm run ops -- market pause 2             # preview: target, effect in words, calldata, id, eta
npm run ops -- market pause 2 --send      # schedule it
npm run ops -- market apply btc --send    # that market's parameters from the environment TOML
npm run ops -- caps 250000 10000 --send   # USDC, whole units
npm run ops -- role grant insurance BACKSTOP_SIGNER_ROLE 0x… --send

npm run ops -- execute <operationId> --send   # once `queue` says it is ready
npm run ops -- cancel  <operationId> --send
```

Nothing is sent without `--send`. Scheduling writes a receipt to
`~/.kryon/ops/<network>/<id>.json`, so `execute` reproduces the exact
arguments two days later even if the indexer is behind. `market apply` takes
its numbers from `environments/<network>.toml` rather than from the command
line, so what governance schedules is what was reviewed and committed — the
same file `99_VerifyDeployment` checks the chain against.

Signing uses the governance key (`KRYON_SIGNER_GOVERNANCE`), which needs
`PROPOSER_ROLE` to schedule and `EXECUTOR_ROLE` to execute.

## Monitor configuration a deployment must supply

The monitor compares the venue against what someone decided it should be, and
those expectations are deployment configuration, not defaults. Until they are
set the affected checks skip (and `gate:venue --strict` fails on them):

| Variable | What it pins |
|---|---|
| `MONITOR_EXPECTED_DEPOSIT_CAP_USDC`, `MONITOR_EXPECTED_ACCOUNT_CAP_USDC` | the deposit caps governance agreed on |
| `MONITOR_ROLE_BASELINE_FILE` | the role holders written once by `--print-role-baseline` |
| `REFILL_TARGETS`, `MONITOR_GAS_TARGETS` | which service wallets are topped up, and to what balance |
| `MONITOR_REFILL_FUNDER_ADDRESS` | the wallet that does the topping up |

A market that has never traded has no funding clock and no open interest to
charge; the funding-freshness check reports that as a skip. With open interest
present it is a page — funding is being lost.

## Runbooks

`runbooks/` holds incident, rollback, oracle, matcher and stuck-settlement
procedures.
