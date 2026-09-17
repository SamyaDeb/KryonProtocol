You are fixing review findings in **Kryon**, a perpetual-futures DEX being built on **Arc** (Circle's EVM L1: chain ID 5042 on mainnet, 5042002 on testnet; USDC is the gas token). Paths below are relative to the repository root.

**Nothing is deployed.** Storage layouts, ABIs and config can still change freely. When they do, update the storage-layout snapshots and deploy config in the same commit.

---

## 0. Before you touch anything

1. **Another Claude session may be working in this repo.** Run `git log --oneline -15` and `git status`.
   - If there are uncommitted changes you didn't make, or commits from the last few minutes, **stop and ask me** to pause the other session first.
   - Never overwrite or revert someone else's uncommitted work.
2. Read these files in full:
   - `docs/engineering/PROTOCOL_PLAN.md`: the plan, especially §3 (invariants), §4 (contracts), §4.4 (liquidation and backstop decisions) and §5 (fees).
   - `docs/engineering/BUILD_LOG.md`: current status, deviations, and open decisions.
   - The standing hard rules still apply: no mainnet or testnet transactions, no keys in the repo, `arc-foundry` only.
3. Read every contract you'll change, in full, **at its current state**. Line numbers in this prompt are hints only; code may have moved. Locate code by contract and function name.
4. Confirm the baseline is green before changing anything:

```bash
cd kryon-protocol/evm
arc-forge build --sizes
arc-forge test
(cd .. && cargo build -p kryon-ref --release) && FOUNDRY_PROFILE=differential arc-forge test
```

If the baseline isn't green, stop and report it.

## 1. Context

The Solidity suite lives in `kryon-protocol/evm/`, built with arc-foundry v0.8.0-1, solc 0.8.30, via-IR, OZ v5.7.0.

| Contract | Role |
|---|---|
| `Vault` | USDC custody, internal 1e18 ledger |
| `Engine` | positions, funding, mark |
| `OrderGateway` | EIP-712 orders, batched `settleFillsSigned` with per-fill `try this.settleOne` |
| `OracleAdapter` | publisher quorum median, jump/spread guards, Chainlink reference |
| `Liquidation` | liquidation moves the position to the Insurance backstop at the index; ADL |
| `Insurance` | backstop fund plus the account that holds liquidated positions; staking epochs |
| `RiskParams` | market parameters |
| `FeeRouter` | fees, split, referrals, claims |
| `governance/KryonTimelock` | OZ TimelockController, 48h minimum, guardian veto |
| `governance/KryonUpgradeable` | shared base: UUPS, enumerable roles, guardian `pause`, timelock-only `unpause` |
| `script/lib/DeploymentVerifier.sol`, `script/99_VerifyDeployment.s.sol` | post-deploy checks |
| `test/utils/KryonTest.sol` | shared fixture: `governance`, `guardian`, `publisher`, `operator`, `newTrader`, `trade`, `push`, `asGov()` (pranks the timelock), `settle`, `fund`, `assertSolvencyExact` |

Protocol invariants (plan §3) that every fix must preserve:
1. Withdrawals are validated against current equity.
2. Liquidation is based on account health.
3. Funding comes from the mark/index premium.
4. Oracle reads are freshness- and confidence-bounded.
5. `usdc.balanceOf(vault) × 1e12 == totalLedger − netCostBasis` (exact, via `Vault.solvency()`).
6. Upgrades and parameters go through the 48h timelock with bounded setters.

An independent review on 2026-09-17 re-ran the build, the 213 tests, the differential fuzz, and the 8 Arc fork tests. All passed. It then found the issues below. Issues 1 and 2 were **reproduced with proof-of-concept tests** (code included), and issue 3 comes from reading the code.

---

## 2. Fixes, in this order

Each fix follows the same loop:
1. Add the regression test **first** and show it fails for the right reason.
2. Implement the fix.
3. Run the full suite.
4. Commit that one fix with a clear message.

### FIX 1 (Medium–High): a compromised guardian can freeze governance and withdrawals indefinitely

**Problem.**
- `KryonTimelock.pauseExecution()` (guardian) blocks `execute`. The only exception is a single `unpauseExecution` call, and `executeBatch` is always blocked while vetoed.
- Revoking the guardian is a separate `execute`, so a hostile guardian re-vetoes between the lift and the revoke. The loop never ends.
- The guardian can also call `pause()` on every protocol contract, and only the timelock can `unpause()`. `Vault.withdraw` is `whenNotPaused`, so **user funds are locked for as long as the guardian keeps this up**.

**Required behaviour** (two bounded mechanisms; don't weaken the veto's use against a compromised governance):

A. **Timelock veto is time-bounded** (in `KryonTimelock`).
- `pauseExecution()` sets `vetoUntil = block.timestamp + VETO_DURATION`, with `VETO_DURATION = 7 days` as a constant.
- `executionPaused()` returns `block.timestamp < vetoUntil`.
- After a veto ends (expiry or `unpauseExecution`), the guardian **cannot veto again** until `vetoEndedAt + VETO_COOLDOWN`, with `VETO_COOLDOWN = 3 days`. That is longer than the 48h delay, so operations scheduled during the veto (scheduling is never blocked) can execute in the window. Revert `VetoCooldownActive` otherwise.
- `unpauseExecution` stays timelock-only and must start the cooldown.
- Keep the rule that `execute` of `unpauseExecution` is allowed during a veto.
- Emit events with the relevant timestamps.

B. **Guardian protocol pauses are time-bounded** (in `KryonUpgradeable`, which applies to all 8 contracts).
- `pause()` (PAUSER_ROLE) pauses until `block.timestamp + GUARDIAN_PAUSE_DURATION`, with `GUARDIAN_PAUSE_DURATION = 72 hours`. That is longer than 48h, so governance can schedule a longer pause if the emergency is real.
- The guardian can't pause again until `pauseExpiry + GUARDIAN_PAUSE_COOLDOWN`, with `GUARDIAN_PAUSE_COOLDOWN = 24 hours`.
- Add `pauseIndefinitely()` restricted to `DEFAULT_ADMIN_ROLE` (the timelock). It has no expiry and ends only via `unpause()`.
- Override OZ `paused()` (virtual in v5) so it is expiry-aware. `whenNotPaused` must use it.
- **All pause state lives in an ERC-7201 namespace** (e.g. `kryon.storage.KryonUpgradeable`). Never add plain state variables to the base.
- `unpause()` clears both the guardian and the indefinite pause.

**Tests.** Convert the PoC below into `test/upgrade/Governance.t.sol` regression tests with inverted expectations:
- A re-veto during cooldown reverts.
- After 7 days execution works without a lift.
- A revoke scheduled during the veto executes in the cooldown window.
- A guardian `vault.pause()` expires after 72h and withdrawals work again.
- The guardian can't re-pause inside the cooldown.
- `pauseIndefinitely` persists past 72h until the timelock unpauses.
- Non-admins can't call `pauseIndefinitely`.
- Upgrade tests still pass.

PoC that currently **passes** (this is the bug) and must fail after the fix:

```solidity
function test_poc_guardian_can_relock_governance() public {
    bytes memory lift = abi.encodeCall(KryonTimelock.unpauseExecution, ());
    bytes memory revoke = abi.encodeWithSignature("revokeRole(bytes32,address)", Roles.PAUSER_ROLE, guardian);
    vm.startPrank(governance);
    timelock.schedule(address(timelock), 0, lift, bytes32(0), "lift", 48 hours);
    timelock.schedule(address(timelock), 0, revoke, bytes32(0), "revoke", 48 hours);
    vm.stopPrank();
    vm.prank(guardian); timelock.pauseExecution();
    vm.prank(guardian); vault.pause();
    vm.warp(_now() + 48 hours);
    vm.prank(governance);
    vm.expectRevert(Errors.ExecutionPaused.selector);
    timelock.execute(address(timelock), 0, revoke, bytes32(0), "revoke");
    vm.prank(governance); timelock.execute(address(timelock), 0, lift, bytes32(0), "lift");
    vm.prank(guardian); timelock.pauseExecution();           // must revert after the fix (cooldown)
    vm.prank(governance);
    vm.expectRevert(Errors.ExecutionPaused.selector);
    timelock.execute(address(timelock), 0, revoke, bytes32(0), "revoke");
    assertTrue(vault.paused());                               // must be false once 72h pass
}
```

Also update `DeploymentVerifier._timelock` and `_pauser` (check that no veto or pause is active and no cooldown is misconfigured), the plan (§4.2 Governance, §4.3), and the runbooks list (`incident`, `timelock-operations`).

### FIX 2 (Medium–High): the oracle jump guard permanently bricks a feed after an outage

**Problem.** `OracleAdapter._aggregate` skips any update whose median differs from the *last stored* snapshot by more than `maxJumpBps` (mainnet config `max_jump_bps = 2000`).
- If the true price moves more than 20% while the oracle is down, every later update is skipped with `JumpTooLarge`, so the feed stays stale forever.
- `Engine._riskInputs` calls `_indexPrice` for every market a trader holds, so **affected traders can't withdraw, trade, or be liquidated** until a governance fix, which takes at least 48h.

**Required behaviour.**
- Apply the jump guard **only when the previous snapshot is still fresh**: `block.timestamp − prev.writeTime <= cfg.maxAge`.
- When it's stale, accept the new median if every other guard passes (quorum, spread, monotonic, and the reference feed when enabled; if `ref.required`, it must be readable). Emit a new event `PriceReanchored(id, prevPrice, newPrice, staleFor)`.
- The reference-feed divergence check must still apply on re-anchor.
- Don't change the order of the other guards or the skip-don't-revert behaviour.

**Tests** in `test/unit/OracleAdapter.t.sol`:
- A >20% move after the feed went stale is accepted, emits `PriceReanchored`, and the trader can withdraw again.
- The same move while the previous price is fresh is still skipped with `JumpTooLarge`.
- A re-anchor with an enabled reference feed that diverges is skipped with `ReferenceDiverged`.
- Add an invariant-handler action for "oracle outage then large move" if it fits the handler.

PoC that currently **passes** (the bug):

```solidity
function test_poc_jump_guard_bricks_feed_after_gap() public {
    address a = newTrader("a", 100_000e6);
    address b = newTrader("b", 100_000e6);
    int256 p0 = oracle.latest(BTC_ID).price;
    trade(a, b, BTC, true, P / 10, p0);
    OracleAdapter.FeedConfig memory f = oracle.feed(BTC_ID);
    f.maxJumpBps = 2000;
    asGov(); oracle.setFeed(BTC_ID, f);
    vm.warp(_now() + 600);                                   // outage longer than maxAge
    for (uint256 i = 0; i < 5; ++i) push(BTC_ID, p0 * 75 / 100);
    vm.expectRevert(Errors.StaleOracle.selector);
    engine.indexPrice(BTC);                                  // after the fix: returns p0*75/100
    vm.prank(a);
    vm.expectRevert(Errors.StaleOracle.selector);
    vault.withdraw(1e6);                                     // after the fix: succeeds
}
```

### FIX 3 (Medium): Insurance balances ignore the backstop's unrealized PnL

**Problem.** Liquidations move positions into the `Insurance` account (plan §4.4). `Insurance.operatingBalance()` = vault balance − `stakedBalance`, which **ignores the unrealized PnL and pending funding of those positions**. As a result, while the backstop is under water:
- `unfundedShortfall()` reports 0, so `Liquidation.adl` refuses with `NoBadDebtToOffset`;
- `effectiveBalance()` overstates capacity for the Engine's OI policy (`_checkOpenInterest`);
- stakers can `withdrawUnstaked` at full NAV ahead of a loss that hasn't been recognised yet.

**Note:** the other session may already have added ERC-1271 backstop-unwind code to `Insurance` and `Engine` (e.g. `BACKSTOP_SIGNER_ROLE`, the reduce-only backstop bypass in `Engine.requireMargin`). Build on the current code. Don't remove or rewrite that work.

**Required behaviour.**
- **Engine view.** Add `Engine.accountValue(address) returns (int256 equity, bool priced)`: collateral + unrealized PnL + pending funding, using the same RiskLib path as `accountHealth`.
  - It must **not revert on a stale oracle**. Use a try/catch pattern (e.g. an external self-call to a view), or compute per market with `OracleAdapter` reads wrapped in try.
  - Return `priced = false` if any held market can't be priced.
  - Keep the Engine under 24KB. Move logic into `RiskCalc` or a library if needed and report the size.
- **Insurance MTM.** In `Insurance`, define `markedOperatingBalance() = accountValue(this).equity − stakedBalance`. Then:
  - `effectiveBalance()`: `max(0, markedOperating − badDebt)`. If not `priced`, return **0** (fail closed for OI capacity).
  - `unfundedShortfall()`: `max(0, badDebt − max(markedOperating, 0))`. If not `priced`, **revert `StaleOracle`** (ADL needs prices anyway).
  - `withdrawUnstaked`: payout = `shares × max(0, stakedBalance + min(0, markedOperating)) / totalShares`. A negative marked operating balance is absorbed by stakers pro rata. If not `priced`, revert `StaleOracle` (don't pay out blind).
  - Keep `operatingBalance()` (cash) for `settleBadDebt`, which moves real ledger balance, and document the difference clearly in NatSpec.
- **Accounting.** Don't change the Vault/Engine accounting identity (invariant #5 is cash-based and must stay exact).

**Tests:**
- Backstop holds a losing position with no recorded bad debt: `unfundedShortfall > 0`, and ADL is allowed once the realised shortfall exists.
- `effectiveBalance` drops as the backstop position loses value.
- A staker withdrawing while the backstop is under water receives a reduced payout; the remaining stakers aren't diluted.
- Stale oracle: `effectiveBalance == 0`, and `unfundedShortfall` and `withdrawUnstaked` revert.
- Add an invariant: `Σ staker redeemable ≤ max(0, stakedBalance + min(0, markedOperating))`.
- Update the ffi/differential harness only if `RiskLib` math changes. It shouldn't.

### FIX 4 (Low): batch gas reservation and ERC-1271 gas griefing in `OrderGateway`

**Problem.**
- `MIN_GAS_PER_FILL = 250_000`, but a fill measures 558k–850k gas. The operator can supply just enough gas to starve one fill into `FillRejected` with empty revert data, which looks like a real rejection.
- `MAX_BATCH = 64` can't fit in Arc's fixed 30M block gas limit.
- `SignatureChecker` ERC-1271 calls forward all gas, so a malicious smart-wallet signer can burn it and starve the rest of the batch.

**Required behaviour.**
- Set `MIN_GAS_PER_FILL` from the gas test: the worst measured single fill × 1.2, rounded (e.g. ~1_000_000). Put the derivation in a comment.
- `MAX_BATCH = 40`, matching plan §5.6.
- After `catch`, if `gasleft()` is below the reserve for the remaining fills, revert the whole batch with a new `InsufficientBatchGas` error, so an operator gas shortfall is never recorded as a trader rejection.
- In `OrderLib.isValidSignature`, do the ERC-1271 check with a **bounded-gas** `staticcall` (constant `ERC1271_GAS_LIMIT = 100_000`), decode the result safely, and treat failure or short return data as invalid.
- Update `test/gas/*`, the matcher notes in the plan (§6.3: an empty-reason `FillRejected` no longer happens from gas; a revert with `InsufficientBatchGas` means resize and resubmit), and the tests:
  - a 1271 wallet burning gas can't starve later fills;
  - an under-gassed batch reverts `InsufficientBatchGas`;
  - 41 fills revert `BatchTooLarge`.

### FIX 5 (Low): self-referral bypass in `FeeRouter`

**Problem.** A referral is credited whenever `referrer != payer`, so a trader recovers the referral share (10%) of their own fees through a second wallet. Referrals are disabled at launch, but the check must be right before they're enabled.

**Required behaviour.**
- Add an approved-referrer allowlist: `setReferrerApproved(address, bool)` under `FEE_ADMIN_ROLE` (timelock), since referral partners are a governance decision.
- Credit referrals only when `referralsEnabled && approvedReferrer[referrer] && referrer != payer`. Otherwise the share goes to treasury, as it does now.
- Add an event and a view.
- **Tests:** an unapproved referrer earns nothing; an approved one earns; self-referral earns nothing; the split still conserves exactly.

### FIX 6 (Low): the deploy verifier doesn't check exact timelock role membership

**Problem.** `DeploymentVerifier._timelock` checks that the configured proposers and executors are present, but not that **nobody else** holds `PROPOSER_ROLE`, `EXECUTOR_ROLE`, `CANCELLER_ROLE` or the timelock's `DEFAULT_ADMIN_ROLE`. `TimelockController` isn't enumerable.

**Required behaviour.**
- Make `KryonTimelock` role-enumerable: override `_grantRole` and `_revokeRole` to maintain `EnumerableSet`s, and expose `getRoleMemberCount` and `getRoleMember`.
- Verify exact sets:
  - `PROPOSER_ROLE` == config proposers;
  - `EXECUTOR_ROLE` == config executors;
  - `CANCELLER_ROLE` == config proposers (OZ grants it to proposers);
  - `DEFAULT_ADMIN_ROLE` == {timelock itself};
  - `PAUSER_ROLE` == {guardian}.
- Add `DeploymentVerifierTest` cases that fail on an extra proposer, executor or canceller.

### FIX 7 (Low, config check only): the liquidation reward consumes the whole BTC penalty

**Problem.** In `infra/deploy/environments/arc-mainnet.toml`, BTC-PERP `liquidation_fee_bps = 25` equals `[liquidation] max_reward_bps = 25`. The liquidator takes the entire penalty, and insurance and treasury get nothing from BTC liquidations.

**Required behaviour.**
- **Don't change the values.** That's my decision.
- Add a verifier **warning** (not a failure) for any active market with `liquidationFeeBps <= maxRewardBps`, and print it in `99_VerifyDeployment`.
- Add it to "Open questions" in `docs/engineering/BUILD_LOG.md`, with the options: lower `max_reward_bps` to ~15, or raise the BTC fee.

### FIX 8 (Ops requirement, docs only): a stale oracle on any held market blocks that trader's withdrawals

This fail-closed behaviour is intended. Record it as a hard ops requirement in the plan and runbooks:
- **Plan §6.4 and §7:** the oracle keeper must keep publishing **every feed with open interest > 0, including inactive markets**. The monitor alerts when any feed with OI is older than `maxAge / 2`.
- **`runbooks/oracle-failure.md`:** delisting a market requires OI = 0 before its feed is deactivated.
- Add a `DeploymentVerifier` check that every market's `oracleId` feed is listed and active.

### FIX 9 (Housekeeping)

`lib/openzeppelin-contracts-upgradeable` at the **repo root** is a stray copy; the real dependency is `kryon-protocol/evm/lib/openzeppelin-contracts-upgradeable`.
1. Confirm nothing references the root copy: `grep -rn "\.\./\.\./lib\|^lib/" --include=*.toml --include=*.txt --include=*.json .` and check the remappings.
2. Delete it, and add `/lib/` to the root `.gitignore`.

---

## 3. Final acceptance (all must pass; show the output)

```bash
cd kryon-protocol/evm
arc-forge fmt --check
arc-forge build --sizes                               # every contract < 24,576 B; report Engine/Insurance/Gateway margins
arc-forge test                                        # all unit, upgrade and invariant tests; report the new count
(cd .. && cargo test --workspace && cargo build -p kryon-ref --release) && FOUNDRY_PROFILE=differential arc-forge test
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io FOUNDRY_PROFILE=fork arc-forge test --network arc
FOUNDRY_PROFILE=gas arc-forge test -vv                # report per-fill gas and the 40-fill batch gas
arc-forge coverage --ir-minimum --report summary --no-match-coverage "(^script/|^test/|^lib/)"   # >=95% lines, >=90% branches
arc-forge build --build-info --skip "test/**" --skip "script/**" && \
  uvx --from slither-analyzer==0.11.6 slither . --foundry-out-directory out --ignore-compile \
  --filter-paths "lib/|test/|script/" --exclude-informational --exclude-low   # 0 High / 0 Medium
./script/storage-layout.sh                            # regenerate, then --check must pass
```

Then:
- Deploy locally with `DeployAll` to an `arc-anvil` fork of Arc testnet, and confirm `99_VerifyDeployment: OK` (plus the new FIX 7 warning).
- Update `docs/engineering/BUILD_LOG.md` with a "Review fixes (2026-09-17)" section: each fix, its commit hash, tests added, the gas and size impact, and any deviation from this prompt with the reason.
- Update `docs/engineering/PROTOCOL_PLAN.md` where behaviour changed (§4.2, §4.3, §4.4, §5.1, §5.6, §6.3, §7).
- Make one commit per fix, with messages like `fix(governance): bound guardian veto and pauses`.

## 4. Rules

- Don't change anything outside these fixes. If you find another bug, **report it and ask** before fixing.
- Don't weaken existing checks, invariants or tests to make something pass. If a test conflicts with a fix, explain why and ask.
- If a spec detail above turns out to be wrong or unsafe once you see the current code, stop and explain before choosing an alternative.
- Report failures honestly, with output.

Start with step 0.
