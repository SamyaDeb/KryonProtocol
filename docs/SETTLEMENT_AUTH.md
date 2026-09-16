# Settlement Authorization (C2) — signature-verified settlement

Status: **on-chain core complete & tested; frontend live-path switch pending.**

## Why

Previously, settling a matched fill required **both** maker and taker to sign a
Soroban auth entry *at fill time* (`/api/settlements/[id]/sign`). A passive limit
maker who went offline could be matched but never settled. This broke passive
liquidity — the core of a CLOB.

## Design (chosen: on-chain order-signature verification)

The maker/taker sign their **order** once. The gateway verifies that standing
signature on-chain for every (partial) fill — no live auth entry, works offline,
and one signature covers all partial fills (the gateway already tracks
`filled[nonce]`).

### On-chain (implemented in `contracts/perp-order-gateway`)

- `register_signer(owner, pubkey)` — one-time, `owner.require_auth()`. Binds a
  Stellar account to an ed25519 public key (may be the account key or a delegated
  session key). This authed binding is the trust anchor (an attacker cannot
  register a key for someone else's address).
- `set_domain(domain: Bytes)` — admin; the network passphrase bytes, mixed into
  every message to prevent cross-network replay.
- `settle_fill_signed(fill, maker_sig, taker_sig)` — operator-submitted. Verifies
  each side's signature against the registered key, then runs the same settlement
  core as `settle_fill`.

### Canonical message (MUST byte-match on both sides)

ASCII, `|`-separated:

```
<domain>|place_order|<pubkey_hex>|<market_id>|<is_long 0/1>|<size>|<limit_price>|<reduce_only 0/1>|<nonce>|<expiry_ts>
```

The wallet signs it via **SEP-53**: ed25519 over `sha256("Stellar Signed Message:\n" || canonical)`.

Equivalence is locked by a cross-language golden test:
- Rust: `canonical_digest_matches_offchain_golden` (gateway crate)
- TS: `orderSettlementMessage` in `client/lib/market/signing-message.ts`
- Both produce digest `f9a4eebd6081275c933af782f0a5224c7fc8cf34017d7f6016612a183aec96be`
  for the fixed reference order (domain=testnet passphrase, pubkey=0x00..1f,
  market 1, long, size 1e18, price 1e20, reduce_only false, nonce 42, expiry 1700000000).

## Remaining: frontend live-path switch (next step)

1. **Registration UX**: on first trade, call `gateway.register_signer(owner, pubkeyHexFromAddress(owner))`
   via a Freighter-signed Soroban tx. Gate trading on a one-time `signer_of(owner)` check.
2. **Order signing**: in `submitOrder` (`client/lib/market/matcher.ts`), sign
   `orderSettlementMessage(NETWORK.passphrase, pubkeyHex, order)` via Freighter
   `signMessage` (SEP-53) and persist the signature with the order.
3. **Validation**: `client/lib/validation.ts` should verify the new canonical
   message (keep the existing intent check or replace).
4. **Matcher settlement**: `matcher-service.ts` calls `settle_fill_signed` with the
   stored maker/taker signatures via the operator key — **no auth-entry round-trip**.
   This makes `/api/settlements/[id]/sign` obsolete for the happy path (keep as a
   fallback or remove once migrated).
5. **Deploy**: call `gateway.set_domain(<network passphrase bytes>)` after deploy
   (add to `redeploy-core.ts`).

Until this switch lands, the app continues to use the existing auth-entry flow
(now race-safe via the H2 fix). The signed path is available and proven on-chain
but not yet the default in the UI.
