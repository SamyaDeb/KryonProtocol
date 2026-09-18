# Invariants

Paths are relative to `kryon-protocol/evm/`. The invariant campaign
(`test/invariant/Invariants.t.sol`) drives `test/invariant/Handler.sol` through 12 distinct actions (trades weighted ×3 among 14 selectors):
`deposit`, `withdraw`, `trade`, `movePrice`, `updateFunding`, `liquidate`, `adl`,
`settleAllBadDebt`, `donate`, `stake`, `claimTreasury` and `oracleOutage`. `afterInvariant`
asserts that the campaign actually traded, liquidated and hit ADL, so the invariants can't pass
vacuously.

Profiles: `default` 256 runs × depth 64; `nightly` 2048 runs × depth 256.

## Protocol invariants (plan §3)

### 1. Withdrawals are validated against current account equity

After a withdrawal, equity ≥ initial margin required (`RiskLib.validateWithdrawal`, called by
`Vault._withdraw` through `Engine.validateWithdrawal`). Unrealized losses and pending funding count;
unrealized gains count toward equity but can't be withdrawn beyond the ledger balance.

| Where | Test |
|---|---|
| Invariant | `invariant_1_withdrawals_respect_initial_margin` (handler counts successful withdrawals that break IM) |
| Differential | `testFuzz_validateWithdrawal`, `testFuzz_accountHealth` against the Rust `risk-engine` |
| Unit | `Vault.t.sol`: `test_withdraw_keeps_initial_margin`, `test_withdraw_rejects_unrealized_loss_even_with_token_balance`; `OracleAdapter.t.sol`: `test_stale_feed_reanchors_past_the_jump_guard_and_withdrawals_resume` |

### 2. Liquidation is based on account health

`liquidate` succeeds only for a liquidatable account (equity < maintenance margin), closes at most
the planned size, and must improve health.

| Where | Test |
|---|---|
| Invariant | `invariant_2_only_unhealthy_accounts_are_liquidated` |
| Differential | `testFuzz_planLiquidation`, `testFuzz_planLiquidation_underwater` |
| Property | `Libraries.t.sol`: `testFuzz_one_uncapped_step_restores_maintenance` (one uncapped planned step restores maintenance margin) |
| Unit | `Liquidation.t.sol`: `test_cannot_liquidate_healthy_account`, `test_liquidates_unhealthy_account_and_pays_reward`, `test_partial_step_is_capped`, `test_penalty_above_reward_is_split_by_the_fee_router`; `Guards.t.sol`: `test_liquidation_plan_with_fee_at_maintenance_closes_in_full` |

### 3. Funding derives from the time-weighted mark–index premium

The rate is `clamp((twapMark − index) / index × premiumCoeff, ±maxRatePerHour)`, never the oracle
compared with itself. Elapsed time is capped at 1h per update, and `dt = 0` is a no-op.

| Where | Test |
|---|---|
| Invariant | `invariant_3_funding_is_the_clamped_premium` |
| Differential | `testFuzz_funding`, `testFuzz_premium` |
| Unit | `Engine.t.sol`: `test_mark_is_last_fill_and_twap_is_time_weighted`, `test_funding_tolerates_repeated_updates_in_one_second`, `test_update_funding_fails_closed_on_stale_index`, `test_funding_update_is_settled_before_close` |
| Fork | `ArcSemantics.t.sol`: `test_equal_timestamps_do_not_break_funding_or_oracle` |

### 4. Every oracle read carries source, timestamps, confidence and freshness bounds

Snapshots are quorum-sourced with price > 0, confidence ≥ 0, `publishTime ≤ writeTime ≤ now` and
`sourceCount ≥ 1`. Reads revert when stale or too uncertain. After an outage a feed re-anchors
instead of staying stuck behind the jump guard.

| Where | Test |
|---|---|
| Invariant | `invariant_4_oracle_snapshots_are_well_formed`, `invariant_4_feeds_reanchor_after_an_outage` (handler action `oracleOutage` with a 20% jump guard) |
| Unit | `OracleAdapter.t.sol` (21 tests): quorum, median, spread, replay, monotonic, stale observations, jump guard, re-anchor, reference divergence/staleness/required, config bounds |

### 5. Solvency: the vault holds exactly what it owes

The plan states it as *trader balances + fee buckets + insurance − unsettled bad debt == vault
USDC*. Realized PnL is not zero-sum per fill, so the exact identity includes open cost basis:

```
Vault USDC balance × 1e12 == totalLedger − netCostBasis
```

