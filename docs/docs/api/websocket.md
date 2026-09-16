---
id: websocket
title: WebSocket Events
sidebar_position: 2
---

# WebSocket Events

Kryon defines a streaming contract for realtime market data. The client
(`client/lib/market/websocket.ts`) is production-ready — exponential backoff,
jitter, ping/pong keepalive, channel resubscription — and is **pluggable**: it
activates only when a streaming server URL is configured.

## Activation

```bash
# .env.local — when a streaming service is deployed:
NEXT_PUBLIC_WS_URL=wss://stream.kryon.xyz
```

When `NEXT_PUBLIC_WS_URL` is **unset** (the current default), the client stays
dormant and the app sources realtime data from [REST polling](/architecture/frontend#realtime-data).
This avoids reconnect churn against a non-existent endpoint while keeping the
WS path ready to switch on.

:::info Why polling today
Next.js App Router route handlers cannot host a raw WebSocket server (no
connection-upgrade in the standard runtime). A streaming server is a separate
service (e.g. a Node `ws`/`uWebSockets` worker, or an edge runtime with
`WebSocketPair`). Until that service is deployed, polling at 1.5s is the
realtime path. The client contract below is what that server must speak.
:::

## Connection lifecycle

```
connect → onopen → subscribe(channels) → stream messages
        ↘ onclose/onerror → scheduleReconnect (exp backoff + jitter, cap 30s)
ping every 25s → server replies pong
```

- Reconnect delay doubles from 1s to a 30s cap, with ±20% jitter to prevent a
  thundering herd when many tabs reconnect together.
- On reconnect, previously-subscribed channels are re-sent automatically.
- `wsDisconnect()` tears down cleanly on unmount; `wsReset()` re-arms it.

## Channels

```
orderbook:<marketId>
trades:<marketId>
```

Subscribe:

```json
{ "type": "subscribe",   "channels": ["orderbook:1", "trades:1"] }
{ "type": "unsubscribe", "channels": ["orderbook:1"] }
{ "type": "ping" }
```

## Server → client messages

```json
{ "type": "orderbook", "market_id": 1, "bids": [{"price":"0.2050","size":"1.0"}], "asks": [], "timestamp": 1780061673243 }
{ "type": "trade",     "market_id": 1, "price": "0.2050", "size": "1.0", "side": "buy", "timestamp": 1780061673243 }
{ "type": "subscribed", "channels": ["orderbook:1","trades:1"] }
{ "type": "pong" }
{ "type": "error", "message": "…" }
```

## Reconciliation with polling

`MarketDataProvider` tracks WS connection status. While the WS is connected,
REST polling for order book/trades **pauses** (`wsActiveRef`); on disconnect it
**immediately resumes**, so the UI never goes stale during a reconnect window.
This dual path is the multi-tab / disconnect resilience strategy: whichever
source is healthy feeds the store.
