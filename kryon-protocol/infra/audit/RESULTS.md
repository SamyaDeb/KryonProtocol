# Verification results

Run 2026-09-17 on branch `phase1/audit-freeze` (base `main` = `4702097`, plus the Phase 1 config
decisions and `EnvironmentConfigTest`), with arc-foundry v0.8.0-1 and solc 0.8.30. The commands are
listed in [README.md](README.md).

**`src/`, `script/` and `crates/` are byte-identical to `49b79f2`.** Under `test/`, the only
differences are comment-only edits to three files (doc paths) and the new
`test/upgrade/EnvironmentConfig.t.sol`, which has no fuzzed inputs. The nightly campaign on
`49b79f2` therefore applies to the frozen code.

## Summary

| Check | Result |
|---|---|
| `arc-forge build --sizes` | ✅ all contracts under 24,576 B (table below) |
| `arc-forge test` (unit, upgrade, invariant) | ✅ **259 passed**, 0 failed, 19 suites |
| `cargo test --workspace` (reference model) | ✅ 19 passed |
| Differential (`FOUNDRY_PROFILE=differential`) | ✅ 9 properties × 5,000 runs = 45,000 comparisons, 0 mismatches |
| Fork (`FOUNDRY_PROFILE=fork --network arc`, Arc testnet, read-only) | ✅ 8 passed |
| Gas (`FOUNDRY_PROFILE=gas`) | ✅ 7 passed; identical to the previously recorded figures (0% change) |
| Coverage (`--ir-minimum`, `src/`) | ✅ **97.67% lines** (1506/1542), **95.22% branches** (319/335), 97.91% statements, 98.20% functions |
| Slither 0.11.6 (High/Medium) | ✅ **0 findings** (76 contracts, 64 detectors) |
| `./script/storage-layout.sh --check` | ✅ storage layouts unchanged |
| Dry-run deploy, mainnet parameters (local) | ✅ `DeployAll` succeeded; `99_VerifyDeployment: OK`, **no WARN** |
| Nightly (`FOUNDRY_PROFILE=nightly`, on `49b79f2`) | see [Nightly](#nightly) |
| `arc-forge fmt --check` | ❌ known: 34 pre-existing files differ (see KNOWN_ISSUES) |

## Contract sizes

| Contract | Runtime (B) | Initcode (B) | Runtime margin (B) |
|---|---:|---:|---:|
| Engine | 22,821 | 23,052 | 1,755 |
| Insurance | 14,715 | 14,946 | 9,861 |
| OrderGateway | 14,763 | 14,994 | 9,813 |
| FeeRouter | 14,025 | 14,256 | 10,551 |
| OracleAdapter | 13,938 | 14,169 | 10,638 |
| Vault | 11,983 | 12,214 | 12,593 |
| Liquidation | 11,064 | 11,295 | 13,512 |
| RiskParams | 10,372 | 10,603 | 14,204 |
| KryonTimelock | 7,234 | 9,360 | 17,342 |
| RiskCalc (linked library) | 4,115 | 4,145 | 20,461 |

## Tests by suite (`arc-forge test`)

| Suite | Tests |
|---|---:|
| `unit/OrderGateway.t.sol` | 34 |
| `unit/Libraries.t.sol` (KryonMath, Decimals, RiskLib) | 32 |
| `unit/Engine.t.sol` | 22 |
| `upgrade/Governance.t.sol` | 21 |
| `unit/OracleAdapter.t.sol` | 21 |
| `unit/Vault.t.sol` | 20 |
| `unit/Insurance.t.sol` | 18 |
| `unit/FeeRouter.t.sol` | 17 |
| `unit/Guards.t.sol` | 14 |
| `unit/Liquidation.t.sol` | 14 |
| `upgrade/DeploymentVerifier.t.sol` | 13 |
| `invariant/Invariants.t.sol` | 11 invariants × 256 runs × depth 64 |
| `unit/BackstopUnwind.t.sol` | 10 |
| `unit/RiskParams.t.sol` | 9 |
| `upgrade/EnvironmentConfig.t.sol` (new) | 1 |
| `unit/Smoke.t.sol`, `invariant/HandlerSmoke.t.sol` | 2 |
| **Total** | **259** |

Fuzz runs: 1,000 per fuzz test in the default profile (seed `0x4b52594f4e`), 1,000,000 in
`nightly`.

## Coverage by contract

| File | Lines | Branches | Functions |
|---|---|---|---|
| Engine | 99.30% (282/284) | 96.36% (53/55) | 100% (44/44) |
| FeeRouter | 99.43% (174/175) | 93.94% (31/33) | 100% (35/35) |
| Insurance | 98.46% (192/195) | 97.67% (42/43) | 96.88% (31/32) |
| Liquidation | 98.78% (81/82) | 95.00% (19/20) | 100% (8/8) |
| OracleAdapter | 96.84% (153/158) | 88.68% (47/53) | 100% (18/18) |
| OrderGateway | 95.73% (112/117) | 88.89% (24/27) | 92.00% (23/25) |
| RiskParams | 98.90% (90/91) | 100% (22/22) | 100% (16/16) |
| Vault | 95.45% (126/132) | 100% (22/22) | 93.94% (31/33) |
| **Total** (`src/` incl. libraries and governance) | **97.67%** (1506/1542) | **95.22%** (319/335) | **98.20%** (273/278) |

The uncovered branches are defensive guards (e.g. i128 overflow bounds and unreachable
zero-address/length checks); `--ir-minimum` coverage also under-reports some via-IR inlined
branches.

## Slither

Command: `slither . --foundry-out-directory out --ignore-compile --filter-paths "lib/|test/|script/"
--exclude-informational --exclude-low`. Result: **0 High, 0 Medium**.

Inline suppressions in `src/` (`slither-disable-next-line`), each with a comment at the site:

| Detector | Count | Where | Justification |
|---|---:|---|---|
| `reentrancy-no-eth` | 7 | Engine (liquidation/ADL transfers, trade), FeeRouter, OrderGateway (`settleOne`), Vault | Calls go only to protocol contracts (Vault, FeeRouter, Insurance, Engine) with no callbacks into untrusted code; every entry point is `nonReentrant` (transient-storage guard) |
| `unused-return` | 7 | Insurance, Liquidation, OracleAdapter, OrderLib, KryonTimelock, Vault | Return value intentionally ignored: `EnumerableSet.add/remove` mirrors of AccessControl, `latestRoundData` fields not needed, `ECDSA.tryRecover` third value, `validateWithdrawal` (reverts on failure), `settleBadDebt` amount (emitted by Insurance) |
| `incorrect-equality` | 2 | Engine, KryonTimelock | `== 0` sentinel checks ("never set"), not timestamp or balance equality |
| `assembly` | 1 | OrderLib | Gas-capped ERC-1271 `staticcall` with bounded return-data copy |

Low and informational detectors (calls-loop, timestamp, ERC-7201 slot getters in assembly,
cyclomatic complexity, naming) are excluded from the CI gate and were reviewed when they were
introduced (see `docs/engineering/BUILD_LOG.md`).

## Gas (`FOUNDRY_PROFILE=gas arc-forge test -vv`)

| Action | Gas | vs BUILD_LOG |
|---|---:|---|
| Settle 1 fill, both sides opening (cold, single) | 610,162 | = |
| Settle 40 fills, new positions | 15,204,808 (380,120 per fill) | = |
| Settle 40 fills, existing positions | 11,235,481 (280,887 per fill) | = |
| Worst single fill (2× ERC-1271 at the 100k cap, fresh market, OI policy on) | 729,134 | = |
| Partial liquidation | 276,456 | = |
| Oracle push, 8 markets (warm) | 111,413 | = |
| Funding update, 1 market | 36,131 | = |
| Deposit (cold account) | 143,983 | = |
| Withdraw | 65,526 | = |

At the 20 gwei floor a 40-fill batch costs ≈ 0.30 USDC and is ≈ 51% of Arc's 30M block gas limit.

## Differential fuzzing

| Property | Runs | Result |
|---|---:|---|
| `testFuzz_mulDiv` | 5,000 | ✅ |
| `testFuzz_applyBps` | 5,000 | ✅ |
| `testFuzz_ceilDiv` | 5,000 | ✅ |
| `testFuzz_premium` | 5,000 | ✅ |
| `testFuzz_funding` | 5,000 | ✅ |
| `testFuzz_accountHealth` | 5,000 | ✅ |
| `testFuzz_validateWithdrawal` | 5,000 | ✅ |
| `testFuzz_planLiquidation` | 5,000 | ✅ |
| `testFuzz_planLiquidation_underwater` | 5,000 | ✅ |

Values and error codes are compared against `kryon-ref` (Rust, `crates/protocol-core` +
`crates/risk-engine`).

## Fork (Arc testnet, read-only)

`test_usdc_dual_interface_shares_one_balance`, `test_native_value_is_rejected_and_zero_address_transfers_revert`,
`test_real_usdc_permit_deposit`, `test_real_permit2_deposit`,
`test_equal_timestamps_do_not_break_funding_or_oracle`, `test_base_fee_is_at_least_the_20_gwei_floor`,
`test_full_flow_with_real_usdc`, `test_order_digest_binds_arc_chain_id`: **8/8 passed.**

## Deployment dry run (mainnet parameters, local only)

- `arc-anvil` forked from the public Arc mainnet RPC (chain ID 5042, read-only upstream).
  **All transactions went to `127.0.0.1`; nothing was broadcast to a live network.**
- Config: `arc-mainnet.toml` copied to a temporary environment file, changing only the placeholder
  addresses (governance, guardian and treasury stand-ins given code on the local fork so the
  mainnet Safe preflight passes; service keys as local addresses; 2 publishers). All economic,
  risk, oracle and market values were used unchanged, as were the real USDC, Permit2 and Chainlink
  addresses.
- `DeployAll` with `KRYON_ALLOW_MAINNET=true` against the local fork: **succeeded** (script gas estimate
  ~55.6M across the deploy transactions).
- `99_VerifyDeployment`: **`99_VerifyDeployment: OK`, no `WARN` lines** (the pre-freeze config
  printed `WARN BTC-PERP: liquidation fee (25 bps) <= max liquidator reward (25 bps)`).
- The temporary config, deployment records and broadcast logs were deleted afterwards.

## Nightly

`FOUNDRY_PROFILE=nightly arc-forge test` (fuzz 1,000,000 runs; invariants 2048 runs × depth 256;
differential included) on commit `49b79f2`, started 2026-09-17 21:51 IST.

| Status | Detail |
|---|---|
| **In progress** | 14 of 20 suites finished (the 18 default suites at `49b79f2` plus gas and differential), 199 tests passed, 0 failed. Remaining: `InvariantsTest`, `DifferentialTest`, `FeeRouterTest`, `InsuranceTest`, `DeploymentVerifierTest`, `GasTest` |

This section is updated with the final counts before `audit-v1` is tagged.
