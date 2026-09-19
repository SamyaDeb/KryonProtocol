# Kryon Oracle Strategy: Chainlink Readiness Roadmap

**Written:** 2026-09-18, on `service/keepers` (Phase 3 step 5, the keeper and reconciler
workstream). **Decision owner:** repository owner. **Status:** Tier 0 approved and in build;
Tiers 1 and 2 are proposals, neither started.

Kryon's mark price is the single most safety-critical input the protocol takes. A stale feed
halts trading, liquidation and withdrawals for every account holding that market; a *wrong* feed
drains the insurance fund. This document records which oracle Kryon uses, why, and the staged
path to sourcing prices from Chainlink without touching contracts that are frozen for audit.

---

## 1. The finding that shapes everything

There are two different Chainlink products, and only one of them is a perp oracle.

| | **Data Feeds** | **Data Streams** |
|---|---|---|
| Model | Push. DON writes to an on-chain aggregator | Pull. DON signs reports off-chain, consumer verifies on-chain |
| Latency on Arc | **24h heartbeat, 0.5% deviation** | Sub-second |
| Arc mainnet status | **Live**, 30 feeds in the directory | **Announced, not deployed** |
| Usable as Kryon's mark | **No** | Yes, once it exists on Arc |
| Usable as a divergence cross-check | Yes — this is what we use it for | Yes |

### 1.1 Why Data Feeds cannot be the mark

Two independent reasons, either one sufficient:

**Economic.** A 0.5% deviation threshold means the on-chain price may sit 0.5% away from the
real market at any moment, by design. At 10× leverage that is 5% of margin available risk-free
to anyone who watches both prices. This is not hypothetical: GMX v1 lost ~$565K of LP funds on
2022-09-18 to exactly this trade on AVAX/USD, and GMX's own remediation was to migrate to
Chainlink's low-latency oracles ([technical analysis][gmx-analysis], [GMX vote][gmx-vote]).

**Mechanical.** `OracleAdapter.MAX_FEED_AGE = 300`, so every feed's `cfg.maxAge` is at most 300
seconds. A feed that may legitimately not update for 24 hours can never satisfy a 300-second
freshness check. Piping Data Feeds in as the mark would halt every market within five minutes of
listing.

### 1.2 Why Data Streams is not yet an option

