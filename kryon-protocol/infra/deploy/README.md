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

## Runbooks

`runbooks/` holds incident, rollback, oracle, matcher and stuck-settlement
procedures.
