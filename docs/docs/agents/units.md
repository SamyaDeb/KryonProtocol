---
id: units
title: Units and precision
sidebar_position: 3
---

# Units and precision

Two fixed-point scales, and they are different:

| Quantity | Scale |
|---|---|
| Prices | **1e18** |
| Sizes | **1e7** (Stellar's 7-decimal convention) |
| Margin parameters | basis points (1e4) |

So a limit price of `$0.2038` on the wire is `203800000000000000`, and a size
of `100 XLM` is `1000000000`.

## Never parse a price as a float

A 1e18 price is ten orders of magnitude past `Number.MAX_SAFE_INTEGER`.

```js
Number("77334100000000000000000") / 1e18
// 77334.09999999999  — not 77334.1
```

Use `BigInt` and a decimal-string parser. `@kryon/sdk` does this throughout and
**refuses** a value with more decimal places than the scale can hold, rather
than silently rounding your price to something you did not ask for.

```ts
import { priceToWire, priceFromWire } from "@kryon/sdk";

priceToWire("77334.1");     // 77334100000000000000000n
priceFromWire(wire, 1);     // "77334.1"
```

## The API is not internally consistent

This will catch you out. Some routes return raw fixed point, others return
values already scaled to human units:

| Route | Returns |
|---|---|
| `GET /api/markets` | **raw** fixed point |
| `GET /api/markets/:id` | **raw** fixed point |
| `GET /api/markets/:id/orderbook` | human units |
| `GET /api/markets/:id/trades` | human units |
| `GET /api/markets/:id/candles` | human units |
| `GET /api/fills` | human units |
| `GET /api/orders/list` | **raw** fixed point |
| `GET /api/positions` | **raw** fixed point |
| `GET /api/portfolio/:address` | human units |
| `GET /api/leaderboard` | human units |

`@kryon/sdk` normalises all of it — every value it returns is a human-unit
decimal **string**. Strings, not numbers, so nothing is lost before you decide
how to do the arithmetic.

## Tick sizes

Each market has an aggregation ladder, finest first, from `GET /api/markets`:

| Market | Finest tick | Price decimals | Size decimals |
|---|---|---|---|
| XLM-PERP | 0.0001 | 4 | 4 |
| BTC-PERP | 0.1 | 1 | 4 |
| ETH-PERP | 0.01 | 2 | 3 |
| SOL-PERP | 0.01 | 2 | 3 |
| XRP-PERP | 0.0001 | 4 | 1 |
| ADA-PERP | 0.0001 | 4 | 1 |
| BNB-PERP | 0.01 | 2 | 3 |
| TRX-PERP | 0.00001 | 5 | 0 |

The venue does not reject an off-tick price, so this is about being legible
rather than valid — but quoting at a precision nobody else uses means never
sitting at the front of a level. The SDK rounds to tick by default; pass
`roundPrice: false` to opt out.

## A note on `trades[].side`

`GET /api/markets/:id/trades` returns a `side` field derived from maker-nonce
parity, **not** the real aggressor direction. Do not build an order-flow signal
on it.
