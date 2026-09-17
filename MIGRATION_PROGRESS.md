# Arc migration progress

Source of truth: `ARC_MIGRATION_PLAN.md`. Working instructions: `ARC_MIGRATION_PROMPT.md`.

| Step | Status |
|---|---|
| 0. Setup (Appendix B, git init, arc-facts) | ✅ done |
| 1. Contracts (Phase A + fee contracts) | ✅ done, plus the 2026-09-17 decisions (below) |
| 7. Remove Stellar (safe first pass) | 🟡 partial: Soroban contracts and Stellar-only scripts removed; the rest follows Steps 2–6 |
| 2. Chain layer + TxSender | ✅ done |
| 3. Services | not started |
| 4. Database | not started |
| 5. Frontend + API + agent docs | not started |
| 6. Infra, CI, runbooks | not started |
| 8. Testnet readiness | not started |

---

## Review fixes (2026-09-17)

These fixes come from the independent review. Each fix is one commit, with the regression test written first and shown failing before the fix.

| # | Fix | Commit | Tests added |
|---|---|---|---|
| 1 | **Guardian veto and pauses are time-bounded.** The timelock veto lasts at most 7 days, then there's a 3-day cooldown before another. `unpauseExecution` starts the cooldown, and is a no-op without an active veto. A guardian `pause()` lasts 72h with a 24h cooldown. `pauseIndefinitely()` is timelock-only, and `unpause()` clears both. Pause state lives in the `kryon.storage.KryonUpgradeable` namespace, and `paused()` checks expiry. The verifier fails on an active veto, pause or cooldown | `d9477d8` | 10 in `Governance.t.sol` (the PoC with its expectations inverted, re-veto in cooldown, 7-day expiry, a revoke scheduled during the veto, no-op lift, pause expiry restores withdrawals, re-pause in cooldown, indefinite pause, indefinite outlives guardian, admin-only) and 1 verifier test |
| 2 | **The oracle jump guard only applies while the previous snapshot is fresh.** A stale feed re-anchors and emits `PriceReanchored`. Quorum, spread, monotonic and reference checks still apply | `7b31a0e` | 3 in `OracleAdapter.t.sol` (PoC inverted with a withdrawal that now succeeds, fresh jump still skipped, re-anchor blocked by a diverged or unavailable reference). Invariant handler `oracleOutage` with a 20% jump guard, plus `invariant_4_feeds_reanchor_after_an_outage` |
| 3 | **The backstop is marked to market.** `Engine.accountValue` (try/catch self-call, never reverts). Insurance gains `markedOperatingBalance`, and `redeemableStake`. `effectiveBalance`, `unfundedShortfall` and `withdrawUnstaked` use the marked value and fail closed when unpriced. `operatingBalance` stays cash | `7b89611` | 5 in `Insurance.t.sol`, plus `invariant_staker_redemptions_are_marked_to_market` |
| 4 | **Gateway gas.** `MAX_BATCH = 40`, `MIN_GAS_PER_FILL = 900k` (worst measured fill 729k × 1.2, rounded up), `InsufficientBatchGas`, and ERC-1271 by staticcall capped at 100k gas | `6b131fe` | 3 in `OrderGateway.t.sol` (a gas-burning 1271 wallet, an under-gassed batch, short 1271 return data), the 41-fill bound, and the `test_gas_worst_single_fill` probe |
| 5 | **Referrer allowlist.** `setReferrerApproved` requires `FEE_ADMIN_ROLE`, plus a `ReferrerApprovalSet` event and an `isApprovedReferrer` view | `efd8d2f` | 3 (unapproved, approved until removed, access control), and self-referral by an approved partner |
| 6 | **Timelock roles are enumerable**, and the verifier checks exact PROPOSER, EXECUTOR, CANCELLER, DEFAULT_ADMIN and PAUSER sets | `d791769` | 5 in `DeploymentVerifier.t.sol` |
| 7 | **Verifier WARN** when an active market has `liquidationFeeBps <= maxRewardBps`. Printed by `99_VerifyDeployment`, values unchanged, open question 7 | `37e3c12` | 1 |
| 8 | **Ops requirement documented:** the keeper publishes every feed with OI > 0, and the monitor alerts at `maxAge / 2` (plan §6.4, §7, `oracle-failure.md`). The verifier checks that every market's feed is listed and active | `0c92c23` | 1 |
| 9 | **`/lib/` added to the root `.gitignore`.** No config references the root copy | `04f1396` | – |
| – | **Slither justifications** for the new timelock code (3 false-positive Mediums) | `9bf7d50` | – |

