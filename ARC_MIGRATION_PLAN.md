# Kryon on Arc: Build and Launch Plan

**Status:** plan only. Nothing here has been executed.
**Written:** 2026-09-16, the day Arc mainnet launched. Arc facts are tagged **[V]** (verified
from a primary source) or **[U]** (unverified, must be confirmed before the phase that
depends on it). Sources are listed in §16.

Kryon is a perpetual-futures DEX that runs **entirely on Arc**: an off-chain price-time
matching engine, with custody, margin, funding, liquidation, fees, and settlement enforced by
Solidity contracts on Arc mainnet, with USDC as both collateral and gas.

---

## Contents

1. [Summary](#1-summary)
2. [Arc mainnet: what we build on](#2-arc-mainnet-what-we-build-on)
3. [Architecture](#3-architecture)
4. [Phase A: Smart contracts](#4-phase-a-smart-contracts)
5. [Phase B: Trading fees and protocol revenue](#5-phase-b-trading-fees-and-protocol-revenue)
6. [Phase C: Matching engine and off-chain services](#6-phase-c-matching-engine-and-off-chain-services)
7. [Phase D: Oracle design](#7-phase-d-oracle-design)
8. [Phase E: Frontend and agent API](#8-phase-e-frontend-and-agent-api)
9. [Phase F: Database](#9-phase-f-database)
10. [Phase G: Infrastructure, keys, CI/CD](#10-phase-g-infrastructure-keys-cicd)
11. [Phase H: Codebase cleanup](#11-phase-h-codebase-cleanup)
12. [Testing, audit, and launch gates](#12-testing-audit-and-launch-gates)
13. [Timeline](#13-timeline)
14. [Risk register](#14-risk-register)
15. [Open decisions](#15-open-decisions)
16. [Sources](#16-sources)
- [Appendix A: File-by-file change inventory](#appendix-a-file-by-file-change-inventory)
- [Appendix B: Housekeeping before `git init`](#appendix-b-housekeeping-before-git-init)

---

## 1. Summary

- **Chain:** Arc mainnet (chain ID 5042), Circle's EVM L1. Reth execution, Malachite BFT, 0.5s
  blocks, deterministic finality, USDC as native gas.
- **Contracts:** 8 Solidity contracts + a FeeRouter, built with `arc-foundry`. They are UUPS
  proxies owned by a 48h timelock behind a Safe multisig from the first deployment. The
  existing Rust math crates are the reference model that the Solidity port is fuzzed against.
- **Off-chain:** the existing price-time matcher logic is kept. Everything around it moves to viem,
  wagmi, and EIP-712: batched settlement, a nonce-managed transaction sender, block-cursor
  indexer, oracle keeper, liquidation and funding keepers, monitor, and WS server.
- **Revenue:** maker/taker trading fees are enforced on-chain from the first fill, with code-level
  caps, a treasury/insurance/referral split, and exact accounting.
- **Users onboard** with any Arc wallet, and can deposit USDC from other chains via Circle CCTP V2.
- **Effort:** ~12–16 weeks, dominated by the contract build and external audit.

---

## 2. Arc mainnet: what we build on

### 2.1 Network

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | `5042` **[V]** | `5042002` **[V]** |
| Public RPC | `https://rpc.mainnet.arc.io` **[V]** | `https://rpc.testnet.arc.io`, `wss://rpc.testnet.arc.io` **[V]** |
| Mainnet WebSocket | **[U]**, not documented. Use a provider | – |
| RPC providers | Alchemy, Blockdaemon, dRPC, QuickNode **[V]**. Archive/trace **[U]** | same |
| Explorer | `https://explorer.arc.io` (Blockscout-based; verify API is Etherscan-V1-compatible) **[V testnet / U mainnet path]** | `https://explorer.testnet.arc.io` |
| Block time / gas limit | 0.5s / 30M fixed **[V]** | same |
| Finality | deterministic, on inclusion **[V]** | same |
| Hardfork | Osaka baseline + EIP-7702, selected Amsterdam features (EIP-7708 native Transfer logs) **[V]** | same |
| Unsupported | blob tx (type 3), `PREVRANDAO` (returns 0) **[V]** | – |
| Privacy (APS) | not live. Public contracts are unaffected **[V]** | – |
| Toolchain | **`arc-foundry`** (`arc-forge`, `arc-cast`, `arc-anvil`): a superset of Foundry that runs Arc execution semantics. Upstream Foundry executes under Ethereum rules **[V]** | – |

### 2.2 Gas

- EIP-1559 with an EWMA-smoothed base fee. Minimum 20 gwei, ceiling 20,000 gwei. Target is about $0.001
  per ERC-20 transfer. Base fee goes to the proposer. A 1 gwei tip helps under load **[V]**.
- Gas is priced in native USDC (18 decimals). **At 20 gwei, 1M gas = 0.02 USDC.**
- Transactions priced below the minimum are **silently dropped** **[V]**.

### 2.3 USDC

- One balance, two interfaces: native (18 decimals) and ERC-20 at
  `0x3600000000000000000000000000000000000000` (**6 decimals**) **[V]**.
- Value transfers to `0x0` revert. Selfdestruct burns revert. Native sends to contracts are not
  guaranteed **[V]**.
- **Protocol-level blocklist:** transfers to or from blocklisted addresses revert and still consume gas
  **[V]**. Controller and in-contract semantics **[U]**.
- Show a single USDC balance, never native and ERC-20 separately **[V]**.

### 2.4 System and ecosystem contracts (mainnet) **[V]**

| Contract | Address |
|---|---|
| USDC | `0x3600000000000000000000000000000000000000` |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` |
| CCTP V2 TokenMessenger (domain 26) | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| CCTP V2 MessageTransmitter | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| Circle Gateway Wallet / Minter | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` / `0x2222222d7164433c4C09B0b0D809a9b52C04C205` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| CREATE2 factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |

### 2.5 Ecosystem services

| Need | Status |
|---|---|
| Oracles | Arc lists Chainlink, Chronicle, Pyth, RedStone, Stork **[V]**. Chainlink is the official partner (Data Feeds, Data Streams, CCIP, PoR) but is confirmed on **testnet** only. **No mainnet feed addresses are published** **[U]**. Pyth's EVM list does not include Arc yet **[U]** |
| Multisig | Safe appears to be in use on Arc mainnet **[U]**. Confirm singleton and factory addresses |
| Account abstraction | ERC-4337. Alchemy, Biconomy, Pimlico, Privy, ZeroDev, Dynamic, Circle Wallets, etc. **[V]** |
| Wallets | MetaMask, Ledger, Phantom, Rainbow, Trust, etc. viem and wagmi include Arc chain definitions **[V]** |
| Indexers | Alchemy webhooks, Envio, Goldsky, Pinax, The Graph, Thirdweb Insight **[V]** |
| Compliance | Chainalysis, Elliptic, TRM Labs **[V]** |
| Custody | Fireblocks, Ledger **[V]** |
| Cross-chain USDC | CCTP V2 (Arc = domain 26). Circle App Kit bridge **[V]** |
| Competitors | edgeX (perps, FX-perps partner), Hibachi, Synthra **[V]** |

---

## 3. Architecture

```
 Trader wallet (MetaMask / Rabby / Ledger / smart wallet)
   │  EIP-712 signTypedData(Order)           │ permit + deposit / withdraw
   ▼                                          ▼
 Next.js app + /api ──► Postgres            Vault (UUPS) ── USDC 0x3600… (6dp)
   │                        ▲  ▲                ▲   ▲
   │ orders                 │  │ logs            │   │ applyPnl / fee debit
   ▼                        │  │                 │   │
 Matcher (price-time) ──settleFillsSigned(batch)──► OrderGateway ──► Engine ──► FeeRouter
   │                        │  │                                     │  ▲        │ split
 TxSender (nonce mgr)       │  Indexer (getLogs by block) ◄──────────┘  │        ▼
                            │                                  OracleAdapter  Treasury Safe
 Oracle keeper ─ CEX median ┼──pushPrices──────────────────────►  ▲           Insurance
   └─ cross-check: Chainlink / RedStone / Stork on Arc            │
 Liquidation keeper ─ Multicall3 health scan ─► Liquidation ──────┘
 Funding keeper · Reconciler · Monitor · WS server
 Governance: Safe (N-of-M) ─► TimelockController (48h) ─► all proxies and admin roles
             Guardian Safe ─► PAUSER_ROLE only
```

**Trust model:** a trader's funds move only with that trader's signature (deposit, withdraw,
signed orders) or through contract-validated logic (settlement that matches signed terms,
permissionless liquidation). The operator can only settle fills consistent with what both
traders signed.

**Protocol invariants**
1. Withdrawals are validated against current account equity.
2. Liquidation is based on account health.
3. Funding derives from time-weighted mark–index premium, never oracle minus itself.
4. Every oracle read carries source, timestamp, confidence, and freshness bounds.
5. Trader balances + fee buckets + insurance − unsettled bad debt == vault USDC.
6. Upgrades and parameter changes pass through the timelock, with bounded parameters.

---

## 4. Phase A: Smart contracts

### 4.1 Toolchain and layout

- **`arc-foundry`** (pinned) for build, test, fork, and deploy. Solidity 0.8.x targeting Arc's Osaka
  baseline. OpenZeppelin Contracts + Upgradeable v5. ERC-7201 namespaced storage.

```
kryon-protocol/
  evm/
    foundry.toml  remappings.txt
    src/
      libraries/ KryonMath.sol RiskLib.sol FundingLib.sol LiquidationLib.sol
                 Types.sol Errors.sol Decimals.sol OrderLib.sol
      Vault.sol  Engine.sol  OrderGateway.sol  OracleAdapter.sol
      Liquidation.sol  Insurance.sol  RiskParams.sol  FeeRouter.sol
      governance/ KryonTimelock.sol Roles.sol
    script/  00_DeployImpls 01_DeployProxies 02_Wire 03_ConfigureMarkets
             04_ConfigureFees 05_Handover 99_VerifyDeployment   (.s.sol)
    test/    unit/ invariant/ differential/ fork/ upgrade/
  crates/    protocol-core, risk-engine (Rust reference model, used via ffi)
```

### 4.2 Contracts

| Contract | Responsibility |
|---|---|
| **Vault** | USDC custody via the ERC-20 interface only (`SafeERC20`). `receive`/`fallback` revert. `deposit`, `depositWithPermit` (EIP-2612, Permit2 fallback), `withdraw` gated by `RiskLib.validateWithdrawal`. Internal ledger at 1e18, converted at the 1e6 boundary in one `Decimals` library (**credit rounds down, debit rounds up**). `applyPnl` only from Engine. `absorbBadDebt` only from Insurance/Liquidation. Global and per-account deposit caps. `setCollateral` interface for future assets (e.g. EURC). |
| **Engine** | One position per `(trader, marketId)` with VWAP entry. Cross-margin at account level. Open/increase/reduce/close, execution price bands, OI caps, TWAP mark accumulator, funding indexes. **Funding tolerates `dt == 0`** (Arc timestamps are non-decreasing, not strictly increasing). |
| **OrderGateway** | EIP-712 `Order` / `Cancel`. `SignatureChecker` (EOA, ERC-1271, EIP-7702). Fill validation: size/price > 0, no self-trade, same market, opposite sides, not expired, not cancelled, **no overfill**, price within signed limit. `filled[orderHash]`. `cancelOrder`, `cancelUpTo(nonce)`. `settleFillsSigned(Fill[])` restricted to `OPERATOR_ROLE`, with **per-fill isolation**: each fill runs in `try this.settleOne()`, and failures emit `FillRejected(fillId, reason)` so a blocklisted or under-margined trader can't block the batch. |
| **OracleAdapter** | Publisher allowlist, quorum median, `maxAge`, `maxConfidenceBps`, per-update deviation bound. `pushPrices(ids[], prices[])`. Optional external reference feed per market with a `maxDivergenceBps` halt (§7). |
| **Liquidation** | Permissionless `liquidate(trader, marketId, maxSize)`. `RiskLib.planLiquidation`. Capped liquidator reward. Shortfall goes to Insurance. Penalty split through FeeRouter. |
| **Insurance** | Backstop fund. Stake / request-unstake / withdraw with cooldown. `payLiquidator`, `coverDeficit`, bad-debt ledger. Shares retired when a loss wipes the staked pool. Receives a fee share. |
| **RiskParams** | Per-market IM/MM/liquidation fee/OI caps/min fill notional, with hard bounds. Timelock-only. |
| **FeeRouter** | Fee schedule, caps, tiers, split, accrual, and claim (§5). |
| **Governance** | Safe N-of-M → OZ `TimelockController` (48h). Guardian Safe holds `PAUSER_ROLE`. `unpause` goes through the timelock. |

### 4.3 Design rules

1. **Timelock-owned from the deploy transaction sequence.** `05_Handover` grants all admin/upgrader
   roles to the timelock and renounces the deployer in the same run.
   `99_VerifyDeployment` fails if any EOA holds `DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE`,
   `FEE_ADMIN_ROLE`, or `RISK_ADMIN_ROLE`. The vault starts with `depositCap = 0` until this passes.
2. **Role separation:** `OPERATOR_ROLE` (settle), `PUBLISHER_ROLE` (oracle), `KEEPER_ROLE`
   (funding), `PAUSER_ROLE` (guardian), `FEE_TIER_ROLE` (bounded tier assignment).
3. **Single decimals boundary**, fuzzed.
4. **Checks-effects-interactions + `nonReentrant`** on every vault and insurance entry point.
5. **Storage-layout snapshots** diffed in CI for every upgradeable contract.
6. **Complete events.** The database is rebuildable from logs alone.
7. **Bounded setters:** hard min/max constants that even the timelock can't exceed.

---

### 4.4 Liquidation, backstop and ADL (decided 2026-09-17)

- **Liquidation moves the closed size to the Insurance backstop** at the oracle index, so long and
  short OI stay equal and invariant #5 holds exactly. The penalty pays a capped liquidator reward;
  the rest is split by the FeeRouter.
- **Partial-liquidation sizing** closes the smallest size that restores maintenance margin net of
  the penalty: `q = size·shortfall / (notional·(mm − fee)) + 1`, capped per step. This corrects
  the reference model (`crates/risk-engine`), which under-closed by `1/(mm − fee)`. Both
  implementations are differentially fuzzed, and a property test asserts that one uncapped step
  restores maintenance. The change is flagged in the audit package (G7).
- **ADL** closes backstop positions against in-profit counterparties and haircuts their realized
  gain by the unfunded shortfall (recorded bad debt that operating capital can't cover).
- **Backstop unwind.** Insurance implements ERC-1271 so the backstop can close its positions
  through the normal order book:
  - Orders are signed by a governance-revocable `BACKSTOP_SIGNER_ROLE` key.
  - On-chain limits: reduce-only; limit price within `maxUnwindDeviationBps` of the oracle index;
    `maxUnwindOrderSize` per order; `maxUnwindDailyNotional` per day. All bounded setters.
  - A leaked signer key can at most close backstop exposure near the index, in bounded amounts.
  - The monitor alerts on backstop exposure, and a runbook (`backstop-unwind.md`) covers operation.
  - **Mainnet gate:** backstop exposure per market stays under its OI-policy share.

## 5. Phase B: Trading fees and protocol revenue

Goal: Kryon earns trading fees on Arc mainnet from the first fill. Fees are enforced on-chain,
capped, transparent to traders, and accounted for exactly.

> Gaps in the current code this phase closes: fee config defaults to 0 bps and no deploy
> script sets it (`perp-engine/src/lib.rs:1240`). The fee recipient defaults to the admin key.
> The UI hardcodes `0.035% | 0.005%` (`OrderEntry.tsx:600`). The matcher stores `'0'` fees
> with a placeholder tx hash (`matcher-service.ts:279`).

### 5.1 Fee model

| Component | Mechanism |
|---|---|
| Maker / taker fee | bps of fill notional, charged at settlement in USDC |
| Per-market schedule | `FeeRouter.setMarketFees(marketId, makerBps, takerBps)` (timelock) |
| Maker rebate (optional) | signed `makerBps`. Allowed only if `takerBps + makerBps ≥ minNetFeeBps` |
| Volume tiers | on-chain tier table (timelock). Per-account assignment by `FEE_TIER_ROLE`, restricted to existing tiers |
| Referrals | optional signed `referrer` in `Order`. Referral share is claimable by the referrer |
| Liquidation penalty | `liquidationFeeBps` split between liquidator reward and insurance/treasury |
| Minimum fill notional | per market in RiskParams, also enforced by API/matcher |
| Funding | peer-to-peer. The protocol takes nothing |
| Deposit / withdraw | no protocol fee (gas only) |

### 5.2 Launch schedule (proposal)

| | Taker | Maker |
|---|---|---|
| All launch markets | **3.5 bps (0.035%)** | **0.5 bps (0.005%)** |
| Hard caps in code | ≤ 25 bps | −2 bps … 25 bps |
| Net-fee floor | `taker + maker ≥ 1 bps` | |

Benchmark against edgeX, Hibachi, and major perp venues before launch, and adjust via the timelock.

### 5.3 Settlement flow per fill

```
OrderGateway.settleOne(fill)
  ├─ Engine.applyFill(maker)  → realized PnL, OI, funding
  ├─ Engine.applyFill(taker)
  ├─ (makerFee, takerFee) = FeeRouter.quote(marketId, maker, taker, notional)
  ├─ Vault.applyPnl(maker, -makerFee); Vault.applyPnl(taker, -takerFee)
  ├─ Engine.requireInitialMargin(maker); Engine.requireInitialMargin(taker)
  ├─ FeeRouter.accrue(marketId, makerFee + takerFee, referrer)  → bucket balances
  └─ emit FillSettled(fillId, makerHash, takerHash, size, price,
                      makerFee, takerFee, makerTier, takerTier)
```

- Fees stay inside the vault as internal bucket balances (no per-fill token transfer).
- `FeeRouter.claim(bucket)` sends 1e6 USDC (rounded down) to that bucket's configured
  recipient. Anyone can call it, but funds go only to the configured recipient.
- Invariant #5 (§3) is fuzzed in tests and checked continuously by the monitor.

### 5.4 Fee split (proposal)

| Bucket | Share | Recipient |
|---|---|---|
| Treasury | 70% | Treasury Safe |
| Insurance | 20% | Insurance contract |
| Referral / rewards | 10% | FeeRouter bucket (accrues to treasury until the referral program is live) |

Shares sum to 10,000 bps (enforced) and are individually bounded, e.g. insurance ≥ 10% while
insurance/OI is below target.

### 5.5 Tiers

The stats aggregator computes 30-day volume, and the tier bot assigns tiers on-chain. The contract only
accepts existing tiers, and the monitor flags assignments that don't match computed volume.

### 5.6 Unit economics

At the 20 gwei floor. Gas figures are estimates to replace with `arc-forge snapshot`:

| Action | Est. gas | Cost | Frequency | Daily |
|---|---|---|---|---|
| Settle 1 fill | ~350k | ~$0.007 | per fill | volume-driven |
| Oracle push (8 markets) | ~250k | ~$0.005 | every 2s / 8s | ~$216 / ~$54 |
| Funding update (8 markets) | ~300k | ~$0.006 | hourly | ~$0.15 |
| Liquidation | ~400k | ~$0.008 | rare | – |

- 3.5 + 0.5 bps = **4 bps per fill**.
- **Measured (2026-09-16):** settling an opening fill costs ~558k gas in a 40-fill batch, not the
  ~350k estimate. At 20 gwei that is ~$0.011, so break-even is ~$28 of notional (~$39 at the
  ~28 gwei seen on mainnet).
- **Decision (2026-09-17):**
  - **Launch `minFillNotional` = $40** per market. It is a bounded config value, so the timelock
    can lower it.
  - **Gas pass before the audit freeze**, targeting ≤ 350k gas per fill:
    - read the oracle index once per fill instead of per side and per margin check;
    - compute account health once per trader per fill;
    - pack `Position`, `FundingState` and `MarkState` into `int128` fields;
    - drop the read-after-write used for the event.
  - When the target is met and verified with `arc-forge snapshot`, the timelock may lower the
    minimum to $20.
- Batch cap: ≤ 40 fills per `settleFillsSigned` until simulation shows headroom (40 measured at
  22.3M gas).
- The oracle is the largest fixed cost, so use deviation-triggered pushes plus a heartbeat (§7).
- The monitor reports **fees earned vs gas spent** per day, per service.

### 5.7 Off-chain fee work

| Where | Change |
|---|---|
| `OrderEntry.tsx` | Fee schedule and user tier from API. Estimated fee in USDC shown before signing |
| `/api/markets`, `/api/fees` (new) | Schedule, tiers, user tier, 30-day volume |
| Matcher | Fees from `FillSettled` receipts. Reject orders below `minFillNotional` |
| Indexer | Persist `FillSettled`, `FeeAccrued`, `FeeClaimed`, `FeeTierSet` |
| Portfolio / leaderboard | `feesPaid` from events |
| Monitor | Revenue vs gas, bucket balances, invariant #5, tier anomalies |
| Runbook | `fee-treasury.md`: claim cadence, signers, accounting export |
| Docs | `docs/trading/fees.md` |

### 5.8 Fee tests

- A fee can't push an account below initial margin.
- Rebate floor: no fill has a negative net fee.
- Setters revert above the hard caps.
- Split conservation: bucket sum equals fees charged, exact at 1e18.
- Claim rounding: claimed 1e6 ≤ accrued / 1e12. Dust remains.
- Invariant #5 holds under random fills, liquidations, deposits, withdrawals, and claims.
- `FEE_TIER_ROLE` can only assign existing tiers.

---

## 6. Phase C: Matching engine and off-chain services

### 6.1 Chain layer: `client/lib/chain/*`

| Module | Role |
|---|---|
| `clients.ts` | viem `publicClient` with `fallback([alchemy, quicknode, dRPC, public])`. One `walletClient` per role. **Startup asserts chain ID 5042** |
| `contracts.ts` | ABIs and typed bindings generated by `@wagmi/cli` from `evm/out` |
| `tx-sender.ts` | Nonce-managed sender (§6.2) |
| `settlement.ts` | Encode `Fill[]` + signatures → TxSender |
| `collateral.ts` | Multicall3 reads of vault config and balances |
| `oracle.ts` | `OracleAdapter.latest(ids)` |
| `refprice.ts` | External reference feed reads (§7) |
| `lib/market/eip712.ts` | Single source of typed-data definitions for UI, API, matcher, and agents. CI asserts `hashTypedData == OrderGateway.hashOrder` on a fork |

### 6.2 TxSender

- One instance per key. Local nonce seeded from `getTransactionCount(pending)`. Nonce-gap healing on start.
- Fees: `maxFee = max(2 × baseFee, 40 gwei)`, tip 1 gwei. The 20 gwei floor is enforced.
- Dropped-transaction detection: no receipt or mempool entry after 3s → rebroadcast. After 10s, replace at +15%.
- Every transaction is written to `TxJob` before broadcast, so the reconciler recovers after a crash.
- **One key per service**, so services never share nonces.

### 6.3 Matching engine

`lib/market/matcher.ts` (price-time priority, partial fills, replace resets priority,
market-order book walking) is kept as-is. Around it:

- **Single writer per market.** Scale by sharding markets across processes, each with its own operator key.
- 250–500ms tick. Each tick sends one `settleFillsSigned` batch per market (cap ~40 fills /
  ~14M gas, under the 30M block limit), sized from simulation.
- Optimistic book: fills show as *pending* over WS and are confirmed on receipt (≤1s). `FillRejected`
  rolls back the off-chain fill and re-opens the remaining size.
- Pre-trade checks: signature, expiry, nonce, `minFillNotional`, cached margin estimate.
- Real tx hashes and block numbers on every `Fill`.
- Optional address screening (Chainalysis/TRM) at `POST /api/orders`, cached.

### 6.4 Services

| Service | Behaviour on Arc |
|---|---|
| `matcher-service.ts` | §6.3 |
| `oracle-keeper.ts` | CEX median + USDC de-peg guard. `pushPrices` batch. Deviation/heartbeat schedule. External reference guard |
| `state-indexer.ts` | Block cursor. `getLogs` in ≤2,000-block windows. Idempotent on `(txHash, logIndex)`. Optional Goldsky/Envio as a reconciliation source |
| `settlement-reconciler.ts` | Drives `TxJob` using TxSender rules. Re-simulates before resend. Records decoded revert reasons |
| `liquidation-keeper.ts` | Multicall3 `accountHealth` scans over accounts with open positions |
| `funding-keeper.ts` | Periodic `updateFunding`. Verifies on-chain state after each update |
| `monitor.ts` | Oracle staleness, bad debt, settlement failures, liquidation backlog, signer USDC balances, dropped/replaced tx rate, RPC failover, proxy implementation drift, role drift, invariant #5, revenue vs gas, oracle divergence |
| `ws-server.ts` | Orderbook deltas and trades, with pending/confirmed fill states |
| `stats-aggregator.ts` | Leaderboard/portfolio in 1e6 units. Fees from events. 30-day volume for tiers |
| `keeper-refill.ts` | USDC top-ups to service keys from an ops Safe allowance |

---

## 7. Phase D: Oracle design

No oracle provider has confirmed Arc **mainnet** feed addresses yet, so launch does not depend
on one:

1. **Mark/index = Kryon's pushed CEX median** (Binance, Coinbase, Kraken; ≥2 sources; USDC
   de-peg guard).
2. **Push policy:** push on ≥5 bps move, else a 5s heartbeat. On-chain `maxAge` = 15s.
3. **Independent cross-check:** Chainlink Data Feeds → RedStone → Stork → Chronicle, whichever
   publishes Arc mainnet feeds for our assets first. It starts as an off-chain halt in the keeper and
   moves on-chain (`maxDivergenceBps`) once feeds are confirmed.
4. **2–3 publisher keys on separate hosts**, so the quorum median is real.
5. Markets without an external reference launch with lower OI caps.
6. Later: evaluate Chainlink Data Streams as the primary mark once it is on Arc mainnet.

---

## 8. Phase E: Frontend and agent API

### 8.1 Wallet and chain

- wagmi + viem + RainbowKit with `arc` / `arcTestnet` from `viem/chains`. Injected (MetaMask,
  Rabby), WalletConnect, Coinbase, and Ledger connectors.
- Wrong-chain banner + `switchChain`. Explorer links to `explorer.arc.io`.
- Post-launch option: smart-wallet onboarding (Privy/Dynamic + Pimlico paymaster). ERC-1271 is
  already supported by the gateway.

### 8.2 Flows

| Flow | Implementation |
|---|---|
| Place order | `signTypedData(Order)`. Fee estimate shown |
| Cancel | `signTypedData(Cancel)` (off-chain), or on-chain `cancelOrder` / `cancelUpTo` |
| Deposit | EIP-2612 `permit` + `deposit` in one tx (fallback approve → deposit) |
| Withdraw | `withdraw(amount)`, equity-gated |
| Deposit from another chain | Circle App Kit bridge (CCTP V2) into the user's Arc wallet, then deposit |

- Single USDC balance row. Warn if wallet USDC is below a ~$0.10 gas buffer.
- Addresses: checksum for display, lowercase in the database.
- `AMOUNT_PRECISION` = 1e6. Prices at 1e18.
- `networks.ts`: `NETWORK_IDS = ["arc-mainnet","arc-testnet"]`, `NEXT_PUBLIC_KRYON_NETWORK`,
  `NEXT_PUBLIC_CONTRACT_*` as 0x addresses. Keep the literal `process.env.X` rule for Next.js
  inlining.
- Dependencies: `viem`, `wagmi`, `@rainbow-me/rainbowkit`, `@wagmi/cli` (dev).

### 8.3 Agent API

Rewrite `docs/docs/agents/*` and `client/public/docs/agents`: EIP-712 domain and types with viem
and ethers examples, units (1e6 amounts, 1e18 prices), Arc chain ID and addresses, and fee fields.
Serve the typed-data definition at `/api/eip712`.

---

## 9. Phase F: Database

Fresh Neon database with a new baseline migration.

| Model | Shape |
|---|---|
| `BlockCursor` | `network, contract, blockNumber BigInt, blockHash` |
| `ProtocolEvent`, `Fill`, `OracleSnapshot`, `FundingUpdate`, `BalanceChange`, `PnlEvent`, `KeeperAction` | `blockNumber BigInt`, `logIndex Int`, unique `(network, txHash, logIndex)` |
| `Order` | + `orderHash @unique`, + `referrer?`. `signature` 0x hex. Unique `(owner, nonce)` |
| `Fill` | `feeMaker`/`feeTaker` (1e6), tiers, `status` (`PENDING`/`SETTLED`/`REJECTED`), `rejectReason` |
| `Position` | populated by the indexer from `PositionChanged` events |
| `TxJob` | `fromAddress`, `nonce`, `rawTx`, `maxFeePerGas`, `maxPriorityFeePerGas`, `submittedHash`, `replacedByHash`, `gasUsed`, `effectiveGasPrice`, `status` |
| `DeploymentArtifact` | `proxy`, `implementation`, `codeHash`, `gitCommit`, `arcForgeVersion` |
| `GovernanceProposal` | timelock `operationId`, `predecessor`, `salt`, `calls`, `readyAt`, `executed` |
| `FeeAccrual` / `FeeClaim` / `FeeTierAssignment` | fee revenue ledger (new) |
| `GasSpend` | daily gas used and USDC cost per service (new) |
| `TraderStat`, `LeaderboardSnapshot`, `PortfolioSnapshot` | 1e6 units |
| All address columns | CHECK `~ '^0x[0-9a-f]{40}$'` |
| `network` | `arc-mainnet` / `arc-testnet` |

---

## 10. Phase G: Infrastructure, keys, CI/CD

### 10.1 Hosting

OCI A1.Flex runs the PM2 service fleet (+ Postgres or Neon), with Cloudflare Tunnel for web and WS.
Update `ecosystem*.config.cjs` (one process per matcher shard, no TTL keeper),
`Dockerfile.services`, `docker-compose.yml`, `render.yaml`, `wrangler.jsonc`, and
`infra/a1flex/*` env seeding.

### 10.2 RPC

`infra/rpc/arc-rpc.md`: paid primary (Alchemy or QuickNode, with WebSocket), a second provider
(dRPC/Blockdaemon), and the public RPC last. Per-service request budgets. Confirm archive needs for
indexer backfill.

### 10.3 Keys

| Role | Type | Holds | Custody |
|---|---|---|---|
| Deployer | EOA, single use | nothing after handover | ceremony key, retired |
| Governance | Safe N-of-M | timelock proposer | hardware wallets, distinct people |
| Guardian | Safe | `PAUSER_ROLE` | on-call |
| Treasury | Safe | fee claims | finance signers (Fireblocks optional) |
| Operator ×shards | EOA | `OPERATOR_ROLE` + gas | KMS / encrypted on host |
| Oracle publishers ×2–3 | EOA | `PUBLISHER_ROLE` + gas | separate hosts |
| Funding keeper | EOA | `KEEPER_ROLE` | host |
| Liquidator | EOA | – (permissionless) | host |
| Fee-tier bot | EOA | `FEE_TIER_ROLE` | host |
| Ops refill | Safe allowance | gas budget | ops |

The monitor alerts when any service key has less than 1 day of gas.

### 10.4 Deploy artifacts and runbooks

- `infra/deploy/environments/arc-{mainnet,testnet}.toml`, `arc-mainnet-deployment.json`
  (proxies, implementations, code hashes, commit, role holders), all sources verified on the explorer.
- Runbooks: `oracle-failure`, `matcher-failure`, `settlement-stuck`, `rollback` (pause →
  timelock upgrade), `incident`, `mainnet-readiness`, `timelock-operations`, `fee-treasury`,
  `key-rotation`.
- `infra/budget`: gas snapshot baseline + daily cost model (§5.6).
- `infra/audit/build-audit-package.sh`: `evm/` + test and coverage reports.

### 10.5 CI/CD

| Workflow | Contents |
|---|---|
| `ci.yml` | pinned `arc-foundry`; fmt, build `--sizes`, test, coverage, gas snapshot diff, storage-layout diff, Slither; `cargo test` for reference crates; client tests; EIP-712 parity test |
| `codeql.yml`, `dependency-review.yml` | keep |
| `mainnet-preflight.yml` | chain ID 5042, config addresses == deployment JSON, role holders == expected (no EOA admins), fee schedule == approved |
| `deploy-production.yml` | Arc env names |
| `production-validation.yml` | oracle freshness, matcher heartbeat, invariant #5 |
| `invariants-nightly.yml` (new) | long Echidna/Medusa + differential fuzz |

---

## 11. Phase H: Codebase cleanup

The repository becomes Arc-only. All legacy chain code is removed:

- `kryon-protocol/contracts/**` (Soroban) is deleted once the Solidity suite reaches parity (keep
  `crates/` as the math reference).
- `client/lib/stellar/**` is deleted and replaced by `client/lib/chain/**`.
- `@stellar/stellar-sdk` and `@stellar/freighter-api` are removed from `package.json`.
- Legacy-only scripts, settlement co-sign UI/API, TTL keeper, trustline/SAC/USDT0/XLM tooling,
  WASM optimisation and Soroban budget tooling, and old deployment manifests are deleted
  (full list in Appendix A).
- `README.md`, `ARCHITECTURE.md`, `client/README.md`, `client/CLAUDE.md`, `client/AGENTS.md`,
  and `docs/docs/**` are rewritten for Arc. Diagrams are regenerated.
- **Sequencing (decided 2026-09-17):** code that nothing running depends on is removed first
  (Soroban contracts, Stellar-only scripts, the Soroban CI job, done in `e0a327f`). Stellar
  client code, services and API routes are removed as Steps 2–5 replace them, so the app always
  builds. **Infra files (Dockerfiles, PM2 configs, `render.yaml`, `wrangler.jsonc`, `infra/**`,
  runbooks) are kept as the template for their Arc equivalents** and are removed or rewritten in
  Step 6.
- CI check: `grep -ri "stellar\|soroban\|freighter\|xlm"` must return nothing outside
  `crates/` comments and market symbols you choose to keep.

---

## 12. Testing, audit, and launch gates

| Gate | Criteria |
|---|---|
| G1 Math parity | Differential fuzz of Solidity libs vs Rust `risk-engine`: 1M runs, zero mismatches |
| G2 Contract tests | Line coverage ≥95%, branch ≥90%. The 6 invariants pass 24h campaigns |
| G3 Static analysis | Slither: no unresolved High/Medium |
| G4 Arc semantics | `arc-anvil` fork tests: USDC dual decimals, blocklisted counterparty in a batch, equal timestamps, 20 gwei floor, native value rejected |
| G5 Testnet E2E | deposit → trade → funding → liquidation → withdraw → fee claim. Drills: liquidation, failure recovery, soak, 40+ wallet load |
| G6 Soak | 7 days on Arc testnet: no unreconciled `TxJob`, invariant #5 holds, fees match events |
| G7 Audit | External audit (2 firms, or 1 firm + contest). No open Critical/High. Bug bounty live |
| G8 Deploy verification | `99_VerifyDeployment`: roles, wiring, fees, risk params, no EOA admin, sources verified |
| G9 Guarded launch | Deposit cap (e.g. $250k total / $10k per account), low OI caps, 2 markets. Raise via timelock after 2 clean weeks |

---

## 13. Timeline

| Week | Work |
|---|---|
| 1 | Decisions (§15). Confirm [U] items. `arc-foundry` scaffold. Typed-data and fee spec |
| 2–3 | Solidity libraries + differential harness |
| 3–7 | Contracts incl. FeeRouter. Unit + invariant tests. In parallel: chain layer + TxSender |
| 4–8 | Services, database, frontend (wagmi, EIP-712, deposit, fees UI) |
| 8–9 | Deploy scripts, monitoring, runbooks. Arc testnet deploy |
| 9–11 | Testnet E2E, drills, 7-day soak |
| 10–14 | External audit + fixes |
| 14–15 | Mainnet deploy ceremony → verification → guarded launch |
| 15–16 | Cap raises, more markets, fee tiers, referral program. Legacy code removal complete |

≈ **12–16 weeks.**

---

## 14. Risk register

| Risk | Mitigation |
|---|---|
| Solidity math diverges from the reference model | Differential fuzzing, invariants |
| Decimal errors (1e6/1e18) | Single conversion library, rounding rules, fuzzing |
| Upgrade-key compromise | 48h timelock + Safe + role-drift alerts + guardian pause |
| No external oracle feed on mainnet at launch | Multi-source CEX median, multi-publisher quorum, deviation bounds, low OI caps |
| Blocklisted address in a batch | Per-fill isolation, optional pre-trade screening |
| Dropped low-fee transactions | TxSender floor, drop detection, reconciler |
| Operator key compromise | Gateway enforces signed terms. Role rotation via timelock |
| Fee misconfiguration | Code-level caps, preflight asserts, net-fee floor |
| Fees below gas cost | `minFillNotional` $40 at launch, settlement gas pass (§5.6), deviation-based oracle pushes, revenue-vs-gas monitor |
| Backstop holds liquidated exposure | ERC-1271 backstop unwind with on-chain limits (§4.4), ADL, exposure alerts |
| Day-one chain (tooling/RPC/explorer issues) | Testnet first, multiple RPCs, pinned `arc-foundry` |
| Regulatory exposure (perps + fees) | Legal review, geofencing, ToS, screening (not legal advice) |
| Competition on Arc | Fee tiers and rebates, fast settlement UX |

---

## 15. Open decisions

1. Fee schedule: taker/maker bps (proposed 3.5 / 0.5), hard caps, rebates at launch?
2. Fee split (proposed 70 treasury / 20 insurance / 10 referral).
3. `minFillNotional`: **decided 2026-09-17: $40 at launch**, lowered to $20 by the timelock
   after the gas pass (§5.6).
4. Signers and thresholds for the governance, guardian, and treasury Safes.
5. Upgradeability: UUPS + 48h timelock (recommended) vs immutable.
6. External oracle provider once Arc mainnet feeds are published.
7. Launch markets (proposed BTC-PERP + ETH-PERP, then SOL/XRP/ADA/BNB/TRX/XLM).
8. Collateral: USDC only at launch (recommended). EURC later?
9. Compliance: geofenced jurisdictions, screening vendor, ToS.
10. Wallet stack (RainbowKit recommended). Smart-wallet onboarding at launch?
11. RPC provider/plan, auditor(s), bug bounty size.
12. Hosting: keep OCI A1.Flex (recommended) or managed infra.

---

## 16. Sources

- Arc – Connect to Arc: https://docs.arc.io/arc/references/connect-to-arc
- Arc – EVM differences: https://docs.arc.io/arc/references/evm-compatibility
- Arc – Contract addresses: https://docs.arc.io/arc/references/contract-addresses
- Arc – Gas and fees: https://docs.arc.io/arc/references/gas-and-fees.md
- Arc – Oracles: https://docs.arc.io/arc/tools/oracles.md
- Arc – Node providers: https://docs.arc.io/arc/tools/node-providers.md
- Arc – Data indexers: https://docs.arc.io/arc/tools/data-indexers.md
- Arc – Account abstraction: https://docs.arc.io/arc/tools/account-abstraction.md
- Arc – Compliance vendors: https://docs.arc.io/arc/tools/compliance-vendors.md
- Arc – Opt-in privacy: https://docs.arc.io/arc/concepts/opt-in-privacy.md
- Arc – Deploy on Arc: https://docs.arc.io/arc/tutorials/deploy-on-arc
- Arc Foundry: https://github.com/circlefin/arc-foundry
- Arc blog – Chainlink on Arc: https://www.arc.io/blog/how-chainlink-unlocks-new-design-capabilities-on-arc
- Circle – Arc mainnet launch: https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet
- Circle – CCTP supported blockchains: https://developers.circle.com/cctp/cctp-supported-blockchains
- Pyth – EVM contract addresses: https://docs.pyth.network/price-feeds/core/contract-addresses/evm
- Uniswap – Arc chain playbook: https://github.com/Uniswap/UniswapX/blob/main/playbook/chains/arc.md
- arc-node – Arcscan verification: https://github.com/circlefin/arc-node/pull/396
- CryptoRank – Arc ecosystem overview: https://cryptorank.io/insights/analytics/arc-mainnet-launch-ecosystem-overview

---

## Appendix A: File-by-file change inventory

**Rewrite for Arc**
- `client/config/index.ts`, `config/networks.ts`
- `client/lib/market/signing-message.ts`, `signed-intent.ts` → `eip712.ts`. `matcher.ts` gets minor changes
- `client/lib/validation.ts`, `oracle-activity.ts`, `secrets-check.ts`, `deploy-preflight.ts`, `network-*.ts`, `format.ts`, `math.ts`, `stats.ts`
- `client/app/api/{orders,orders/cancel,orders/cancel-all,orders/list,fills,positions,funding,portfolio,markets}/*`
- `client/features/wallet/components/WalletConnect.tsx`, `features/trade/components/{OrderEntry,DepositWithdrawDialog}.tsx`, `features/network/*`, `app/layout.tsx`, `app/LandingPage.tsx`
- Services: `matcher-service`, `oracle-keeper`, `state-indexer`, `settlement-reconciler`, `liquidation-keeper`, `funding-keeper`, `monitor`, `stats-aggregator`, `keeper-refill`, `ws-server`
- Ops → `forge script` + Safe/timelock helpers: `mainnet-deploy`, `testnet-deploy`, `upgrade-contracts`, `governance-handover`, `add-market`, `set-risk-params`, `update-oracle-publisher`, `seed-markets`, `mainnet-seed-insurance`, `production-gate`, `live-production-gate`, `verify-decentralization`, `check-vault-balance`, `clear-stale-jobs`, `apply-migration`
- Drills and load tests → viem on Arc testnet: `liquidation-drill`, `failure-recovery-test`, `e2e-testnet`, `load-test`, `soak-test`, `stress-test`, `_loadtest_*`, `_drill_*`
- `kryon-protocol/prisma/schema.prisma` + baseline migration
- `kryon-protocol/infra/**`, `.github/workflows/*`
- `README.md`, `ARCHITECTURE.md`, `client/README.md`, `client/CLAUDE.md`, `client/AGENTS.md`, `docs/docs/**`

**New**
- `kryon-protocol/evm/**`
- `client/lib/chain/**` (incl. `tx-sender.ts`), `client/app/api/fees`, `client/app/api/eip712`
- `docs/docs/trading/fees.md`. Runbooks `timelock-operations.md`, `fee-treasury.md`, `key-rotation.md`, `infra/rpc/arc-rpc.md`

**Delete**
- `kryon-protocol/contracts/**`
- `client/lib/stellar/**`
- `client/features/trade/components/SettlementModal.tsx`, `client/app/api/settlements/**`
- `client/scripts/ttl-keeper.ts`, `setup-usdc-*.ts`, `*usdt0*`, `list-usdt0-testnet.sh`, `redeploy-*.ts`, `rewire-liquidation.ts`, `transfer-admin-to-governance.ts`, `test-*settle*.ts`, `test-xlm-*`, `test-usdc-*`, `test-final-usdc.ts`, `test-two-account-settle.ts`, `test-sim-only.ts`, `diag-usdc-settle.ts`, `cutover-testnet-v3.ts`, `deploy-testnet-usdt0.ts`, `testnet-usdt0-golive.ts`, `faucet-usdt0.ts`, `railway-testnet-entrypoint.sh`, `migrate-add-order-signature.ts`
- `kryon-protocol/infra/budget/*soroban*`, `infra/rpc/stellar-rpc.md`, `infra/deploy/optimize-wasm.py`, `infra/deploy/role-transfer.sh`, `infra/deploy/*deployment*.{json,toml}`, `infra/deploy/*-markets.json`, `infra/deploy/runbooks/{governance-admin-transfer,mainnet-migration}.md`
- `client/_drill_ecosystem.config.cjs`, `client/ecosystem.testnet.config.cjs` (regenerated for Arc testnet)

## Appendix B: Housekeeping before `git init`

- Add to `.gitignore` or delete: `client/scripts/_loadtest_*_keys.json`,
  `_loadtest_*wallets*.json`, `_drill_wallets.json`, `_drill_state.json`,
  `_loadtest_*_state.json` (**private keys**), `client/kryon-web.tar.gz`, `client/logs/`,
  `client/.wrangler/`, `client/.vercel/`, `Audit Reports/` (if not public).
- Remove `kryon-protocol/infra/deploy/*secrets*.env` from the working tree. New Arc keys never
  live in the repo.