- `totalLedger` = Σ internal balances (traders, Engine funding pool, FeeRouter buckets, Insurance);
  bad debt shows up as negative balances;
- `netCostBasis` = `Engine.netCostBasis()`, the signed sum of open cost basis;
- exposed as `Vault.solvency()` → `(assets, liabilities)`.

The same invariant also checks that `totalLedger` equals the sum of every account, that the cost
basis total is exact, and that the FeeRouter's vault balance equals `treasuryAccrued +
totalReferralAccrued`.

| Where | Test |
|---|---|
| Invariant | `invariant_5_vault_is_exactly_solvent`, `invariant_bad_debt_is_backed_by_negative_balances`, `invariant_open_interest_is_balanced` |
| Unit | `FeeRouter.t.sol`: `testFuzz_split_conserves_every_wei`, `test_claim_pays_whole_units_and_leaves_dust`; `Vault.t.sol`: `test_internal_transfer_is_zero_sum_and_rejects_negative`, `test_withdraw_round_trip_is_exact`, `test_withdrawable_balance_rounds_down`; `Engine.t.sol`: `test_flip_long_to_short_splits_notional_exactly`, `test_partial_reduce_books_proportional_basis`; `Libraries.t.sol`: `testFuzz_token_to_internal_round_trip_is_exact`, `testFuzz_credit_rounds_down_debit_rounds_up` |
| Fork | `ArcSemantics.t.sol`: `test_full_flow_with_real_usdc` (exact solvency with the real Arc USDC) |

### 6. Upgrades and parameter changes pass through the timelock, with bounded parameters

After handover, `DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE`, `RISK_ADMIN_ROLE` and `FEE_ADMIN_ROLE` on
every proxy are held only by the timelock (delay ≥ 48h). Every setter enforces hard bounds. The
guardian can only pause (≤ 72h, 24h cooldown) and veto execution (≤ 7 days, 3-day cooldown).

| Where | Test |
|---|---|
| Invariant | `invariant_6_admin_roles_stay_with_the_timelock` |
| Unit | `Governance.t.sol` (21 tests): 48h floor, queue/execute, veto bounds and cooldown, revoke during veto, pause expiry/cooldown/indefinite, handover, deployer powerless, initializer locks, upgrade keeps state; `RiskParams.t.sol`, `FeeRouter.t.sol` (`test_setters_revert_above_hard_caps`), `Liquidation.t.sol` (`test_params_are_bounded`), `OracleAdapter.t.sol` config bounds |
| Deploy | `DeploymentVerifier.t.sol` (13 tests): EOA admin, exact timelock role sets, fee/param drift, pauses and cooldowns, feed coverage; `EnvironmentConfig.t.sol`: the Arc mainnet and testnet TOMLs deploy with zero verifier failures and warnings |
| CI | `./script/storage-layout.sh --check` (storage-layout snapshots for every upgradeable contract) |

## Additional invariants

| Invariant | Test |
|---|---|
| Long OI == short OI in every market (matched fills and backstop transfers) | `invariant_open_interest_is_balanced` |
| Recorded bad debt ≤ Σ negative balances | `invariant_bad_debt_is_backed_by_negative_balances` |
| Staker redemptions are capped by `staked + min(0, markedOperating)` | `invariant_staker_redemptions_are_marked_to_market` |
| Shares are never minted against zero staked capital | `invariant_staking_never_mints_against_nothing` |
| No order is filled past its size, after expiry or cancel, or under a reused nonce | `OrderGateway.t.sol` (34 tests) |
| A failing fill never blocks the batch; an operator gas shortfall reverts the batch | `OrderGateway.t.sol`: batch isolation, gas-burning ERC-1271 wallet, under-gassed batch, 41-fill bound |
| A fee can't push an account below initial margin; no fill has a negative net fee | `FeeRouter.t.sol`: `test_fee_cannot_push_account_below_initial_margin`, `test_rebate_floor_holds_for_every_tier_pairing` |
| Backstop unwinds stay reduce-only, in band and within caps | `BackstopUnwind.t.sol` (10 tests) |

## Differential fuzzing

`test/differential/Differential.t.sol` calls the Rust reference model (`kryon-ref`, built from
`crates/protocol-core` and `crates/risk-engine`) over `ffi` and compares both values and error codes
for 9 properties: `mulDiv`, `applyBps`, `ceilDiv`, `premium`, `funding`, `accountHealth`,
`validateWithdrawal`, `planLiquidation`, `planLiquidation_underwater`. Runs: 5,000 per property in
the `differential` profile, 1,000,000 in `nightly`.