### Acceptance (worktree, after all fixes)

- `arc-forge test`: **258 passed**, 0 failed (224 before).
- Differential: 9/9 × 5,000 runs. `cargo test --workspace`: 19 passed. Fork (`--network arc`, Arc testnet): 8/8.
- Coverage: **97.66% lines** (1504/1540), **95.22% branches** (319/335).
- Slither (High/Medium): **0 findings**.
- `storage-layout.sh --check`: unchanged. The snapshots now also cover the `KryonUpgradeable` namespace, and FeeRouter gains `approvedReferrer`.
- `DeployAll` to a local arc-anvil fork of Arc testnet broadcasts cleanly. `99_VerifyDeployment: OK`, plus `WARN BTC-PERP: liquidation fee (25 bps) <= max liquidator reward (25 bps)…`.
- `arc-forge fmt --check`: **fails, as it already did before these fixes.** The same 34 files differ, most of them untouched here. These fixes don't reformat the tree.

**Sizes (B, runtime; the limit is 24,576):**

| Contract | Before | After | Margin |
|---|---|---|---|
| Engine | 21,865 | 22,821 | 1,755 |
| Insurance | 13,704 | 14,715 | 9,861 |
| OrderGateway | 14,032 | 14,763 | 9,813 |
| FeeRouter | 12,997 | 14,025 | 10,551 |
| OracleAdapter | 13,100 | 13,938 | 10,638 |
| KryonTimelock | 6,017 | 7,234 | 17,342 |

**Gas (`FOUNDRY_PROFILE=gas`), before → after:**

| Action | Before | After |
|---|---|---|
| 1 fill, cold | 608,383 | 610,162 |
| 40-fill batch | 15,139,537 | 15,204,808 (380,120 per fill) |
| 40 fills, existing positions | 279,255 per fill | 280,887 per fill |
| Worst single fill (new probe) | – | 729,134 |
| Partial liquidation | 274,870 | 276,456 |
| Oracle push, 8 markets | 109,622 | 111,413 |
| Funding update | 35,778 | 36,131 |
| Deposit | 143,854 | 143,983 |
| Withdraw | 65,417 | 65,526 |

The `whenNotPaused` expiry read adds ~0.1–1.7k gas per call. MTM `effectiveBalance` costs gas only when a market's OI policy is non-zero; it is 0 in every environment today.

### Deviations from the review prompt

1. **FIX 4 reserve is per fill, not per remaining fill.** Reserving ~900k for *every* remaining fill before the first one would need 36M gas for a 40-fill batch, above Arc's 30M block limit, so full batches could never run. Instead, each fill must start with `MIN_GAS_PER_FILL`. If a fill uses all of its forwarded gas, the batch reverts `InsufficientBatchGas`. ERC-1271 gas is capped, so trader code can't trigger this, and operator shortfalls are still never recorded as rejections.
2. **FIX 3 test "backstop losing, no recorded bad debt → `unfundedShortfall > 0`"** contradicts the specified formula `max(0, badDebt − max(marked, 0))`, which is 0 whenever `badDebt = 0`. The formula was implemented as written. The test covers the case the formula targets: recorded debt that cash covers but marked capital doesn't. Then ADL proceeds.
3. **FIX 1:** `unpauseExecution` without an active veto is a no-op, so governance can't use it to hold the guardian in a cooldown. `unpause()` of a guardian pause sets its expiry to now, so the 24h cooldown still applies. Without that, a hostile guardian could re-pause right after a timelock unpause.
4. **FIX 3 under-water unstake test** redeems half of the second staker's shares. A full exit is refused by the vault, because the backstop account would drop below initial margin. That behaviour is unchanged and correct.
5. **FIX 9:** the stray `/Users/samya/Desktop/Kryon/lib` exists only in the main checkout, which this run could not modify. It is ignored, not deleted.
6. `client/lib/chain/generated.ts` ABIs were not regenerated. The client was out of scope for this run. It needs `npm run wagmi:generate` for the new errors, events and views, and its matcher cap of 40 already matches.

---

## Step 2: Chain layer and TxSender (2026-09-17)

### What was built (`client/lib/`)

