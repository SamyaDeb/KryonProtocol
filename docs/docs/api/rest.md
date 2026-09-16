---
id: rest
title: REST API
sidebar_position: 1
---

# REST API

All endpoints are Next.js route handlers under `client/app/api/**`, served
same-origin. Requests/responses are JSON. Monetary fields are raw fixed-point
strings on trading endpoints and human-unit floats on analytics endpoints
(noted per route).

## Orders

### `POST /api/orders`

Persist an order intent. Validated before any DB write.

```json
{
  "owner": "G…",            "market_id": 1,
  "is_long": true,          "size": "10000000",          // 1e7
  "limit_price": "205000000000000000",  // 1e18, 0 = market
  "reduce_only": false,     "nonce": "1780061000000",
  "expiry_ts": "1780064600",
  "signature": "<base64 SEP-53 signature>"
}
```

`signature` is **required** — a body without it is rejected. It is a SEP-53
signature over the pipe-delimited canonical message, which is re-verified on
chain at settlement. See [Signing](/agents/signing) for the exact bytes.

Responses: `200 { ok: true }` · `400 { ok: false, error }` (validation, and
signature failures) · `413` (body over 4096 bytes) · `429` (30/min) ·
`500 { ok: false, error: "Failed to persist order" }`.

Validation rejects invalid addresses, unknown markets, non-positive/oversized
sizes, negative/oversized prices, bad nonces, past/over-distant expiries, and
signatures that do not verify.

Upserts on `(owner, nonce)` with `ON CONFLICT DO NOTHING`, so resubmitting a
used nonce returns `ok: true` **without storing anything**. Nonces are unique
per account, not per market.

### `POST /api/orders/cancel`

```json
{ "owner": "G…", "nonce": "1780061000000", "signature": "…" }
```

Marks the order cancelled (idempotent). `signature` is required and uses the
newline `key=value` canonical form — **not** the order form. `401` on a bad
signature; 60/min.

### `GET /api/orders/list?address=G…&status=open&market_id=1&limit=100`

An account's own orders, with the nonce needed to cancel each one. `status` is
`open` (default) or `all`. Raw fixed-point values.

This is what makes a bot restartable: a nonce otherwise exists only inside the
process that created it.

### `POST /api/orders/cancel-all`

```json
{ "owner": "G…", "market_id": 1, "issued_at": "1780061000", "signature": "…" }
```

Cancels every resting order, optionally scoped to one market (`market_id`
omitted or `"all"` for everything). Returns `{ ok, cancelled, nonces }`.

`issued_at` must be within 60s of the server clock, and both it and
`market_id` are covered by the signature. 30/min.

## Market data

### `GET /api/markets/:id`

Market state — `last_price`, `volume`, `long_open_interest`,
`short_open_interest`, `funding_long_index`, `funding_short_index`,
`last_oracle_price` (raw `1e18`/`1e7` strings).

### `GET /api/markets/:id/orderbook`

```json
{ "bids": [{ "price": "0.2050", "size": "1.0000" }], "asks": [], "timestamp": 1780061673243 }
```

Prices/sizes are aggregated and pre-formatted to human units here.

### `GET /api/markets/:id/trades?limit=50`

Recent fills: `{ price, size, side: "buy"|"sell", timestamp }`.

### `GET /api/markets/:id/candles`

OHLC candles for the chart.

### `GET /api/fills?address=G…&limit=20&since=<ms>`

Per-address fill history (maker or taker).

### `GET /api/markets`

The market listing: every market the venue actually serves, with tick sizes,
margin parameters and OI caps alongside live state. Also reports
`price_precision` (1e18) and `amount_precision` (1e7).

Prefer this to probing `/api/markets/:id` by id.

### `GET /api/positions?address=G…&market_id=1`

Open positions, raw fixed-point. A cheap read intended for polling, unlike
`/api/portfolio/:address` which builds analytics across several tables.

### `GET /api/time`

The server clock plus the intake TTL bounds. Order expiry is checked against
*this* clock, so a client whose host drifts should measure its offset here
rather than padding.

## Analytics

### `GET /api/leaderboard`

See [Leaderboard System](/data/leaderboard). Params: `period`, `metric`,
`limit`, `offset`, `search`. Returns ranked traders in human units.

### `GET /api/portfolio/:address`

See [Portfolio Tracking](/data/portfolio). Returns analytics + pnl/balance/
funding history + equity curve in human units.

## Conventions

- **Validation first** — malformed payloads never reach the DB.
- **No internal-error leakage** — handlers log server-side and return generic
  messages.
- **Transient retry** — write paths retry transient Neon errors via `withRetry`.
- **Caching** — analytics routes set `s-maxage` + `stale-while-revalidate`;
  market reads are `no-store` (freshness-critical).
- **Units are not uniform** — `/api/markets`, `/api/markets/:id`,
  `/api/orders/list` and `/api/positions` return RAW fixed point; the order
  book, trades, candles, fills, funding, portfolio and leaderboard routes
  return values already scaled to human units. See
  [Units and precision](/agents/units).
- **Network selection** — every route honours `?network=mainnet|testnet`.
  Programmatic clients should always send it explicitly; the fallback is a
  cookie and then the deployment's primary network.
- **No CORS headers** — server-side clients only; a browser on another origin
  is blocked.