Arc [joined Chainlink Scale on 2026-06-30][cl-eco] with CCIP, Data Feeds, Data Streams and Proof
of Reserve. Scale is a commercial agreement, not a deployment. As of 2026-09-18 Arc does **not**
appear on [Chainlink's Data Streams supported-networks page][cl-streams-networks], which lists
seven chains (Arbitrum, Avalanche, Base, BNB Chain, Ethereum, Optimism, Polygon), and no Arc
Verifier proxy address is published.

**Arc Data Streams is therefore a dependency on Chainlink with no published date.** Kryon's
mainnet launch must not block on it. Everything below is arranged so that it can be adopted
incrementally, the moment it ships, without a rewrite.

---

## 2. Does Chainlink remove the need for a keeper?

No, under any of the three tiers — and it is worth separating two questions.

**The oracle publisher is one of four processes.** The settlement reconciler, funding keeper and
liquidation/ADL keeper are unaffected by any oracle decision. Funding still has to be advanced
hourly under `KEEPER_ROLE`, underwater accounts still have to be liquidated, and transactions
still have to be driven to a terminal state. Three-quarters of the keeper workstream is
independent of this document.

**A pull oracle does not eliminate the price process, it relocates it.** In a pull model the
signed report is delivered at the point of use — GMX v2 runs keepers that carry the price with
the action. For Kryon that is strictly worse than the current shape: `Engine.indexPrice`,
`Engine.accountHealth`, `Liquidation.liquidate`, `Liquidation.adl`, `Insurance.unfundedShortfall`
and `Vault` withdrawals all read the stored snapshot. Making price pull-only means every one of
those entry points must accept and verify a report — a change across the entire protocol rather
than one adapter.

**What does change is the trust model, and that is the real prize.** Today `pushPrices` trusts
`PUBLISHER_ROLE`: our key asserts a price and the contract believes it, bounded only by quorum
and the five guards. Under Tier 2 a compromised publisher key cannot invent a price, because the
adapter verifies a Chainlink signature. The keeper stops being a trusted price originator and
becomes an untrusted relay. That is the objective worth aiming at, and it is achievable by
changing one contract.

---

## 3. The three tiers

### Tier 0 — CEX median on the frozen contracts (in build, no contract change)

The only configuration shippable on the audit-frozen contracts.

- **Mark:** median of three independent venue adapters (Binance, Coinbase, Kraken), minimum two
  live, outliers beyond `ORACLE_MAX_SOURCE_DEVIATION_BPS` dropped, pushed by two publisher keys
  so the on-chain quorum (`minPublishers = 2`) is real.
- **Cross-check:** Chainlink Data Feeds through `OracleAdapter.ReferenceFeed`, already configured
  in `arc-mainnet.toml` at `reference_max_divergence_bps = 150`,
  `reference_max_age_secs = 90000` (25h, sized to the 24h heartbeat).
- **De-peg guard:** off-chain halt when USDC/USD leaves the peg by more than
  `USDC_DEPEG_HALT_BPS`, cross-checked against Chainlink USDC/USD
  (`chainlink_usdc_usd` in the deploy config).

**The one design decision that carries forward:** every venue sits behind a single
`PriceSource` interface — `fetch(symbol) -> { price, confidence, ts, healthy }` — with its own
timeout, staleness bound and health flag. A source is a file, not a refactor. This is what makes
Tier 1 cheap, and it is the reason to get the interface right now rather than later.

### Tier 1 — Chainlink as a price *source* (no contract change)

Ships whenever Arc Data Streams goes live. Adds `ChainlinkStreamsSource implements PriceSource`,
reading the Data Streams API off-chain, verifying the report signature inside the keeper, and
feeding the result into the same median as any other source.

- **No contract change, no audit impact.** It can land while the contracts are in audit.
- Source composition is per-market config: Streams-only, Streams + CEX median, or CEX-only.
  Markets migrate one at a time rather than in a big bang.
- **Trust model:** better data, unchanged trust boundary. The publisher still asserts the price
  on-chain; quorum and all five guards still apply.
- **Estimated effort:** ~2 days once the API is reachable, given the Tier 0 interface.

### Tier 2 — on-chain report verification (contract change, post-audit)

`OracleAdapter` gains a `pushVerifiedReports` path that calls the Chainlink Verifier proxy and
derives the snapshot from the verified report, replacing `PUBLISHER_ROLE` trust with signature
verification.

- Snapshot storage and every downstream reader are unchanged, so the change is **scoped to one
  contract**. Engine, Liquidation, Vault and Insurance are untouched. That is what makes this
  tractable rather than a rewrite.
- **Requires a contract modification and its own audit round.** It belongs after the current
  freeze clears.
- **Gated on Chainlink shipping a Verifier on Arc**, which has not happened.

**Not started, and not to be started without an explicit decision.** The contracts are frozen for
audit; this is recorded as a proposal, not as pending work.

---

## 4. Market list: dropping ADA and XLM

**Decision (2026-09-18): ADA-PERP and XLM-PERP are dropped.**

They are the only two markets with no `reference_aggregator` in `arc-mainnet.toml` — Chainlink
publishes no ADA/USD or XLM/USD feed on Arc. Removing them leaves six markets (BTC, ETH, SOL,
XRP, BNB, TRX), every one of which has Chainlink cross-check coverage, and eliminates the
"some markets run on the CEX median alone" asymmetry from the risk surface.

### 4.1 Do not set `ReferenceFeed.required = true`

Full coverage tempts this, and it is the wrong call on mainnet.

`required = true` means an unreadable or stale Chainlink feed **skips the update**, which lets the
price go stale, which halts the market. Against a 24h heartbeat and
`reference_max_age_secs = 90000` (25h), that leaves roughly **one hour of slack** before a single
missed Chainlink update halts trading on that market. It hands Chainlink's uptime a kill switch
over Kryon.

**Keep `required = false`** and put the hard stop in the publisher's own divergence guard, which
we operate, can alert on, and can tune without a timelocked governance change. The protection is
equivalent; the failure mode is not.

### 4.2 Files this touches (cross-session)

Market removal is **not** in the keeper workstream's ownership and is tracked as an open item:

| File | Owner |
|---|---|
| `kryon-protocol/infra/deploy/environments/arc-{mainnet,testnet,local}.toml` | deploy config (do-not-touch list for the keeper session) |
| `client/config/index.ts` | Session C |
| `client/app/api/markets/route.ts`, `client/app/api/ready/route.ts` | Session C |
| `client/app/LandingPage.tsx`, `client/features/trade/components/TradeChart.tsx` | Session C |
| `client/scripts/{mainnet,testnet}-deploy.ts`, `live-production-gate.ts` | unassigned |
| `docs/docs/**` (7 files referencing ADA/XLM) | unassigned |

Market ids are explicit in config, so removing two markets renumbers nothing.

**Status (2026-09-19):** all three environment TOMLs now list the same six markets; arc-local
was the last. What remains is the API/UI (`client/lib/markets.ts`, `LandingPage.tsx`,
`TradeChart.tsx`), the legacy deploy scripts and `docs/docs/**`.

---

## 5. Testnet and local testing

There are **no Chainlink Data Feeds on Arc testnet** — the divergence and de-peg drills cannot use
a live reference there. Use `kryon-protocol/evm/test/mocks/MockAggregator.sol`, which is already
in the tree, for the arc-anvil drills. This is unchanged by anything above.

---

## 6. Open items

| # | Item | Owner | Blocked on |
|---|---|---|---|
| 1 | ADA/XLM removal across config, API, UI and docs (§4.2). **Config done**: gone from all three environment TOMLs (arc-local on 2026-09-19). API, UI, deploy scripts and docs remain | owners in §4.2 | — |
| 2 | Tier 1 adoption | keepers | Chainlink shipping Data Streams on Arc |
| 3 | Tier 2 `OracleAdapter` change + audit round | contracts | audit freeze clearing, and #2 |
| 4 | Re-check Pyth / RedStone / Chronicle Arc mainnet status | unassigned | — periodic |

Item 4 matters because a second low-latency source would strengthen the Tier 0 median well before
Chainlink Streams arrives. As of 2026-09-18, per `docs/arc-facts.md` §4.3: Pyth and Stork are
Arc **testnet** only, RedStone and Chronicle are unconfirmed on both networks.

---

[gmx-analysis]: https://medium.com/@thedailychris/technical-analysis-of-gmx-v1-s-avax-usd-price-manipulation-exploit-21fbf762fa26
[gmx-vote]: https://www.fxstreet.com/cryptocurrencies/news/decentralized-exchange-gmx-votes-to-use-chainlink-low-latency-oracles-202304251002
[cl-eco]: https://www.chainlinkecosystem.com/ecosystem/arc
[cl-streams-networks]: https://docs.chain.link/data-streams/supported-networks