| File | Contents |
|---|---|
| `chain/generated.ts` | ABIs for all eight protocol contracts, the timelock and `KryonErrors`, generated from `kryon-protocol/evm/out` by `@wagmi/cli` 2.10.0 (`client/wagmi.config.ts`, `npm run wagmi:generate`, needs `arc-forge build` first) |
| `chain/networks.ts` | `arc-mainnet` / `arc-testnet` / `arc-local` registry. RPC, explorer, USDC, Permit2 and Multicall3 values all come from `docs/arc-facts.md`. Contract addresses come from `KRYON_DEPLOYMENT_FILE` (the deploy scripts' JSON, chain-id checked) or `CONTRACT_*` env vars. There are no baked defaults |
| `chain/clients.ts` | viem `fallback` transport: `ARC_RPC_URLS` providers in order, then the public RPC. `assertChainId` for service startup. `serviceAccount(envVar)` loads one key per service |
| `chain/contracts.ts` | Typed `getContract` bindings. `ALL_ERRORS_ABI` merges every custom error, deduplicated, for revert decoding |
| `chain/tx-store.ts` | `TxJob` record (the §9 fields plus to/data/value/gasLimit/label/blockNumber/error), one row per broadcast attempt. `MemoryTxJobStore` |
| `chain/tx-sender.ts` | §6.2 TxSender, described below |
| `chain/settlement.ts` | `encodeSettleFills` (cap 40, rejects duplicate fill ids), `chunkFills`, `decodeBatchLogs` (FillSettled / FillRejected with the decoded error name), `unaccountedFills` |
| `chain/oracle.ts` | `readOraclePrice(symbol)` (symbol required) and `encodePushPrices` |
| `chain/collateral.ts` | Multicall3 `readAccountHealth` scans, account snapshot, deposit caps, and 1e18 ↔ 1e6 conversion (credits round down) |
| `chain/refprice.ts` | Chainlink AggregatorV3 reader (scaled to 1e18; null when stale, non-positive or incomplete) and `divergenceBps`. Feed addresses are passed in from the environment TOML |
| `market/eip712.ts` | Domain Kryon/1, Order/Cancel types, `hashOrder`, `hashCancel`, wallet-ready typed data, EOA signature pre-check |

**TxSender**
- **Nonces:** allocated locally, seeded from and re-checked against `getTransactionCount(pending)`. The lowest nonce with no open job gets filled first. The cursor never moves back.
- **Fees:** `max(2×baseFee, 40 gwei)` with a 1 gwei tip. A base fee below 20 gwei, or a missing one, is priced at the 20 gwei floor, and nothing is ever signed below the floor.
- **Persistence:** each attempt is inserted as `PENDING` before `sendRawTransaction`.
- **Rebroadcast and replacement:** if a transaction is not in the mempool after 3s, the same bytes are rebroadcast. After 10s the sender replaces it at the same nonce with maxFee and tip each +15%. The old row becomes `REPLACED` with `replacedByHash` set. Replacements stop at `maxFeeCapWei` (default 1000 gwei), but rebroadcasts continue.
- **Resolution:** every attempt at a nonce is watched. Whichever lands becomes `CONFIRMED`/`REVERTED` with gasUsed, effectiveGasPrice and block. Other open attempts become `DROPPED`.
- **Errors:**
  - A nonce mined with none of our attempts mined → `TxDroppedError`.
  - "Nonce too low" on submit → resync and retry, up to 3 tries.
  - Any other broadcast rejection → `FAILED`; the nonce is reused.
- **Timeout:** `wait()` throws `TxTimeoutError` after 120s and leaves the job open for the reconciler, which can call `openJobs()` then `wait()`.

### Acceptance results

- **Golden digest:** `hashTypedData` equals the Solidity golden digest `0x3743…895e`, and both type hashes match `OrderLib`.
- **Live parity against a fresh `DeployAll` on a local arc-anvil fork of Arc testnet:** `OrderGateway.hashOrder` and `hashCancel` equal the viem results. This check is env-gated in `eip712.test.ts` and skipped by default. To run it:
  ```
  KRYON_PARITY_RPC=http://127.0.0.1:8545 KRYON_DEPLOYMENT_FILE=../kryon-protocol/evm/deployments/arc-local.json npm test
  ```
- **TxSender tests:** 14, using a scripted chain and a fake clock. They cover:
  - persisting before broadcast
  - the fee rule and floor
  - consecutive nonces under concurrency
  - pending-count seeding
  - gap filling
  - rebroadcasting identical bytes
  - +15% replacement and the replacement chain
  - the original landing after a replacement
  - the fee cap
  - a foreign nonce
  - nonce-too-low retry
  - a rejected broadcast
- **Client totals:** `npm test` runs 75 tests (74 pass, 1 skipped: the live parity check). The baseline was 43. `tsc --noEmit` reports 0 errors.

### Deviations and notes

- **Postgres `TxJobStore`:** not built yet. The table arrives with the Step 4 baseline schema, so services wire the Postgres store then. The interface is fixed now.
- **Batch cap:** `MAX_FILLS_PER_BATCH = 40` comes from the gas pass (~15.1M gas); the contract allows 64.
- **Row per attempt:** a replacement is a new `TxJob` row rather than a mutation of the original. This keeps the §9 `replacedByHash` field meaningful and records every raw transaction ever broadcast.
- **viem chain defaults:** viem's `arcTestnet` defaults to `rpc.testnet.arc.network`, but the chain is defined from our registry using the docs-verified `*.arc.io` hosts.
- **`lib/stellar/*`:** still present. The frontend and services that import it are replaced in Steps 3 and 5.
- **Build speed:** builds are slow on this machine because iCloud (`cloudd`) is syncing `~/Desktop`, including `node_modules`. Moving the repo out of iCloud Drive would speed up `tsc` and `arc-forge build` a lot.

---

## 2026-09-17: mainnet decisions and safe Stellar removal

### Decisions adopted (written into `ARC_MIGRATION_PLAN.md` §4.4, §5.6, §11, §14, §15)

1. **Liquidation-sizing fix kept.** It is flagged for the audit. New property test
   `testFuzz_one_uncapped_step_restores_maintenance` (20,000 runs; every run builds a liquidatable
   account with positive equity) proves one uncapped planned step restores maintenance margin.
2. **Fees vs gas.** Launch `minFillNotional` is **$40** in all environment TOMLs. The gas pass is
   done:

   | Action | Before | After |
   |---|---|---|
   | Opening fill, brand-new accounts | 558k | **378.5k** |
   | Fill on existing positions | – | **279k** |
   | 40-fill batch | 22.3M | **15.1M** |
   | Partial liquidation | 337k | **275k** |

   Changes: int128-packed Engine storage, a per-account market bitmap (market ids capped at 255),
   one read-modify-write per position, a no-op for the duplicate mark record, one slot per order
   in the gateway (`filled(owner, nonce)` replaces `filled(digest)`), and a single insurance fee
   transfer per fill. The ≤ 350k target is met for fills on existing positions, not for
   brand-new accounts, so $40 stays until testnet traffic shows the real mix.
3. **Backstop unwind built.** `Insurance` is an ERC-1271 signer for reduce-only, ≤ 1h orders it
   owns, signed by a `BACKSTOP_SIGNER_ROLE` key. `OrderGateway` calls `Insurance.onBackstopFill`
   on every backstop fill, which enforces a price band around the oracle index plus per-fill and
   daily notional caps. Unwinds are disabled until the timelock sets limits. The Engine lets the
   backstop's reduce-only fills settle even when its account is underwater. Ten new tests cover
   the happy path, reduce-only, signer revocation, TTL, payload substitution, band, caps, daily
   reset, the disabled state, and garbage input.

After these changes: **224 tests pass**; fork suite 8/8; differential 9/9; coverage **97.73%
lines / 95.89% branches**; **Slither 0 findings**; storage-layout snapshots refreshed; all
contracts under 24KB (Engine 21,865 B, Insurance 13,704 B, OrderGateway 14,040 B).

### Stellar removal, safe first pass (`e0a327f`)

- Deleted `kryon-protocol/contracts/**` (8 Soroban contracts, 10,949 lines). The Cargo workspace
  now holds `crates/protocol-core`, `crates/risk-engine` and `evm/ffi`.
- Deleted the Appendix A Stellar-only scripts: `ttl-keeper`, `setup-usdc-*`, `*usdt0*`,
  `redeploy-core`, `redeploy-oracle`, `redeploy-engine-xlm`, `rewire-liquidation`,
  `transfer-admin-to-governance`, `cutover-testnet-v3`, `test-*settle*`, `test-xlm-*`,
  `test-usdc-*`, `test-final-usdc`, `diag-usdc-settle` and `migrate-add-order-signature`, plus the
  `dev:ttl` npm script. **16 of them were gitignored local files, so their deletion is permanent.**
- CI: the Soroban/wasm job is replaced by `reference-model` (fmt, clippy, test) and `evm` (pinned
  arc-foundry with checksum, sizes, tests, differential, storage-layout diff, Slither
  `--fail-medium`). Rust fmt and clippy pass locally.
- **Kept on purpose, as the template for the Arc equivalents (your instruction):**
  `kryon-protocol/infra/**`, Dockerfiles, `render.yaml`, `wrangler.jsonc`, PM2 ecosystem configs
  (including `_drill_ecosystem.config.cjs` and `ecosystem.testnet.config.cjs`),
  `railway-testnet-entrypoint.sh` and runbooks. They are rewritten or removed in Step 6.
- **Still to remove, as Steps 2–5 replace it:** `client/lib/stellar/**`, the `@stellar/*`
  dependencies, the Stellar service scripts (matcher, keepers, indexer, monitor, …),
  `SettlementModal`, `/api/settlements`, the wallet/Freighter UI, and Stellar docs. The CI grep
  guard is added when the last of these goes.

---

## Step 1: Contracts (2026-09-16)

### What was built (`kryon-protocol/evm/`)

| Area | Contents |
|---|---|
| Toolchain | arc-foundry `v0.8.0-1` (forge 1.7.1-dev `f567f94`), solc 0.8.30, EVM target `prague`, via-IR. OpenZeppelin Contracts + Upgradeable `v5.7.0` and forge-std `v1.9.7` as pinned submodules (`foundry.lock`) |
| Libraries | `KryonMath` (1e18, i128-bounded to match Rust), `Decimals` (the single 1e6↔1e18 boundary: credits round down, debits round up), `RiskLib`, `FundingLib`, `LiquidationLib`, `OrderLib` (EIP-712 + ECDSA-then-ERC-1271, so EIP-7702 EOAs work), `RiskCalc` (linked library that keeps the Engine under 24KB), `Types`, `Errors` (`KryonErrors`) |
| Contracts | `Vault`, `Engine`, `OrderGateway`, `OracleAdapter`, `Liquidation`, `Insurance`, `RiskParams`, `FeeRouter`. All UUPS behind ERC1967 proxies, ERC-7201 storage, enumerable roles, guardian pause, timelock-only unpause and upgrade |
| Governance | `KryonTimelock` (OZ TimelockController): delay can never go below 48h, guardian veto on execution, veto lifted only by a timelocked self-call. `Roles` library |
| Deploy | `script/lib/KryonDeploy.sol` (shared by scripts **and tests**), `ConfigLoader` (reads `infra/deploy/environments/arc-*.toml`), `00_DeployImpls` … `05_Handover`, `99_VerifyDeployment`, `DeployAll`, `DeploymentVerifier` |
| Config | `infra/deploy/environments/arc-mainnet.toml`, `arc-testnet.toml`, `arc-local.toml`. Market ids 1–8 match `client/config/index.ts`. BTC and ETH active; the other six configured but inactive. Launch fees, split, caps and oracle policy are set from the prompt's defaults. Mainnet Chainlink cross-check feeds are taken from Chainlink's directory and each has code on-chain |
| Reference model | `evm/ffi` (`kryon-ref`): Rust binary over `protocol-core`/`risk-engine` for differential fuzzing |

### Acceptance results

| Check | Result |
|---|---|
| `arc-forge build --sizes` | ✅ all under 24KB. Engine 22,467 B (2,109 margin), OrderGateway 13,159, FeeRouter 13,003, OracleAdapter 13,100, Vault 11,223, Insurance 10,670, Liquidation 10,334, RiskParams 9,645, KryonTimelock 6,017, RiskCalc 4,115 |
| `arc-forge test` (unit, upgrade, invariant) | ✅ **213 passed, 0 failed** (17 suites) |
| Invariant suite (§3 invariants 1–6 + OI balance, fee buckets, bad-debt backing, staking) | ✅ 9 invariants × 256 runs × depth 64. The campaign executed **29,547 trades, 1,850 liquidations, 99 ADLs, and bad debt in 47 runs**, so it isn't vacuous |
| Differential fuzz vs Rust (G1), `FOUNDRY_PROFILE=differential` | ✅ 9 properties × 5,000 runs = **45,000 comparisons, 0 mismatches** (values and error codes). The 1M-run campaign goes in the nightly profile |
| Arc-semantics fork tests (G4), `FOUNDRY_PROFILE=fork arc-forge test --network arc` | ✅ **8 passed** against an Arc testnet fork with the real USDC and Permit2: dual 6/18-decimal balance, native value and 0x0 transfers rejected, real EIP-2612 permit (version "2"), real Permit2, equal-timestamp funding, 20 gwei base fee, full liquidation and claim flow with exact solvency |
| Coverage (`arc-forge coverage --ir-minimum`, `src/` incl. libraries) | ✅ **97.60% lines** (1343/1376), **96.30% branches** (286/297). The 11 uncovered branches are defensive guards the code can't reach |
| Slither 0.11.6 | ✅ **0 High, 0 Medium.** Low: 11 calls-loop, 11 timestamp, 1 reentrancy-events. Informational: 8 assembly (ERC-7201 slot getters), 6 missing-inheritance, 3 cyclomatic-complexity, 1 naming, 1 unindexed address. Justified inline (`slither-disable-next-line`): protocol-internal Engine→Vault / FeeRouter→Vault calls (all `nonReentrant`, no callbacks), pull-then-credit deposits, and return values ignored on purpose |
| Storage-layout snapshots | ✅ `evm/storage-layout/*.txt` for all 8 contracts. `./script/storage-layout.sh --check` is the CI diff. Regular storage is empty everywhere; all state is namespaced |
| Deploy scripts | ✅ `DeployAll` and the numbered `00`→`05` path both **broadcast cleanly to a local arc-anvil fork of Arc testnet**, and `99_VerifyDeployment: OK`. Preflight refuses placeholder governance addresses, a wrong chain id, and mainnet without `KRYON_ALLOW_MAINNET=true`. `DeploymentVerifier` unit tests prove it flags an EOA admin, fee drift, param drift, extra operators and a vetoed timelock |

### Test ports from Soroban

Every scenario from the eight Soroban contracts and the Rust crates was ported, except those that
don't apply on Arc (listed under Deviations): Vault, Engine, OrderGateway (including KRY-Q1 and
KRY-Q6 funding regressions and KRY-S2 cancels), Liquidation (C1 bad debt, KRY-Q4 ADL), Insurance
(all 8 staking/epoch tests), OracleAdapter (quorum, replay, deviation, duplicate sources),
Governance (48h, queue/execute, guardian veto), RiskParams (KRY-Q8, KRY-Q11), and the
protocol-core/risk-engine unit tests. New tests cover §5.8 fees, EIP-712/ERC-1271/EIP-7702
signatures, nonces and cancels, batch isolation, upgrades, handover, and deploy verification.

