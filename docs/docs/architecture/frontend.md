---
id: frontend
title: Frontend Architecture
sidebar_position: 3
---

# Frontend Architecture

The frontend is a **Next.js 16 (App Router) / React 19** trading terminal in
`client/`. It is feature-organised and reads protocol state directly from the
chain (via read simulation) plus market/analytics data from same-origin API
routes.

:::note
This Next.js version has breaking changes from prior majors. Consult the bundled
guides in `client/node_modules/next/dist/docs/` before changing routing or
data-fetching patterns.
:::

## Folder structure

```
client/
├── app/                      # App Router routes
│   ├── trade/[market]/       # trading terminal (server component shell)
│   ├── portfolio/            # portfolio dashboard
│   ├── leaderboard/          # ranked traders
│   └── api/                  # route handlers (REST) — see APIs section
├── features/                 # feature-scoped UI
│   ├── trade/components/     # OrderEntry, OrderBook, PositionsTable, BottomPanel…
│   ├── chart/components/     # TradingView + KryonChart
│   ├── wallet/components/    # WalletConnect (Freighter)
│   └── navbar/components/    # NotificationBell, SettingsMenu
├── components/common/        # TopNav, Providers, ErrorBoundary, AssetLogos
├── stores/                   # Zustand: market, orders, wallet, chart, settings
├── lib/
│   ├── stellar/              # contracts, vault reads, freighter, settlement, scval
│   ├── market/               # matcher client, order-intent, websocket client
│   ├── stats.ts              # realized-PnL math + stat writers
│   ├── validation.ts         # server-side order validation
│   ├── math.ts               # liq price, margin ratio, unrealized PnL
│   └── db.ts                 # Neon client + withRetry
└── config/index.ts           # contract addresses, assets, markets, precision
```

## State management

- **Zustand** stores hold live market data (`stores/market.ts`: mark prices,
  order books, trades, stats), local orders, wallet connection, and settings.
- The `MarketDataProvider` writes to the market store via `getState()` setters
  **without subscribing**, so price ticks never re-render the provider or its
  stable children — only the components that select the changed slice re-render.
- **TanStack Query** handles server/chain reads (positions, health, balance,
  leaderboard, portfolio) with `refetchInterval` polling and `keepPreviousData`
  for smooth pagination.

## Realtime data

Realtime market data is delivered by **resilient REST polling** in
`MarketDataProvider`:

| Data | Source | Cadence |
| --- | --- | --- |
| Mark price | Oracle (chain) → Binance fallback | 3s |
| Order book / trades | `/api/markets/:id/orderbook` & `/trades` | 1.5s |
| Market stats (OI, volume) | `/api/markets/:id` | 15s |
| 24h change | Binance ticker | 30s |
| Positions / health | Chain read simulation (TanStack Query) | 10s |

A WebSocket client (`lib/market/websocket.ts`) is implemented with exponential
backoff, jitter, and ping/pong, but stays **dormant unless `NEXT_PUBLIC_WS_URL`
is set** — when a dedicated streaming service is deployed, set the env var and
the client takes over from polling automatically. See
[WebSocket Events](/api/websocket).

## Wallet integration

`WalletConnect` uses `@stellar/freighter-api`. The wallet store tracks
`address`, `connected`, `wrongNetwork`. Clicking the address disconnects.
Order placement signs intents; settlement is automatic (operator-signed) so
traders are not prompted to sign each fill.

## Trade page composition

`app/trade/[market]/page.tsx` is a server component that resolves the market
from config, then renders a desktop grid: `MarketHeader`, `TradeChart`,
`OrderBook`, `OrderEntry` + `AccountBar`, and `BottomPanel` (positions / open
orders / history tabs) — all wrapped in `MarketDataProvider`.

## Resilience

- `ErrorBoundary` wraps the app to contain render errors.
- All polling callbacks are wrapped so a failed RPC/fetch degrades gracefully
  (e.g. oracle read failure falls back to Binance) rather than throwing on the
  interval.
- Order submission is **idempotent** (nonce-keyed), so a refresh or
  double-submit during an active trade cannot create duplicates.
