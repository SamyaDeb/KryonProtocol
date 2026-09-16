# Legacy Issues Addressed In This Rebuild Tranche

## 1. Withdrawal Solvency

Risk: Critical.

Legacy issue: withdrawals checked only stored locked margin. A user with
unrealized losses could withdraw collateral that should back open positions.

Fix implemented: `risk-engine::validate_withdrawal` recomputes account-level
equity from collateral, trade PnL, and funding PnL before accepting withdrawal.

Why superior: withdrawal safety now follows the same account health invariant
used for liquidation.

## 2. Account-Level Liquidation

Risk: Critical.

Legacy issue: liquidation checked one position's margin and PnL even though
accounts used cross-margin.

Fix implemented: `risk-engine::plan_liquidation` first computes account health.
Only liquidatable accounts can produce a liquidation plan.

Why superior: cross-margin semantics are consistent across health checks,
withdrawals, and liquidation.

## 3. Funding Basis

Risk: Critical.

Legacy issue: funding compared mark price from perp engine to oracle price, but
the perp engine mark was also the oracle price.

Fix implemented: `risk-engine::update_from_imbalance` derives funding from
long/short OI imbalance. The engine tracks side-specific open interest, stores
funding indexes, syncs them to the vault, and realizes accrued funding before
position mutation or close.

Why superior: funding can move even when execution is oracle-priced, and users
cannot dodge funding by increasing, reducing, or closing before settlement.

## 4. Oracle Snapshot Discipline

Risk: High.

Legacy issue: oracle reads were inconsistent across modules and admin-pushed
prices had weak source semantics.

Fix implemented: `OracleSnapshot` carries source, price, confidence, publish
time, and write time with an explicit `OracleGuard`.

Why superior: every market can enforce age and confidence bounds before risk
math consumes a price.

## 5. User-Supplied Position Bypass

Risk: Critical.

Legacy-class issue: any withdrawal path that accepts arbitrary positions from
the caller lets an attacker omit losing positions and pass health checks.

Fix implemented: `perp-vault` stores positions synced by an authorized engine.
The withdrawal path loads those stored positions and rejects owner mismatches.

Why superior: account health is based on protocol-owned state, not caller
claims.

## 6. Custody/Accounting Split

Risk: Critical.

Legacy-class issue: internal collateral accounting can diverge from actual token
custody if deposits and withdrawals are not coupled to token transfers.

Fix implemented: `perp-vault::deposit` transfers SEP-41 assets into the vault
before increasing internal balance; `withdraw` performs risk validation,
decreases internal balance, then transfers assets out.

Why superior: the vault is now the accounting boundary for collateral, and the
risk engine gates exits from custody.

## 7. Arbitrary Off-Oracle Execution

Risk: High.

Legacy-class issue: if fills can settle far from oracle without bands, a matcher
or privileged executor can transfer value between accounts or drain collateral.

Fix implemented: `perp-engine` validates every execution price against a
market-level oracle deviation band before opening, increasing, reducing, or
closing a position.

Why superior: settlement is now bounded by independently validated oracle state.

## 8. Unsynchronized Realized PnL

Risk: Critical.

Legacy-class issue: closing or reducing a position can produce PnL that is not
atomically reflected in vault accounting.

Fix implemented: `perp-engine::reduce_position` and `close_position` calculate
realized PnL and settle it through `perp-vault::apply_pnl`, which is restricted
to the authorized engine.

Why superior: position lifecycle and custody accounting cannot silently drift.

## 9. Missing Liquidation Execution

Risk: Critical.

Legacy-class issue: risk checks without liquidation execution only identify
insolvency after the fact. They do not resolve it.

Fix implemented: `perp-liquidation` rejects healthy accounts, calls the
engine's authorized force-reduce path, pays a capped insurance-funded reward,
and records bad debt if equity remains negative.

Why superior: unhealthy accounts can now be reduced through the same settlement
path used by normal position closes, with explicit insolvency accounting.

## 10. Bankrupt Account Accounting Failure

Risk: Critical.

Legacy-class issue: systems often treat negative collateral as invalid and then
cannot compute health for bankrupt accounts.

Fix implemented: collateral valuation now treats negative balances as debt.
Liquidation can continue to inspect and reduce bankrupt accounts, and insurance
records deficits explicitly.

Why superior: bad debt stays visible, measurable, and recoverable.

## 11. Replayable Or Overfilled Orders

Risk: Critical.

Legacy-class issue: signed order settlement without fill tracking lets matchers
or attackers replay the same order until account margin fails.

Fix implemented: `perp-order-gateway` tracks filled size by `(owner, nonce)`,
rejects overfills, supports owner cancellation, and enforces expiry.

Why superior: orders become bounded, cancelable intents rather than reusable
permissions.

## 12. Matcher Trust Boundary

Risk: High.

Legacy-class issue: an off-chain matcher can become a custody or price authority
if settlement does not verify fills.

Fix implemented: the gateway verifies side, market, self-trade, limit-price, and
fill-size constraints before calling `perp-engine`.

Why superior: the matcher can sequence orders, but it cannot directly mutate
balances or positions.