### Gas (§5.6), measured with `FOUNDRY_PROFILE=gas arc-forge test -vv`

| Action | Plan estimate | Measured |
|---|---|---|
| Settle 1 fill, both sides opening (cold) | ~350k | 850k single / **558k per fill** in a 40-fill batch |
| 40-fill batch | ~14M | **22.3M** (under the 30M block limit) |
| Oracle push, 8 markets | ~250k | 110k |
| Funding update | ~300k for 8 | 37k per market |
| Liquidation (partial) | ~400k | 337k |
| Deposit (cold) / withdraw | – | 144k / 65k |

**Consequence:** at the 20 gwei floor a fill costs ~0.011 USDC, so 4 bps breaks even at about
$28 notional, and at the ~28 gwei observed on mainnet it's about $39. The $20 `minFillNotional`
default doesn't cover gas for opening fills. See Open decisions.

### Bugs found and fixed during Step 1

1. **Double-hashed EIP-712 digest** in `OrderGateway._consume`. No signature could verify. Caught by the first smoke test.
2. **Liquidation sizing (reference model and port).** `plan_liquidation` sized the close to free
   *notional* equal to the shortfall, not *margin*, under-closing by `1/(mm − fee)`. With the close
   capped at the plan on-chain, liquidations needed dozens of dust steps, each paying less than gas.
   Fixed identically in `crates/risk-engine` and `LiquidationLib`
   (`q = size·shortfall / (notional·(mm−fee)) + 1`), with updated tests on both sides. **This
   changes the Rust reference model; please confirm.**
