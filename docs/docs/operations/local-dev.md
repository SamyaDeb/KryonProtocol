---
id: local-dev
title: Local Development
sidebar_position: 1
---

# Local Development

## Prerequisites

- Node.js ≥ 20
- A Neon Postgres database URL
- Rust + `wasm32-unknown-unknown` target (only for contract work)
- The Stellar CLI (`stellar`) ≥ 23 (only for deploys)
- [Freighter](https://freighter.app) browser extension on **testnet**

## Install & configure

```bash
cd client
npm install
cp .env.example .env.local   # then fill in the values (see Environment Setup)
```

Required env vars (`client/.env.local`):

```bash
DATABASE_URL="postgresql://…"
ORACLE_PUBLISHER_SECRET=S…   # oracle keeper signer
MATCHER_OPERATOR_SECRET=S…   # gateway operator signer (distinct key)
# NEXT_PUBLIC_WS_URL=        # leave unset → polling
```

## Run the stack

Four processes. The app, plus three services:

```bash
# terminal 1 — web app + API
npm run dev            # http://localhost:3000

# terminal 2 — oracle keeper (publishes prices every 8s)
npm run dev:oracle

# terminal 3 — matcher (matches + settles + books PnL)
npm run dev:matcher

# terminal 4 — state indexer (chain sync + stats aggregation)
npm run dev:indexer
```

Open `http://localhost:3000/trade/XLM-PERP`, connect Freighter (testnet),
deposit collateral, and trade.

## Verifying a trade end-to-end

Two Freighter accounts are needed (every fill needs a counterparty; the matcher
prevents self-trades). On `XLM-PERP`:

1. Account A: place a **Limit Long** at price `P`.
2. Account B: place a **Limit Short** at the same price `P` (or a **Market**
   order to cross immediately).
3. Watch the matcher: `✓ settled on-chain: <txhash>`.
4. Within ~10s the position appears in the Positions tab with live PnL.

```bash
tail -f /tmp/kryon-matcher.log     # follow settlement
```

## Useful scripts

```bash
# Apply the leaderboard/portfolio migration to the live DB
npx tsx --env-file=.env.local scripts/apply-migration.ts \
  ../kryon-protocol/prisma/migrations/20260529130000_leaderboard_portfolio/migration.sql

# Run stats aggregation once (or --loop)
npx tsx --env-file=.env.local scripts/stats-aggregator.ts
```

## Contract work

```bash
cd kryon-protocol
cargo test -p perp-order-gateway       # contract unit tests
cargo build --target wasm32-unknown-unknown --release -p perp-order-gateway
```

## Gotchas

- The matcher, oracle keeper, and indexer use **separate signing keys** — don't
  collapse them or you'll hit `tx_bad_seq` collisions.
- When running `stellar contract invoke` with the admin/operator key, **pause
  the services first** so they don't compete for the account sequence number.
- All amounts in the DB are precision strings — never parse them as floats in
  SQL without casting to `numeric`.
