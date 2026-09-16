# Prisma / Postgres Persistence

This schema is the production persistence boundary for the matcher, indexer,
keepers, deployment registry, transaction queue, and audit package.

Amounts use strings instead of JavaScript `number` or database floats. That is
intentional: protocol values are signed fixed-point integers and must round-trip
exactly with 18-decimal precision.

## Neon Setup

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` and `DIRECT_URL` to your Neon Postgres connection string.
3. Run:

```bash
npm install
npm run db:generate
npm run db:migrate:deploy
```

For local schema iteration, use `npm run db:migrate:dev`. For early testnet
without migrations, `npm run db:push` is acceptable, but do not use `db push`
for mainnet schema changes.

## Operational Rules

- `ProtocolEvent.replayKey` must be deterministic and unique per
  `(network, ledger, tx_hash, topic, event_index)`.
- `LedgerCursor` updates must happen in the same database transaction as event
  inserts.
- `TxJob` rows are idempotent by `(network, kind, payloadHash)`.
- Do not store private keys, seeds, KMS plaintext material, or bearer tokens.

## Production Migrations (single path)

`prisma migrate deploy` is the ONLY sanctioned way to change the production
schema. Never run ad-hoc SQL or one-off scripts against prod again — the
2026-06 `signature` column was added that way and caused schema drift until
the `20260705120000_add_order_signature` repair migration re-baselined it.

```bash
# from kryon-protocol/, with prod credentials in the environment:
DATABASE_URL=<neon-pooled-url> DIRECT_URL=<neon-direct-url> \
  npx prisma migrate deploy
```

- Pending as of 2026-07-05: run the command above once to record
  `20260705120000_add_order_signature` on the live Neon DB (its `ALTER TABLE
  ... IF NOT EXISTS` is a no-op there — the column already exists).
- Verify afterwards with `npx prisma migrate status` (expects "Database schema
  is up to date").
- CI (`.github/workflows/ci.yml`, prisma job) replays the migrations into an
  empty postgres service container and diffs against `schema.prisma` — any
  drift fails the build.
- New schema changes: edit `schema.prisma`, run `npx prisma migrate dev
  --name <change>` against a dev database, commit the generated migration.
