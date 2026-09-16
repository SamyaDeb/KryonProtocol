# Signers

## What is in use today

Each off-chain role holds its own raw Stellar secret, supplied as an environment
variable to the process that needs it and never shared between roles:

| Role | Variable | Used by |
| --- | --- | --- |
| Settlement operator | `MATCHER_OPERATOR_SECRET[_MAINNET\|_TESTNET]` | `scripts/matcher-service.ts`, `/api/settlements/[id]/sign` |
| Oracle publisher | `ORACLE_PUBLISHER_SECRET[_MAINNET\|_TESTNET]` | `scripts/oracle-keeper.ts` |
| Liquidator | `LIQUIDATOR_SECRET[_MAINNET\|_TESTNET]` | `scripts/liquidation-keeper.ts` |
| Deployer / admin | operator-held, never in a service | `scripts/mainnet-deploy.ts` and friends |

The separation is not cosmetic. The matcher and oracle keeper shared one account
early on, and the resulting `tx_bad_seq` collisions dropped settlements — which
surfaced as "confirmation timeout" rather than as a key problem.

`client/lib/secrets-check.ts` runs at service startup: it fails the process on a
missing or placeholder-looking secret, and on any secret exposed through a
`NEXT_PUBLIC_` variable (which would bundle it into the browser).

## Rules

- A key serves exactly one role. Keeper, oracle publisher, liquidator, deployer,
  and governance signers are separate accounts.
- Transaction payloads are signed with explicit network passphrase binding.
- Every submitted settlement payload is recorded in `TxJob` before signing, and
  failed submissions stay queryable for incident review.
- Secrets reach production as platform secrets (Railway, systemd `EnvironmentFile`
  with mode 600), never in the repository or an image layer.

## Not implemented

There is no managed-signer boundary. An earlier design sketched a
`SIGNER_PROVIDER` abstraction over KMS, Vault and Fireblocks; it was never wired
to anything and has been removed rather than left as a config knob that does
nothing. Moving the operator and liquidator keys behind a custody service is
still the right hardening step before size limits are raised — it is open work,
not a shipped feature.
