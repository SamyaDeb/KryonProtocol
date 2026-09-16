---
id: leaderboard
title: Leaderboard System
sidebar_position: 2
---

# Leaderboard System

The leaderboard ranks traders by realized PnL, volume, or ROI over rolling
windows (24H / 7D / 30D / All).

## Pipeline

```
Fill rows ─┐
PnlEvent ──┼─▶ stats-aggregator (every ~30s, in indexer)
Balance ───┘        │
                    ├─▶ TraderStat  (per network·address·period)
                    └─▶ LeaderboardSnapshot (top-50 historical)
                                │
                    GET /api/leaderboard
                                │
                    Leaderboard page (TanStack Query, 15s refetch)
```

## Metrics

| Metric | Definition |
| --- | --- |
| Realized PnL | Σ `PnlEvent(REALIZED_TRADE)` over the window |
| Volume | Σ `fillSize · fillPrice` across maker + taker fills |
| Trade count | number of fills the address participated in |
| Win rate | winning realized trades ÷ decided trades |
| ROI | realized PnL ÷ peak collateral (Σ deposits) |
| Liquidations | count of `PnlEvent(LIQUIDATION)` |

## API

```
GET /api/leaderboard?period=MONTH&metric=pnl&limit=50&offset=0&search=G...
```

| Param | Values | Default |
| --- | --- | --- |
| `period` | `DAY` `WEEK` `MONTH` `ALL` | `MONTH` |
| `metric` | `pnl` `volume` `roi` | `pnl` |
| `limit` / `offset` | pagination (max 200) | 50 / 0 |
| `search` | address substring (ILIKE) | — |

Response:

```json
{
  "period": "ALL", "metric": "pnl", "total": 5, "limit": 50, "offset": 0,
  "traders": [
    { "rank": 1, "address": "GA3QI2KH…", "pnl": 0.0034, "volume": 4.79,
      "roi": 0.0, "winRate": 1.0, "tradeCount": 18, "liquidations": 0,
      "accountValue": 0.0 }
  ]
}
```

`metric` maps to a **fixed allowlist** of sortable columns (`pnl`→`realizedPnl`,
`volume`, `roi`) — never raw user input — so the ranked query is injection-safe.
Count and page are fetched in parallel (one round-trip of latency). Responses
carry `s-maxage=10, stale-while-revalidate=30`.

## Frontend

`app/leaderboard/page.tsx` fetches the API with TanStack Query
(`keepPreviousData` for smooth paging), supports period switching, address
search, and pagination, and renders ranked rows with coloured PnL/ROI. Empty,
loading (skeleton), and error states are handled.

## Scalability

- Ranked reads are index-served via the `(network, period, metric)` composite
  indexes.
- `LeaderboardSnapshot` lets historical boards render without recomputation.
- For very large trader counts, precomputed snapshots can be served directly
  and the live aggregation moved to a dedicated worker.
