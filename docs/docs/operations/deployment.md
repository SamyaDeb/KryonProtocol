---
id: deployment
title: Deployment
sidebar_position: 4
---

# Deployment

## Contract deployment / upgrade

Contracts have no in-place upgrade function, so a code change means deploying a
**fresh instance** and rewiring dependents. Example: the order gateway
(trusted-operator model) was deployed and wired without resetting engine/vault
state.

```bash
cd kryon-protocol

# 1. Build + optimise
cargo build --target wasm32-unknown-unknown --release -p perp-order-gateway
stellar contract optimize \
  --wasm target/wasm32-unknown-unknown/release/perp_order_gateway.wasm

# 2. Upload WASM (retry — testnet submission can time out)
stellar contract upload --wasm <…optimized.wasm> --source <ADMIN> --network testnet
# → <wasm_hash>

# 3. Deploy an instance
stellar contract deploy --wasm-hash <wasm_hash> --source <ADMIN> --network testnet
# → <NEW_GATEWAY>

# 4. Initialise + set operator
stellar contract invoke --id <NEW_GATEWAY> --source <ADMIN> --network testnet \
  -- initialize --admin <ADMIN> --engine <ENGINE>
stellar contract invoke --id <NEW_GATEWAY> --source <ADMIN> --network testnet \
  -- set_operator --operator <OPERATOR>

# 5. Rewire the engine to the new gateway
stellar contract invoke --id <ENGINE> --source <ADMIN> --network testnet \
  -- set_order_gateway --gateway <NEW_GATEWAY>
stellar contract invoke --id <ENGINE> --source <ADMIN> --network testnet \
  -- set_fee_collector --collector <NEW_GATEWAY>

# 6. Update client/config/index.ts with <NEW_GATEWAY>
```

:::warning Sequence collisions
Pause the oracle keeper / matcher / indexer before running admin invokes — they
share the admin/operator account's sequence number and will cause `TxBadSeq`.
:::

## Database migrations

Apply idempotent SQL migrations to the live Neon DB (no destructive reset):

```bash
cd client
npx tsx --env-file=.env.local scripts/apply-migration.ts \
  ../kryon-protocol/prisma/migrations/<migration>/migration.sql
```

## Application + services

| Component | Deploy as | Notes |
| --- | --- | --- |
| Next.js app + API | Edge/Node host (e.g. Vercel) | Stateless; auto-scales |
| Matcher | Always-on worker/container | One writer per market |
| Oracle keeper | Always-on worker/container | Distinct signing key |
| Indexer | Always-on worker/container | Runs stats aggregation too |

Each service needs its signing key injected from a secret manager and a
restart-on-exit policy.

## Pre-flight checklist

- [ ] Contracts deployed; `config/index.ts` addresses updated.
- [ ] Operator key funded and registered (`set_operator`); engine rewired.
- [ ] DB migrations applied; tables verified.
- [ ] `DATABASE_URL`, `ORACLE_PUBLISHER_SECRET`, `MATCHER_OPERATOR_SECRET` set
      from the secret manager (distinct keys).
- [ ] Services started; matcher logs `✓ settled on-chain` on a test fill.
- [ ] Oracle publishing (`account_health` not stale); indexer syncing OI.
- [ ] `npx tsc --noEmit` clean; app builds.

## Rollback

- **Contracts**: re-point `engine.set_order_gateway` to the previous gateway and
  revert `config/index.ts`. State (positions, balances) is preserved in the
  engine/vault, not the gateway.
- **App/services**: redeploy the prior build; the DB schema is
  forward-compatible (additive migrations).
