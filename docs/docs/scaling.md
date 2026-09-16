---
id: scaling
title: Scaling Considerations
sidebar_position: 91
---

# Scaling Considerations

## Where load lands

| Layer | Bottleneck | Strategy |
| --- | --- | --- |
| API routes | DB round-trips | Stateless → scale horizontally; cache analytics; parallelise queries |
| Matcher | Sequential per-market loop + chain settlement latency | Shard markets across instances (one writer per market) |
| Settlement | Soroban RPC throughput, account sequence | Dedicated operator key per matcher shard; batch where possible |
| Indexer | Periodic full aggregation | Move aggregation to a dedicated worker; incremental rollups |
| Database | Ranked/aggregate queries | Composite indexes; precomputed snapshots; read replicas |

## API layer

Route handlers hold no state, so they scale out trivially behind the edge.
Analytics endpoints already set `s-maxage` + `stale-while-revalidate`; market
reads are `no-store` for freshness. Leaderboard count+page run in parallel.
Next lever: a short-TTL cache (e.g. Redis) in front of leaderboard/portfolio.

## Matcher scaling

The matcher is intentionally **single-writer per market** to preserve
price-time ordering and avoid fill races. To scale:

1. **Shard by market** — run one matcher instance per market (or group), each
   with its own operator key to avoid sequence contention.
2. **Parallel settlement** — within a shard, settlements for independent
   accounts can be pipelined; today they are sequential for simplicity.
3. **Batching** — multiple fills could be settled in one transaction if the
   gateway gains a `settle_fills(Vec<MatchedFill>)` entry point.

## Database scaling

- `TraderStat` composite indexes (`network, period, metric`) keep ranked reads
  index-served as trader count grows.
- `LeaderboardSnapshot` serves historical boards without recomputation.
- `PortfolioSnapshot` + `AccountAnalytics` denormalise hot reads so the
  portfolio header is a single indexed lookup.
- For very high volume: partition `Fill` / `PnlEvent` by time, add read
  replicas, and move aggregation to incremental rollups (process only new
  events since the last watermark rather than full re-scan).

## Chain throughput

Settlement latency (~2–5s testnet) is the dominant end-to-end cost. Levers:
batched settlement, parallel operator keys, and running a dedicated/co-located
Soroban RPC node. Mark-price freshness is independent (oracle keeper cadence).

## Realtime fan-out

Polling scales to moderate concurrency. Beyond that, deploy the WebSocket
streaming service (the client is ready — set `NEXT_PUBLIC_WS_URL`) so the
server pushes order book/trade deltas instead of every client polling. The
streaming server fans out from the matcher's fill stream and the indexer's
order book snapshots.

## Capacity guidance

- **Today (single matcher, 1 market, testnet):** comfortably handles
  interactive trading; settlement throughput bounded by RPC.
- **To scale 10–100×:** shard matchers per market, add the WS streaming
  service, front analytics with a cache, and move stats aggregation to a
  dedicated incremental worker.
