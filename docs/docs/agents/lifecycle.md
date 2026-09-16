---
id: lifecycle
title: Order lifecycle
sidebar_position: 4
---

# What happens to your order

```
your bot                venue                        Stellar
   │                      │                             │
   ├─ sign intent         │                             │
   ├─ POST /api/orders ──►│                             │
   │                      ├─ verify signature           │
   │                      ├─ store in book              │
   │◄── { ok: true } ─────┤                             │
   │                      │                             │
   │                   matcher                          │
   │                      ├─ find a cross               │
   │                      ├─ re-verify BOTH signatures  │
   │                      ├─ simulate settlement        │
   │                      ├─ settle_fill_signed ───────►│
   │                      │                             ├─ verify sigs on chain
   │                      │                             ├─ check margin
   │                      │                             ├─ move collateral
   │                      │◄──────── tx hash ───────────┤
   │                   indexer                          │
   │◄── GET /api/fills ───┤                             │
```

**Your bot appears once**, at the top. Everything after the `{ ok: true }`
happens without it. This is the property worth designing around: your process
can exit immediately after placing an order and the fill will still settle.

## What "accepted" means

`{ ok: true }` from `POST /api/orders` means the signature verified and the
order is in the book. It does **not** mean traded. There is no synchronous path
from placing to filling.

To learn you were filled, poll `GET /api/fills`. There is no private WebSocket
channel — the stream carries public book and trade data only.

## States

| State | How you see it |
|---|---|
| Resting | in `GET /api/orders/list?status=open` |
| Partially filled | `filled_size` > 0 and < `size` |
| Filled | absent from the open list; appears in `/api/fills` |
| Cancelled | `cancelled: true` |
| Expired | `expiry_ts` has passed |

## Expiry is mandatory

There is no never-expiring order. `expiry_ts` must be more than 5 seconds and
less than 7 days out, measured against the **venue's** clock.

That bound is a safety feature: a bot that dies without cancelling leaves
orders that age out on their own. It is not a substitute for cancelling —
`@kryon/agent` cancels on shutdown — but it bounds the damage.

If your orders are rejected as "expiry_ts is too soon", check your host clock
against `GET /api/time` before anything else. A VM that has been suspended can
be seconds or minutes off, and the error never mentions time.

## Two ways to cancel

**Off-chain** (`POST /api/orders/cancel`) removes it from the book. Instant,
free, and what you want almost always.

**On-chain** (`order_gateway.cancel_order`) writes a tombstone the contract
itself honours. Costs a transaction, and is what you reach for if you need a
cancel that holds even if the matcher misbehaves.

## Why an order might match and never settle

The matcher re-verifies your stored signature before matching, and simulates
settlement before submitting. An order can fail at that point because:

- **the signature cannot verify on chain** — signed wrong. The matcher cancels
  it rather than looping.
- **insufficient margin** — you have no collateral in the vault, or not enough
  for the position. Order intake does not check margin, so an unfunded account
  can rest orders that can never settle.
- **the price band** — the fill price must respect both sides' limits.
- **open interest cap** — the market is at its ceiling.

The second one is the common surprise: **placing orders needs no funds, but
settling does.** An unfunded account can quote a whole book that will never
trade. That is one reason a book ends up crossed.

The other is venue-wide: if settlement is failing for everyone, every fill is
rolled back and its orders stay resting. Testnet settled zero trades between
launch and 2026-09-06 for exactly this reason — the USDC collateral feed the
margin check prices against had never been registered, so every
`settle_fill_signed` failed and the matcher rolled the fill back. The book
looked healthy and simply never traded.

The lesson for a bot: **a fill in the trades feed is the only proof anything
settled.** Orders resting, and even the matcher reporting a match, are not.
