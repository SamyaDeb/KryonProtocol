---
id: mainnet
title: Going to mainnet
sidebar_position: 7
---

# Going to mainnet

Switching network is one line:

```ts
const kryon = new KryonClient({ network: "mainnet", signer });
```

Everything else in this list is the part that matters.

## Before you switch

**Run on testnet long enough to be bored by it.** Include at least one restart,
one deliberate kill, and one period where the venue is unreachable.

**Confirm your shutdown path actually works.** Start the bot, place orders,
kill it, then read the public book back and confirm nothing of yours is left.
Do not take it on faith.

**Set `maxDrawdownUsd`.** On testnet it is a formality. On mainnet it is the
limit that ends a bad day.

**Reduce your size.** Whatever felt right on testnet, start smaller.

**Keep the key out of the code.** Environment variable or a `CallbackSigner`
backed by a KMS. The SDK never logs or serialises key material, and neither
should you.

## Know what mainnet actually is right now

Two things differ materially from testnet, and both will surprise you:

**Only XLM-PERP is live.** Testnet lists all 8 markets; mainnet has only
XLM-PERP registered. `listMarkets()` returns what is really there, so trust it
over any hardcoded list.

**Mainnet is thin, and its book has been badly crossed before.** In September
2026 XLM-PERP was crossed by ~11%, with 91 of 99 bid levels above the best ask —
resting orders from accounts that could not settle them. That particular set has
since expired, but nothing prevents it recurring, so keep
`refuseCrossedBook: true` (the default).

Size accordingly, and do not assume you can exit a position as fast as you
entered it. Check `listMarkets()` and the book at startup rather than assuming
depth is there.

## Operating

- Alert on your bot being *down*, not just on errors. A silent bot with
  resting orders is the bad case.
- Log every order you sign, with its nonce. When something goes wrong the nonce
  is how you find it.
- Reconcile against `GET /api/orders/list` on startup, always.
- Watch `account_health.marginRatio`, not just your PnL.
- Have a manual kill switch you can run from a laptop:

```ts
await new KryonClient({ network: "mainnet", signer }).cancelAll();
```

## Custody

Kryon cannot move your funds. Withdrawal needs your signature, and the only
authority the venue ever holds is a signature over one specific order.

The corollary is that **losing your key loses your position**, and no one can
recover it for you.
