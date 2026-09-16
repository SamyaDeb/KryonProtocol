---
id: env-setup
title: Environment Setup
sidebar_position: 2
---

# Environment Setup

All runtime configuration is in `client/.env.local` (services load it via
`tsx --env-file`). Non-secret protocol constants (addresses, markets,
precision) live in `client/config/index.ts`.

## Variables

| Variable | Scope | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | server | Neon Postgres connection (pooled, `sslmode=require`) |
| `ORACLE_PUBLISHER_SECRET` | server | Stellar secret of the authorised oracle publisher |
| `MATCHER_OPERATOR_SECRET` | server | Stellar secret of the gateway operator (settlement signer) — **distinct** from the oracle key |
| `NEXT_PUBLIC_WS_URL` | client | Optional. Streaming server URL; unset → REST polling |

:::danger Secret handling
`*_SECRET` values are raw Stellar private keys. In local dev they sit in
`.env.local` (git-ignored). For any shared/production environment they **must**
come from a secret manager, and for mainnet from a KMS/HSM. Never commit them.
See [Mainnet Readiness](/mainnet-readiness).
:::

## Why two signing keys

`ORACLE_PUBLISHER_SECRET` (keeper, publishes every 8s) and
`MATCHER_OPERATOR_SECRET` (settlement) must be **different accounts**. Sharing
one account makes their transactions collide on the account sequence number,
producing `tx_bad_seq` and dropped settlements. The operator key must also be
registered on-chain via `Gateway.set_operator`.

## Funding the operator key (testnet)

```bash
# generate (or reuse) a keypair, then fund it
curl "https://friendbot.stellar.org/?addr=<OPERATOR_PUBKEY>"
# register it as the gateway operator (admin-signed)
stellar contract invoke --id <GATEWAY> --source <ADMIN_KEY> --network testnet \
  -- set_operator --operator <OPERATOR_PUBKEY>
```

## Network configuration

`config/index.ts` → `NETWORK`:

```ts
rpcUrl:    "https://soroban-testnet.stellar.org"
passphrase:"Test SDF Network ; September 2015"
horizonUrl:"https://horizon-testnet.stellar.org"
```

Override the RPC with `NEXT_PUBLIC_RPC_URL` if you run your own node. For
mainnet, swap to the mainnet RPC/passphrase and redeploy contracts (new
addresses).

## Markets

Markets are declared in `config/index.ts` → `MARKETS` (XLM-PERP, BTC-PERP,
ETH-PERP) with per-market leverage and margin parameters. The matcher and
indexer currently process **market id 1 (XLM-PERP)**; enable additional markets
by adding them to the service `MARKETS` arrays.
