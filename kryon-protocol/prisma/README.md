# Prisma / Postgres Persistence

The persistence boundary for the matcher, indexer, keepers, TxSender,
deployment registry and analytics of Kryon on Arc (plan §9, roadmap Phase 2).

## Databases

One database per environment, never shared:

| Environment | Database | `network` value |
|---|---|---|
| local (arc-anvil) | `kryon_local` | `arc-local` |
| staging (Arc testnet) | `kryon_staging` | `arc-testnet` |
| production (Arc mainnet) | `kryon_prod` | `arc-mainnet` |

## Conventions

- **Integers** from the chain are stored exactly, as `NUMERIC(78,0)` (fits every
  uint256/int256). Each column comments its unit: `1e18` (internal ledger,
  prices, sizes, funding indices), `1e6` (USDC token units) or wei (18-decimal
  native USDC gas). The analytics tables (`TraderStat`, `PortfolioSnapshot`,
  `AccountAnalytics`, `LeaderboardSnapshot`) use 1e6 and can be truncated and
  rebuilt.
- **Addresses** are lowercase `0x` + 40 hex; **hashes / bytes32** are lowercase
  `0x` + 64 hex. CHECK constraints in the baseline migration reject anything
  else, so writers must lowercase first.
- **Log-derived rows** carry `(blockNumber, txHash, logIndex)` and are unique on
  `(network, txHash, logIndex)`. `BalanceChange` and `PnlEvent` add
  `(address, kind)` because one log can yield several rows.
- **Cursor**: `BlockCursor` is updated in the same database transaction as the
  rows derived from that block range. Arc finality is deterministic on
  inclusion, so there is no reorg handling.
- `TxJob` is one row per broadcast attempt (see `client/lib/chain/tx-store.ts`,
  Postgres implementation `tx-store-pg.ts`).
- Never store private keys, seeds, KMS plaintext or bearer tokens.

## Migrations

`20260917000000_arc_baseline` is a squashed baseline with no legacy history.
The CHECK constraints appended to it are not expressible in `schema.prisma`, so
Prisma's drift check does not see them. Keep them in hand-written SQL in future
migrations too.

Copy `.env.example` to `.env` and set `DATABASE_URL` and `DIRECT_URL`, e.g.
`postgresql://USER:PASSWORD@HOST:5432/kryon?sslmode=require`. Then:

```bash
npm ci
npm run db:generate
DATABASE_URL=... DIRECT_URL=... npm run db:migrate:deploy
```

- `prisma migrate deploy` from CI is the only way staging and production
  schemas change. No `db push`, no ad-hoc SQL.
- New change: edit `schema.prisma`, run `npx prisma migrate dev --name <change>`
  against a local database, commit the generated migration.
- CI replays the migrations into an empty Postgres and diffs against
  `schema.prisma`; any drift fails the build.

## Tests

The `TxJobStore` contract tests run against Postgres when given a migrated,
disposable database (its `TxJob` table is truncated):

```bash
createdb kryon_test
(cd kryon-protocol && DATABASE_URL=postgresql://localhost:5432/kryon_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy)
(cd client && KRYON_TEST_DATABASE_URL="postgresql://localhost:5432/kryon_test?sslmode=disable" npm test)
```
