---
id: protocol
title: Protocol Architecture
sidebar_position: 1
---

# Protocol Architecture

Kryon separates **matching** (off-chain, fast) from **custody, margin, and
settlement** (on-chain, trustless). This is the same hybrid-CLOB model used by
high-performance perp DEXs, adapted to Soroban.

## Components

### On-chain (Soroban smart contracts)

| Contract | Responsibility |
| --- | --- |
| **Vault** | Holds trader collateral; applies PnL; reports account health (equity, margin, liquidatable flag) |
| **Engine** | Owns positions, open interest, funding indices; opens/increases/reduces positions; enforces margin |
| **Oracle Adapter** | Stores guarded mark prices written by the oracle keeper |
| **Order Gateway** | Validates matched fills and calls the engine to settle them (trusted-operator auth) |
| **Liquidation** | Closes under-margined positions, routes fees to insurance |
| **Insurance** | Backstops bad debt |
| **Risk** | Risk-parameter source consulted by the engine |
| **Governance** | Time-locked parameter / upgrade authority |

### Off-chain services

| Service | Responsibility |
| --- | --- |
| **Matcher** (`scripts/matcher-service.ts`) | Polls resting orders, runs price-time matching, settles fills on-chain, books realized PnL |
| **Oracle keeper** (`scripts/oracle-keeper.ts`) | Publishes live prices to the oracle adapter every 8s |
| **State indexer** (`scripts/state-indexer.ts`) | Syncs market/position state from chain, runs leaderboard/portfolio aggregation |

### Application

- **Frontend** — Next.js 16 App Router, React 19, Zustand stores, TanStack Query.
- **API** — Next.js route handlers (`app/api/**`) backed by Neon Postgres.
- **DB** — Neon serverless Postgres; schema in `kryon-protocol/prisma/schema.prisma`.

## Why hybrid CLOB

A fully on-chain order book on Soroban would be prohibitively expensive per
order. Kryon keeps the order book and matching **off-chain in Postgres** —
orders are cheap intents — and only touches the chain when a match must
**settle**. Settlement is where custody and margin actually change hands, so
that is the only step that must be trustless.

## Trust model

- **Collateral & positions** live on-chain. The matcher cannot move funds
  arbitrarily; it can only submit `settle_fill`, which the gateway validates
  (price band, expiry, cancellation, overfill) before the engine touches
  margin.
- **Settlement authorisation** uses a **trusted-operator** model: the matcher's
  operator key signs `settle_fill`. This is the standard perp-DEX sequencer
  pattern. The operator can only settle orders that pass on-chain validation —
  it cannot fabricate fills outside a trader's submitted intent parameters.
- See [Security](/security) for the full threat model and the trade-offs of
  the operator model.

## Precision constants

All contracts and services share fixed-point precision (`client/config/index.ts`,
`crates/protocol-core`):

| Quantity | Precision | Example |
| --- | --- | --- |
| Prices, funding indices, PnL | `1e18` | `$0.2050` → `205000000000000000` |
| Sizes, collateral (USDC) | `1e7` (Stellar stroops) | `1.0 XLM` → `10000000` |
| Basis points | `10000` | `5%` → `500` |

Mixing these scales incorrectly is the most common source of bugs — every
monetary value in the DB is stored as a **decimal string** to avoid float
precision loss.

## Data flow summary

1. Trader signs an order intent → `POST /api/orders` → validated → Postgres.
2. Matcher polls resting orders (1s), runs price-time matching.
3. On a match: matcher reads both sides' positions, settles `settle_fill`
   on-chain (operator-signed), then books realized-PnL events.
4. Indexer syncs positions/OI/funding from chain and aggregates trader stats.
5. Frontend reads positions/health directly from chain (read simulation) and
   market/leaderboard/portfolio data from the API.
