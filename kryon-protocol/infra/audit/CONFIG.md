# Approved mainnet configuration

Source: `kryon-protocol/infra/deploy/environments/arc-mainnet.toml`, decided 2026-09-17 (Phase 1).
`arc-testnet.toml` uses the same economic parameters. Testnet differs only in addresses, OI caps
(BTC 25, ETH 400), `min_publishers = 1`, no Chainlink references (none published on testnet) and
`open_deposits_at_deploy = true`.

Every value is set by `KryonDeploy` from the TOML and later changeable only by the timelock within
the hard bounds shown.

## Decisions

| # | Decision | Value | Hard bound in code |
|---|---|---|---|
| 2 | Taker fee | `taker_rate = 350` (3.5 bps) | `FeeRouter`: 0 … `MAX_TAKER_RATE` 2500 (25 bps) |
| 2 | Maker fee | `maker_rate = 50` (0.5 bps) | `MIN_MAKER_RATE` −200 … `MAX_MAKER_RATE` 2500; negative only with rebates on |
| 2 | Net-fee floor | `min_net_rate = 100` (1 bps); maker + taker ≥ floor | 100 … 2500 |
| 2 | Rebates | `rebates_enabled = false` | — |
| 3 | Fee split | treasury 7000 / insurance 2000 / referral 1000 bps | sum = 10000; insurance ≥ 1000; referral ≤ 2000 |
| 3 | Referrals | `referrals_enabled = false`: the 10% referral share accrues to **treasury** (effective 80 / 20) | referrer must be governance-approved and ≠ payer |
| 3 | Liquidation-fee split | `liquidation_insurance_bps = 5000` of the penalty remainder to insurance, rest to treasury | 1000 … 10000 |
| 4 | Liquidator reward cap | `max_reward_bps = 15` | `Liquidation`: 1 … 1000 |
| 4 | Partial liquidation step | `partial_liquidation_bps = 5000` | 1000 … 10000 |
| 5 | Launch markets | BTC-PERP, ETH-PERP active; SOL, XRP, BNB, TRX listed inactive (reduce-only); XLM, ADA removed | ≤ 32 markets, ids 1–255, oracle id immutable once listed |
| 5b | Deposit caps | total $250,000 (`250000000000`), per account $10,000 (`10000000000`); `open_deposits_at_deploy = false` | caps opened by timelock after verification |
| 5b | OI policy | `max_total_oi_policy_bps = 0`, per market `oi_policy_bps = 0` (no insurance-relative cap) | per market ≤ 1,000,000; total ≤ 32,000,000 |
| 5c | Minimum fill notional | $40 on every market | ≤ $100,000 |
| 5d | Batch cap | 40 fills (on-chain `MAX_BATCH`; matcher matches it) | code constant |
| — | Freeze date | 2026-10-01 | — |

### Liquidation economics after decision 4

Per unit of closed notional (penalty = `liquidation_fee_bps`, reward = `min(penalty, 15 bps)`):

| Market | Penalty | Liquidator | Insurance | Treasury |
|---|---:|---:|---:|---:|
| BTC-PERP | 25 bps | 15 | 5 | 5 |
| ETH-PERP | 35 bps | 15 | 10 | 10 |
| SOL / XRP / BNB / TRX (inactive) | 50 bps | 15 | 17.5 | 17.5 |

`EnvironmentConfigTest` fails if any active market in the mainnet or testnet TOML has
`liquidation_fee_bps <= max_reward_bps`.

## Markets

| Market | id | Active | IM | MM | Liq. fee | Max leverage | Exec. band | OI cap (long + short) | Chainlink reference |
|---|---:|---|---:|---:|---:|---:|---:|---:|---|
| BTC-PERP | 2 | yes | 200 bps | 100 bps | 25 bps | 50x | 75 bps | 5 BTC | `0xa109B535C70C8Be9995be64Bb6751AcDB27e03De` |
| ETH-PERP | 3 | yes | 500 | 250 | 35 | 20x | 75 | 100 ETH | `0x50FCDD99D6762D1C170DC6A9111db944AEE6D364` |
| SOL-PERP | 4 | no | 1000 | 500 | 50 | 10x | 75 | 5,000 SOL | `0x2d04D354f5fDaE3De723df475745B0a9B4edf90C` |
| XRP-PERP | 5 | no | 1000 | 500 | 50 | 10x | 75 | 325,000 XRP | `0xFFb04Fba8384e0a53Ee9975F9164905030F5ea29` |
| BNB-PERP | 7 | no | 1000 | 500 | 50 | 10x | 75 | 425 BNB | `0x00d1516C06e030Ef2142478ce14CEbce2De81771` |
| TRX-PERP | 8 | no | 2000 | 1000 | 50 | 5x | 75 | 575,000 TRX | `0x5693D678943AE1FDfCECFf98B6c677FbAf331AE9` |

