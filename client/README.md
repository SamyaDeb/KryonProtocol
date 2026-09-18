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
KRYON_TEST_DATABASE_URL=postgresql://localhost:5432/kryon_ui_test npm test   # + database suites (a migrated, disposable DB)
npm run lint
npm run build
npm run wagmi:generate   # regenerate ABIs from ../kryon-protocol/evm
```

Off-chain services run individually, e.g. `npm run dev:matcher`,
`npm run dev:indexer`, `npm run dev:ws`.

## Local stack

One command runs the whole protocol on your machine, so the app can be
developed and tested end to end without touching a public network:

```bash
npm run dev:stack    # terminal 1: chain, contracts, database, every service
npm run dev          # terminal 2: the app, pointed at the stack
```

`dev:stack` starts `arc-anvil` on `127.0.0.1:8545` (chain id 5042002), deploys
Kryon with `DeployAll` and the `arc-local` config, writes the deployment record
to `.dev-stack/arc-local.json` (or wherever `KRYON_DEPLOYMENT_FILE` points),
resets a local Postgres (`kryon_dev_local`, created if missing) and applies the
Arc baseline. It then funds three test traders with wallet USDC and starts the
oracle publisher, indexer, matcher, reconciler, funding and liquidation
keepers, WebSocket server (`ws://127.0.0.1:8080`) and stats aggregator.

It writes `.env.development.local`, which Next loads ahead of `.env.local`, so
`npm run dev` needs no further setup. It then prints the contract addresses and
the test accounts. To trade from a browser wallet, add a network with RPC
`http://127.0.0.1:8545`, chain id `5042002` and currency `USDC`, and import one
of the printed test keys. They are anvil's public development keys, so never
send them anything of value. Ctrl-C stops everything. If any service exits on
its own, the whole stack stops.

| Flag / variable | Effect |
|---|---|
| `--live-prices` | Real oracle-keeper against Binance/Coinbase/Kraken instead of the synthetic random walk |
| `--verbose` | Service info logs (default: warnings and errors only) |
| `--no-env-file` | Don't write `.env.development.local` |
| `KRYON_DEV_DATABASE_URL` | Local database (default `postgresql://localhost:5432/kryon_dev_local`) |
| `KRYON_DEV_RPC_PORT`, `KRYON_DEV_WS_PORT` | Ports (default 8545, 8080) |

It needs `arc-anvil` and `arc-forge` on `PATH` and a local Postgres. It refuses
a non-local database, because it drops that database's `public` schema on every
start.

## Browser configuration endpoints

- `GET /api/config` returns the chain id, every contract address, the Kryon
  EIP-712 domain (sign orders with it unchanged) and the USDC permit domain.
  Everything in it is public; provider RPC URLs never leave the server.
- `GET /api/fees[?address=0x…]` returns maker and taker rates per market in
  millionths of notional, the rebate flag and the net-rate floor. With an
  address, it also returns that account's tier and effective rates. An
  account's maker rate is a lower bound, because the FeeRouter raises the maker
  side of a fill that would net below the floor.

## Routes

- `/trade/[market]` — trading terminal
- `/portfolio` — account overview
- `/leaderboard` — trader rankings
