---
id: funding
title: Funding an account
sidebar_position: 6
---

# Funding a testnet account

Placing orders needs only a keypair — order intake checks your signature and
nothing else. **Settling a fill needs collateral.** An unfunded account can
rest a whole book that will never trade.

Four steps.

## 1. Create and fund with XLM

```ts
import { Keypair } from "@stellar/stellar-sdk";

const kp = Keypair.random();
console.log("SAVE THIS:", kp.secret());

await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
```

## 2. Add the USDC trustline

Collateral is USDC, a classic Stellar asset, so the account needs a trustline
before it can hold any.

```ts
import {
  Asset, Horizon, Networks, Operation, TransactionBuilder, BASE_FEE,
} from "@stellar/stellar-sdk";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

const account = await horizon.loadAccount(kp.publicKey());
const tx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER) }))
  .setTimeout(30)
  .build();

tx.sign(kp);
await horizon.submitTransaction(tx);
```

## 3. Get testnet USDC

Testnet USDC is not dispensed by friendbot. Ask in the Kryon channel, or if you
already control a funded testnet account, send some with a classic payment.

## 4. Deposit into the vault

Margin lives in the vault contract, not in your wallet. Deposit is a Soroban
call that requires your authorisation:

```ts
await kryon.deposit({ amount: 50 });   // 50 USDC
```

Verify it landed:

```ts
const health = await kryon.accountHealth();
console.log(health.collateralValue, health.freeCollateral);
```

Withdrawal is the same in reverse, and is blocked while you have unrealised
losses or open positions that need the margin.

## Contract addresses

Testnet, redeployed 2026-09-05:

| Contract | Address |
|---|---|
| Vault | `CCFVY4ISEKH5MOOONDDPZXE3ZH7DMEHH7P3GPT5HOZOXD4NMIVPOKK6P` |
| Engine | `CAF5OD5KKQOJUW6C3RKSBT2B3U4FZBAO2GM5CN5HQY37FPOL3EHNLF5P` |
| Order gateway | `CDGWXDAFGPARVZ2VRFTDAJK5MIJ326SPBE4UWZF5CD4CQEEKPVIIDARQ` |
| USDC (SAC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

The SDK carries these for both networks; you should not need to hardcode them.