**Retired market ids: 1 (XLM-PERP) and 6 (ADA-PERP).** Both were listed in earlier configs and
were removed at the freeze because Arc has no Chainlink reference feed for them. These ids must
never be reused for a different market: `RiskParams` keys positions, events and every indexed
record by numeric market id, and the off-chain projections replay historical logs, so reusing an id
would let old XLM or ADA data be read as the new market. A future market takes the next unused id
(9 and upward). `RiskParams.setMarket` also refuses to re-point a listed market at another oracle
id, and `EnvironmentConfigTest` fails if id 1 or 6 reappears in an Arc config.

All markets: `max_oracle_age_secs = 15`, `max_oracle_confidence_bps = 100`, `min_fill_notional_usd
= 40`, `funding_premium_coeff = 1`, `funding_max_rate_per_hour = 0.05%`, reference
`max_divergence_bps = 150`, `max_age_secs = 90000` (25h), reference not `required`.

`RiskParams` bounds: IM 100 … 5000 bps; MM ≥ 25 and ≤ IM; liquidation fee ≤ 500 and ≤ MM;
execution band 1 … 1000 bps; oracle age 1 … 300s; oracle confidence 1 … 500 bps; max leverage ≤
the leverage implied by IM; OI cap 0 < cap ≤ 1e30; min fill notional ≤ $100,000; premium coefficient
0 … 10; funding rate 0 < rate ≤ 1%/h.

## Oracle feeds (all markets)

| Parameter | Value | Bound (`OracleAdapter`) |
|---|---|---|
| `min_publishers` | 2 | 1 … 5 |
| `max_spread_bps` | 50 | ≤ 10000 |
| `max_jump_bps` | 2000 (applies only while the previous price is fresh) | ≤ 10000 |
| `max_confidence_bps` | 100 | ≤ 10000 |
| `max_age_secs` | 15 | ≤ 300 |
| Reference divergence / age | 150 bps / 90000s | 10 … 10000 bps / ≤ 2 days |
| Off-chain keeper | push on ≥ 5 bps move or 5s heartbeat | — |

## Governance and roles

| Parameter | Value |
|---|---|
| Timelock delay | 172800s (48h; code floor 48h) |
| Guardian pause / cooldown | 72h / 24h (code constants) |
| Guardian veto / cooldown | 7 days / 3 days (code constants) |
| Proposers, executors, guardian, treasury | Safes, set at deploy (placeholders in the TOML; preflight refuses zero addresses and non-contracts on mainnet) |
| Operators, publishers, funding keepers, fee-tier bots | one key per service, set at deploy |

## How `99_VerifyDeployment` enforces this

`script/99_VerifyDeployment.s.sol` loads the TOML for `KRYON_NETWORK`, requires the chain id to
match, and runs `DeploymentVerifier.verify` against the recorded deployment. It is read-only and
can be re-run against mainnet at any time. It prints `FAIL …` for every mismatch and reverts, or
prints `99_VerifyDeployment: OK`:

- **Roles:** on all eight proxies, the timelock is the sole holder of `DEFAULT_ADMIN_ROLE`,
  `UPGRADER_ROLE`, `RISK_ADMIN_ROLE`, `FEE_ADMIN_ROLE`, and no EOA holds them; the guardian is the
  sole `PAUSER_ROLE`; exact member sets for `OPERATOR_ROLE`, `KEEPER_ROLE`, `FEE_TIER_ROLE`,
  `PUBLISHER_ROLE`, `LEDGER_ROLE` (Engine, FeeRouter, Liquidation, Insurance) and `FEE_SOURCE_ROLE`
  (OrderGateway, Liquidation); the deployer holds nothing.
- **Pause state:** no active guardian pause, indefinite pause or pause cooldown;
  `GUARDIAN_PAUSE_DURATION` > timelock delay.
- **Timelock:** delay ≥ 48h and equal to config; exact PROPOSER, EXECUTOR, CANCELLER,
  DEFAULT_ADMIN (self only) and PAUSER (guardian) sets; no active veto or veto cooldown;
  `VETO_COOLDOWN` > delay.
- **Wiring:** every cross-contract address, USDC and Permit2 addresses, cap exemptions, deposit
  caps (0 while `open_deposits_at_deploy = false`), liquidation params, fee recipients, publisher
  count.
- **Fees:** net-fee floor, rebate and referral flags, split, liquidation split, and each market's
  maker/taker rates.
- **Markets:** market count, OI ceiling, and for each market the exact `MarketParams`, funding
  config, OI policy, oracle feed config (listed and active) and reference feed.
- **Implementations:** each proxy's ERC-1967 slot matches the recorded implementation, and both have
  code. Code hashes are written to `deployments/<network>-verified.json`.
- **Warnings** (printed, not failing): an active market whose `liquidationFeeBps <= maxRewardBps`.
  With the approved values there are none, and `EnvironmentConfigTest` keeps it that way.
