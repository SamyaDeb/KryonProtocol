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

## Runbooks

`runbooks/` holds incident, rollback, oracle, matcher and stuck-settlement
procedures.
