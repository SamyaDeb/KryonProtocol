---
id: infra
title: Infrastructure Architecture
sidebar_position: 5
---

# Infrastructure Architecture

## Topology

```
┌────────────────────────────────────────────────────────────┐
│                         Edge / CDN                            │
│                    (Next.js app + API)                        │
└───────────────┬───────────────────────────┬──────────────────┘
                │                            │
        same-origin /api/*              static assets
                │
                ▼
        ┌───────────────┐         ┌──────────────────────────┐
        │ Neon Postgres │◀───────▶│  Long-running services    │
        │  (serverless) │         │  matcher · keeper · indexer│
        └───────────────┘         └─────────────┬─────────────┘
                                                 │ Soroban RPC
                                                 ▼
                                   ┌──────────────────────────┐
                                   │ Stellar / Soroban network │
                                   └──────────────────────────┘
```

## Components

| Layer | Technology | Notes |
| --- | --- | --- |
| Frontend + API | Next.js 16 on a Node/edge host (e.g. Vercel) | API routes are stateless; scale horizontally |
| Database | Neon serverless Postgres | Connection caching enabled; `withRetry` for transient errors |
| Services | Node (tsx) processes: matcher, oracle keeper, indexer | Long-running; deploy as always-on workers |
| Chain | Stellar testnet (Soroban RPC + Horizon) | RPC: `soroban-testnet.stellar.org` |

## Service deployment

The three services are independent processes and should run as **always-on
workers** (not serverless functions — they hold loops and signing keys):

```bash
# each as its own worker / container
npm run dev:oracle     # oracle keeper
npm run dev:matcher    # matcher + settlement
npm run dev:indexer    # state sync + stats aggregation
```

Recommended: one container per service, restart-on-exit, with the signing key
injected from a secret manager (not a plaintext `.env`). For mainnet the
operator key should sit behind a KMS/HSM — see [Mainnet
Readiness](/mainnet-readiness).

## Configuration

- Frontend/API config: `client/config/index.ts` (addresses, markets, precision).
- Secrets: `client/.env.local` — `DATABASE_URL`, `ORACLE_PUBLISHER_SECRET`,
  `MATCHER_OPERATOR_SECRET`, optional `NEXT_PUBLIC_WS_URL`. See
  [Environment Setup](/operations/env-setup).

## Observability

API handlers log structured errors server-side. Services log per-tick activity
(fills, settlements, aggregation counts) to stdout — capture these with your
log aggregator. For mainnet, add metrics (settlement latency, match rate, RPC
error rate) and alerting on settlement-failure spikes.

## Scaling levers

The API layer is stateless and scales horizontally. The matcher is intentionally
**single-writer per market** to preserve ordering; scale by **sharding markets
across matcher instances**. See [Scaling](/scaling) for details.