3. **Stale recorded bad debt.** When a trader repaid their own deficit by depositing, Insurance
   kept the debt recorded, overstating `unfundedShortfall`, so ADL could haircut winners for a
   loss already paid. The vault now calls `Insurance.refreshDebt`. Found by the invariant suite.
4. **Oracle brick on a codeless aggregator.** `try agg.decimals()` on an address without code
   reverts before `try` can catch it, which would make `pushPrices` revert for that feed forever.
   The address is now rejected at config time and treated as unreadable at runtime.
5. **Slither couldn't analyse most functions**, because our `Errors` library shadowed OZ's
   `Errors`. Renamed to `KryonErrors`.

### Deviations from the plan (with reasons)

1. **Liquidation transfers the position to the insurance backstop** at the oracle index instead of
   closing it one-sidedly as Soroban did. A one-sided close leaves long and short OI unequal and
   makes invariant #5 unprovable. With the transfer, `usdc × 1e12 == Σ balances − Σ cost basis`
   holds exactly (fuzzed). The penalty pays a capped liquidator reward, and the remainder is split
   by the FeeRouter (§4.2).
2. **ADL closes the backstop's position against an in-profit counterparty and haircuts that
   counterparty's realized gain** by the unfunded shortfall. Soroban's `adl` only cleared the
   bad-debt record while crediting the winner in full, which doesn't reduce the shortfall.
