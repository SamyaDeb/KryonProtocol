# Service env files for docker-compose.yml

`common.env` is shared by every service. Each `<service>.env` is read by that
service only, and holds its own settings and **its one signing key's
custody**: `KRYON_SIGNER_<ROLE>=kms:<keyId>`, or `keystore` plus
`KRYON_KEYSTORE_<ROLE>` and `KRYON_KEYSTORE_<ROLE>_PASSPHRASE_FILE`
(see `lib/chain/signer.ts` and `kryon-protocol/infra/signers/README.md`).
Plaintext keys (`*_PRIVATE_KEY`) are refused on testnet and mainnet.

Copy each `*.env.example` to `*.env` and fill it in, or have the secret
manager render them. The real files are gitignored. A service with missing or
unsafe configuration exits at boot and lists every problem
(`lib/config-check.ts`).

Never give two services the same key: `TxSender` owns its key's nonce.
