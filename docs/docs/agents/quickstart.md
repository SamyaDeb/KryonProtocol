---
id: quickstart
title: Quickstart
sidebar_position: 1
---

# Build a trading agent on Kryon

Kryon is an on-chain perpetuals CLOB on Stellar. This guide takes you from
nothing to a working bot on testnet.

## Why Kryon is unusually easy to automate

**You sign once, and you are done.**

On most venues, a fill is a conversation: match, then a settlement round trip
your bot has to be online for. On Kryon the matcher takes the signature already
attached to your order and submits `settle_fill_signed` itself. Your bot signs
the order, and that same signature is what settles it on chain — possibly
minutes later, with your process long since exited.

That has three consequences worth designing around:

1. **A bot does not need to stay connected.** Sign, disconnect, come back to a
   settled position.
2. **There is no settlement key.** Nothing at the venue can move your funds; a
   signature over your specific order is the only authority that exists.
3. **An order you cannot settle is worse than no order.** Because the signature
   is verified *again* on chain, a wrong one produces an order that matches and
   then fails settlement repeatedly until it expires. Use the SDK rather than
   rolling your own signing.

## Install

```bash
npm install @kryon/sdk @kryon/agent
```

Node 20 or newer.

## Read the market

No key needed to read.

```ts
import { KryonClient } from "@kryon/sdk";

const kryon = new KryonClient({ network: "testnet" });

const markets = await kryon.listMarkets();
console.log(markets.map((m) => `${m.symbol} @ ${m.lastOraclePrice}`));

const book = await kryon.orderbook("BTC-PERP");
console.log(`bid ${book.bestBid} / ask ${book.bestAsk} — mid ${book.mid}`);
```

:::warning Check `book.crossed` before you trust a price
A **crossed** book (best bid above best ask) or a **locked** one (bid equal to
ask) means orders that should have matched and did not. The apparent spread is
not takeable, and a bot that chases it just burns its rate limit.

This is not hypothetical on Kryon. Both venues have shown deeply crossed books —
mainnet XLM-PERP was once crossed by ~11%, with 91 of 99 bid levels above the
best ask. Two causes, both real:

- **The owner cannot settle.** Order intake checks your signature, not your
  margin, so an unfunded account can rest a book that never trades.
- **Settlement itself is failing.** Testnet settled zero trades between launch
  and 2026-09-06 because the USDC collateral feed was unregistered: every fill
  matched, failed to settle, and was rolled back, leaving its orders resting.

Any strategy deriving a mid, a spread, or a signal from the book should check
`crossed` first. The SDK refuses to trade one by default.
:::

## Get a testnet account

You need XLM for fees, a USDC trustline, and USDC deposited into the vault as
margin. Placing orders needs none of this — order intake only checks your
signature — but *settling* a fill does.

```ts
import { Keypair } from "@stellar/stellar-sdk";

const kp = Keypair.random();
console.log("secret:", kp.secret());

await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
```

Then add the USDC trustline and deposit into the vault. See
[Funding an account](./funding).

## Place your first order

```ts
import { KryonClient, KeypairSigner } from "@kryon/sdk";

const kryon = new KryonClient({
  network: "testnet",
  signer: new KeypairSigner(process.env.KRYON_SECRET!),
});

const order = await kryon.placeOrder({
  market: "XLM-PERP",
  side: "buy",
  size: 100,        // base units — 100 XLM
  price: 0.18,      // human price, not 1e18
  ttlSeconds: 300,
});

console.log("resting:", order.id, "nonce:", order.nonce);

await kryon.cancelOrder(order.nonce);
```

Sizes and prices are **human units**. The SDK scales them to the venue's fixed
point (1e18 for price, 1e7 for size) and rounds to the market's tick.

Acceptance means the order is in the book, **not** that it traded. Matching and
settlement are asynchronous — watch `kryon.fills()`.

## Write a strategy

`@kryon/agent` gives you the loop, state reconciliation, risk limits, and — the
part people forget — cancelling your orders when the process dies.

```ts
import { KryonAgent, type AgentContext } from "@kryon/agent";
import { KryonClient, KeypairSigner } from "@kryon/sdk";

class MyBot extends KryonAgent {
  protected async onTick(ctx: AgentContext) {
    const market = ctx.markets.find((m) => m.symbol === "XLM-PERP")!;
    const book = await ctx.orderbook("XLM-PERP");
    if (book.crossed) return;

    const oracle = Number(market.lastOraclePrice);
    if (ctx.position("XLM-PERP") < 100) {
      await ctx.placeOrder({
        market: "XLM-PERP",
        side: "buy",
        size: 10,
        price: oracle * 0.999,
      });
    }
  }
}

const agent = new MyBot({
  client: new KryonClient({
    network: "testnet",
    signer: new KeypairSigner(process.env.KRYON_SECRET!),
  }),
  intervalMs: 5000,
  paper: true,                    // start here
  risk: {
    defaultMaxPositionSize: 500,
    maxOrderNotionalUsd: 200,
    maxDrawdownUsd: 50,
  },
});

await agent.run();
```

### Start in paper mode

`paper: true` runs the identical code path with fills simulated against the
**live** book. Nothing is signed, nothing is sent, and no funds are needed.

Its limitation, stated plainly: resting orders never get filled by anyone else,
because there is no simulation of other participants arriving. Paper mode
under-reports fills for passive strategies. It is a rehearsal for your
plumbing and your risk limits, not a backtest.

### Always await `run()`

`run()` resolves only after the loop has ended *and* your resting orders have
been cancelled. Let the process exit without awaiting it and you leave live
orders on a real venue with nothing watching them.

## Next

- [Signing](./signing) — the exact bytes, if you are not using the SDK
- [Units and precision](./units) — 1e18 vs 1e7, and where the API is inconsistent
- [Risk and limits](./risk) — margin, liquidation, rate limits
- [Going to mainnet](./mainnet)
