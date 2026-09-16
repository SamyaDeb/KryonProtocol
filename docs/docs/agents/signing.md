---
id: signing
title: Signing
sidebar_position: 2
---

# Signing

If you use `@kryon/sdk` this is handled for you. Read this if you are
implementing Kryon in another language, or debugging a rejected signature.

Kryon uses **two different canonical message formats**. They are not
interchangeable, and mixing them up is the most common integration failure.

## Envelope: SEP-53 only

Every Kryon intent is signed as:

```
signature = ed25519_sign(sha256("Stellar Signed Message:\n" || message))
```

Not the raw message bytes. Not a transaction. Only this.

Signatures go on the wire as **base64** (128-char hex is also accepted). They
decode to exactly 64 bytes.

## Order placement — pipe-delimited

```
<network_passphrase>|place_order|<pubkey_hex>|<market_id>|<is_long>|<size>|<limit_price>|<reduce_only>|<nonce>|<expiry_ts>
```

| Field | Notes |
|---|---|
| `network_passphrase` | The full Stellar passphrase. This is the domain separator. |
| `pubkey_hex` | Lowercase hex of the 32-byte ed25519 key behind your `G…` address |
| `is_long` | `1` or `0` |
| `size` | Decimal string at **1e7** |
| `limit_price` | Decimal string at **1e18**. `0` means a market order. |
| `reduce_only` | `1` or `0` |
| `nonce` | uint64, **unique per account, not per market** |
| `expiry_ts` | Unix seconds |

Worked example (testnet):

```
Test SDF Network ; September 2015|place_order|403074f465f427f58ce06adf008069c5e9bb34d8e43e735350ee9d70b26bcd09|1|1|10000000|205000000000000000|0|1780061000000|1780064600
```

:::danger This one is verified twice
These exact bytes are rebuilt and re-verified **on chain** by
`perp-order-gateway::verify_order_signature` during settlement. A signature the
API accepts but the contract rejects yields an order that matches and then
fails settlement in a loop until it expires. One wrong byte is enough.

Check yourself against
[`conformance/vectors.json`](https://github.com/Kryon-Protocol/KryonSDK/blob/main/conformance/vectors.json),
which is generated from the protocol's own implementation.
:::

## Cancellation — newline `key=value`

A completely different shape:

```
domain=kryon.perps
action=cancel_order
network=<network_passphrase>
owner=<G…>
nonce=<nonce>
```

Note `domain` here is the literal string `kryon.perps`, and the passphrase
moves to its own `network=` field. This form is off-chain only, so it is never
verified by a contract.

## Bulk cancellation

```
domain=kryon.perps
action=cancel_all
network=<network_passphrase>
owner=<G…>
market_id=<market_id|all>
issued_at=<unix_seconds>
```

`issued_at` must be within **60 seconds** of the venue's clock. A bulk cancel
has no nonce to consume, so without that bound a captured signature would
cancel every order the account ever placed, forever. `market_id` is signed too,
so a signature scoped to one market cannot be replayed to wipe your whole book.

## Nonces

Unique **per account**, across all markets. The order's primary key is
`owner:nonce`, and the gateway keys its on-chain `Filled` and `Cancelled`
entries the same way.

Reusing one is silent and bad: order intake upserts with
`ON CONFLICT DO NOTHING`, so the API returns `{ok: true}` for an order it did
not store. Your bot then believes it has a resting order that does not exist,
and a cancel for that nonce hits the *other* order.

The scheme the protocol's own keepers use:

```
nonce = Date.now() * 1000 + (counter++ % 1000)
```

clamped so it never decreases, which survives an NTP correction or a suspended
VM. That gives 1000 nonces per millisecond.

The clamp only covers one process's lifetime. If your bot restarts, recover
your highest used nonce from `GET /api/orders/list` first, or persist a
high-water mark — `@kryon/sdk` ships `PersistentNonceSource` for this.

## Cross-network replay

The passphrase inside every message binds it to one network. A testnet-signed
order is cryptographically incapable of being replayed on mainnet, and the
venue rejects it with a signature error.

Never default the passphrase. Pass it explicitly, everywhere.

## Verifying locally

Check your own signature before spending a rate-limit slot:

```ts
import { verifySignedMessage, orderCanonicalMessage, pubkeyHexFromAddress } from "@kryon/sdk";

const message = orderCanonicalMessage(passphrase, pubkeyHexFromAddress(owner), intent);
if (!verifySignedMessage(owner, message, signature)) {
  throw new Error("this order would be rejected");
}
```
