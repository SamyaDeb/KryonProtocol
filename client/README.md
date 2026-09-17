# Kryon — Web app and off-chain services

Next.js 16 + React 19 trading terminal for Kryon, perpetual futures on Arc,
plus the TypeScript off-chain services (matcher, indexer, oracle keeper,
WebSocket server, reconciler, liquidator) under `scripts/`.

> **Status:** pre-launch. The Arc chain layer lives in `lib/chain/`. Some
> services and UI still import legacy chain code (`lib/stellar/**`); those are
> being replaced and are not a supported deployment target.

## Setup

```bash
npm ci
cp .env.local.example .env.local   # fill in values; never commit them
```

The variables are documented in `.env.local.example`. A database URL looks like
`postgresql://USER:PASSWORD@HOST:5432/kryon?sslmode=require`.

## Develop and test

```bash
npm run dev          # http://localhost:3000
npx tsc --noEmit     # typecheck
npm test             # unit tests
npm run lint
npm run build
npm run wagmi:generate   # regenerate ABIs from ../kryon-protocol/evm
```

Off-chain services run individually, e.g. `npm run dev:matcher`,
`npm run dev:indexer`, `npm run dev:ws`.

## Routes

- `/trade/[market]` — trading terminal
- `/portfolio` — account overview
- `/leaderboard` — trader rankings