3. **Invariant #5 includes the open cost basis.** Realized PnL isn't zero-sum per fill; balance
   plus cost basis is. The exact identity is `vault USDC×1e12 == totalLedger − netCostBasis`,
   exposed as `Vault.solvency()`.
4. **Positions store exact cost basis** (`openNotional`) rather than a rounded VWAP entry. Entry
   is derived for display and health. RiskLib keeps the Rust reference shape for parity.
5. **Funding is settled through a pool** (the Engine's vault account). Payers round up and
   receivers round down, so the pool only holds dust.
6. **Order sizes are 1e18 base units** (prices 1e18, USDC amounts 1e6 at the token boundary). The
   plan's "1e6 amounts" is read as token amounts.
7. **Fee rates are in millionths** (1 = 0.01 bps), so 3.5 / 0.5 bps are expressible (350 / 50).
8. **OI caps count long + short**, as the Soroban engine did (every matched fill opens both sides).
9. **Non-increasing fills** must not leave the account liquidatable (instead of requiring initial
   margin as Soroban did), so traders between MM and IM can still reduce. Increasing fills
   require IM after fees.
10. **Not ported, because they don't apply on Arc:** isolated margin (disabled in Soroban too),
    multi-collateral seizure and USDT0 flows (USDC-only launch; the `setCollateral` interface is
    kept), Stellar→Arc migration import/seal (fresh baseline per §9), instance-TTL keepalives and
    tombstone reclaim (EVM has no rent, so cancels are permanent), and the advisory `perp-risk`
    contract. The SEP-53/ed25519 golden vector is replaced by an EIP-712 parity vector
    (`test_eip712_parity_vector`, digest `0x3743…895e`) and computed typehashes.
11. **`updateFunding` is `KEEPER_ROLE`**, per §4.3 (Soroban's was permissionless).
12. **Deposits stay closed on mainnet** (`depositCap = 0`) until `99_VerifyDeployment` passes and
    the timelock raises the caps. Testnet and local open them at deploy
    (`open_deposits_at_deploy`).
13. **The funding clock starts at a market's first trade** (Soroban started it at config time),
    because funding config lives in RiskParams.

### Open questions / decisions for you

1. **Confirm the liquidation-sizing fix** to the Rust reference model (bug 2 above).
2. **`minFillNotional` vs measured gas.** Opening fills cost ~558k gas, so $20 doesn't break even
   (~$28 at 20 gwei, ~$39 at 28 gwei). Options: raise it to ~$40, optimize settlement gas (cold
   storage writes dominate), or accept below-cost small fills. I haven't changed the $20 default.
3. **Batch size.** 40 fills measured at 22.3M gas, versus the plan's ~14M estimate. The matcher
   cap should be sized from simulation (the plan says the same). I suggest ≤ 40 for now.
4. **Backstop unwinding.** Liquidated positions now sit with Insurance. ADL can reduce them when
   there is bad debt, but there is no general unwind path when there isn't. Options: a
   KEEPER-driven backstop order via ERC-1271 on Insurance, or governance-timelocked unwinds.
   Needs a decision before mainnet. It isn't in the plan.
5. **Blocklist semantics in-contract** (G4) stay open. Settlement moves no tokens, so a
   blocklisted trader can't block a batch. Withdrawals to or from them revert (tested with a mock;
   the Arc blocklist controller is unknown).
6. Items still open from Step 0: explorer verification on mainnet, RPC archive/trace, Safe{Wallet}
   support (affects ops-refill design), RedStone/Chronicle.
7. **BTC liquidation penalty is all reward (added 2026-09-17 review).** In `arc-mainnet.toml`,
   BTC-PERP `liquidation_fee_bps = 25` equals `[liquidation] max_reward_bps = 25`. The liquidator
   takes the whole penalty, so insurance and treasury get nothing from BTC liquidations.
   `99_VerifyDeployment` now prints a `WARN` line for every active market with
   `liquidationFeeBps <= maxRewardBps`. The values are unchanged; this is your decision.
   Options:
   (a) lower `max_reward_bps` to ~15 for all markets;
   (b) raise the BTC fee (e.g. 35–50 bps).

### How to reproduce

```bash
cd kryon-protocol/evm
arc-forge build --sizes
arc-forge test                                              # unit + upgrade + invariant
(cd .. && cargo build -p kryon-ref --release) && FOUNDRY_PROFILE=differential arc-forge test
FOUNDRY_PROFILE=fork arc-forge test --network arc          # needs Arc testnet RPC (read-only)
FOUNDRY_PROFILE=gas arc-forge test -vv
arc-forge coverage --ir-minimum --report summary --no-match-coverage "(^script/|^test/|^lib/)"
arc-forge build --build-info --skip "test/**" --skip "script/**" && \
  uvx --from slither-analyzer==0.11.6 slither . --foundry-out-directory out --ignore-compile \
  --filter-paths "lib/|test/|script/" --exclude-informational --exclude-low
./script/storage-layout.sh --check
```

---

## Step 0: Setup (2026-09-16)

### Done

- **Appendix B.** Appended explicit entries to the root `.gitignore` for the load-test and drill
  key/wallet/state JSONs, `client/kryon-web.tar.gz`, `client/logs/`, `.wrangler`, `.vercel`,
  `.dev.vars*`, `*secrets*.env`, keystores/PEM/key files, and arc-foundry outputs.
- **Legacy secret env files moved out of the working tree** (not deleted):
  `kryon-protocol/infra/deploy/{mainnet,testnet,testnet-v3}-secrets.env` →
  `~/Kryon-legacy-secrets/` (dir mode 700, files 600). They hold Stellar-era keys. Decide
  whether to keep, rotate, or destroy them.
- **`git init` + baseline commit** `f650754` (340 files). The staged-file secret scan found only
  placeholders. Tracked key/wallet/secret files: 0.
- **`docs/arc-facts.md`** records every [U] item with sources, plus on-chain checks.

### Decisions made after Step 0

- **arc-foundry `v0.8.0-1`** installed (checksum verified; needs Homebrew `libusb`).
- **Chainlink Arc mainnet feeds approved** as the on-chain cross-check (BTC, ETH, SOL, XRP, BNB,
  TRX). Mainnet WSS comes from providers. The ops refill must not depend on Safe's Allowance
  Module. The 20 gwei floor is config. Testnet and mainnet addresses stay in per-network config.

### New facts (details in `docs/arc-facts.md`)

1. Chainlink Data Feeds are live on Arc mainnet (30 feeds, 24h heartbeat, 0.5% deviation;
   no ADA/XLM; none on testnet).
2. Mainnet WebSocket only via Alchemy, Blockdaemon and QuickNode.
3. Safe v1.4.1 contracts deployed on both networks. Safe{Wallet} UI support unconfirmed.
4. Underpriced txs "may remain pending indefinitely or fail outright". The 20 gwei floor is
   documented for testnet; ~28 gwei was observed on mainnet.
5. Testnet EURC, CCTP and Gateway addresses differ from mainnet.
6. Arc USDC supports EIP-2612 permit (domain "USDC", version "2"). Verified on-chain.
7. Testnet source verification: `arc-forge verify-contract … --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/`.

### Open decisions (§15)

The prompt's defaults apply. These stay as placeholders: Safe signers and thresholds, RPC
provider, auditor(s), bug bounty, and compliance vendor and jurisdictions.
