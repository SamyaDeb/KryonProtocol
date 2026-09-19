# Signers

Every off-chain service on Arc signs with its own secp256k1 key. Where that key
lives is chosen per role by `KRYON_SIGNER_<ROLE>`
(`client/lib/chain/signer.ts`). Rotation and emergency revocation are in
[`../deploy/runbooks/key-rotation.md`](../deploy/runbooks/key-rotation.md).

## Custody model

| Mode | `KRYON_SIGNER_<ROLE>` | Where the key is | Allowed on |
| --- | --- | --- | --- |
| KMS | `kms:<keyId \| ARN \| alias/…>` | AWS KMS, key spec `ECC_SECG_P256K1`, usage `SIGN_VERIFY`. The key never leaves KMS | all networks. **Required on mainnet** |
| Keystore | `keystore` | JSON v3 keystore file at `KRYON_KEYSTORE_<ROLE>`, unlocked by `KRYON_KEYSTORE_<ROLE>_PASSPHRASE_FILE` (a secret-manager mount) or `_PASSPHRASE` | all networks. Fallback where KMS isn't available |
| Env | `env` (or unset on arc-local) | raw 32-byte hex in the role's key variable | **arc-local only**. arc-testnet needs `KRYON_ALLOW_ENV_SIGNER=arc-testnet`. arc-mainnet refuses it |

Unset on arc-testnet or arc-mainnet is a startup error, so a service can't fall
back to a plaintext key without saying so. All three modes return the same viem
`LocalAccount`, so transactions (`TxSender`), EIP-712 orders and personal
messages go through one code path. `lib/chain/signer.test.ts` proves the
keystore and KMS paths equivalent to viem's `privateKeyToAccount` for all three
kinds of signature.

KMS specifics (`lib/chain/signer-kms.ts`):

- The address is derived once, at startup, from `GetPublicKey`. A key that is
  not secp256k1 is refused.
- Each signature is DER-parsed strictly, normalised to low-s (EIP-2), and given
  the recovery id whose recovered address matches. A signature that recovers to
  neither is a hard error.
- Every call has a timeout (`KRYON_KMS_TIMEOUT_MS`, default 5000) and bounded
  retries on throttling or 5xx errors (`KRYON_KMS_RETRIES`, default 2). Access
  and key-state errors are not retried.
- Logs and errors carry the role and key id, never a digest.
- Credentials come from the AWS SDK default chain (task role or instance
  profile). Region: `KRYON_KMS_REGION` or the SDK default. Each runtime
  identity gets `kms:GetPublicKey` and `kms:Sign` on its own key only.

`scripts/signer-address.ts <ROLE key variable>` prints a role's mode, address
and health without signing anything.

## Roles

A role is named after its key variable with `_PRIVATE_KEY` or `_KEY` dropped.

| Role | Service | On-chain role |
| --- | --- | --- |
| `MATCHER_OPERATOR` | matcher (one key per shard) | `OPERATOR_ROLE` on OrderGateway |
| `ORACLE_PUBLISHER` | oracle-keeper (one key per publisher host) | `PUBLISHER_ROLE` via `OracleAdapter.setPublishers` |
| `FUNDING_KEEPER` | funding-keeper | `KEEPER_ROLE` on Engine |
| `LIQUIDATOR` | liquidation-keeper | none (`liquidate` is permissionless) |
| `REFILL_FUNDER` | keeper-refill | none (holds the gas float) |
| `FEE_TIER_BOT` | fee-tier-bot | `FEE_TIER_ROLE` on FeeRouter |
| `BACKSTOP_SIGNER` | backstop-unwinder | `BACKSTOP_SIGNER_ROLE` on Insurance (signs orders, sends no transactions) |

Deployer, governance and guardian keys are Safes or operator-held hardware
wallets. They never run in a service.

## Rules

- **A key serves exactly one role, in exactly one process.** `TxSender` owns its
  key's nonce, and two processes sharing a key strand each other's transactions.
- **No plaintext keys off-local.** Mainnet runs `kms`. `keystore` is the
  fallback, and its passphrase comes from the secret manager, never from the
  repository or an image layer.
- Every transaction is recorded in `TxJob` before broadcast, so a failed or
  stuck send stays queryable for incident review.
- Env example files list variable names only, never values.
