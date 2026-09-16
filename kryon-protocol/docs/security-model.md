# Security Model

## Threat Model

Assume attackers can:

- submit transactions around stale oracle updates
- race keepers
- deliberately create toxic CLOB fills
- split exposure across many positions
- exploit rounding and precision drift
- grief storage rent and ledger footprint
- compromise non-timelocked admin keys
- trigger adverse price movement before liquidation settlement

## Core Invariants

1. `equity = collateral_value_after_haircuts + unrealized_pnl + funding_pnl`
2. `withdrawal_allowed` only if post-withdraw equity remains above initial margin.
3. `liquidatable` only if account equity is below maintenance margin.
4. Liquidation rewards are capped to available equity; bad debt is recorded before state can escape.
5. Funding must be independent of `oracle - same_oracle`.
6. Oracle snapshots must validate price, source publish time, write time, and confidence.
7. Share/NAV accounting must reconcile to custody.
8. Withdrawals must use protocol-owned position state, not user-supplied position lists.
9. Internal collateral balances must only increase after token transfer succeeds and must decrease before outbound transfer.
10. Fees and funding must settle through the same vault accounting path as realized PnL.

## Implemented Controls

- The oracle adapter requires authorized publishers and rejects inactive, stale, invalid, or wide-confidence prices.
- Oracle writes reject stale or replayed publish times. Quorum oracle writes require unique configured sources, source-specific publisher auth, odd quorum size of at least three, median aggregation, monotonic publish times, and max deviation checks between providers.
- The vault uses SEP-41 token transfers for custody and keeps internal balances keyed by `(user, asset)`.
- The vault uses an authorized engine-synced position snapshot for account health. This prevents users from omitting losing positions during withdrawal.
- Withdrawals are validated through `risk-engine::validate_withdrawal` before balance decrease and outbound transfer.
- Market risk parameters are bounded before storage.
- The engine rejects fills outside configured oracle bands before mutating position state.
- The engine only accepts normal position mutation from the configured order gateway, keeping users from bypassing matched-order validation and fee settlement with direct engine calls.
- The engine enforces max open interest and initial margin after each open/increase/reduce/close flow.
- The engine tracks side-specific open interest and updates funding indexes from imbalance.
- Positions realize accrued funding before increase, reduce, or close operations, preventing funding debt from being skipped by position mutation.
- Realized PnL is settled through an engine-only vault call, so position settlement and custody accounting move together.
- Maker/taker fees are charged by the engine through an authorized collector, debited through vault accounting, rechecked against initial margin, and only then credited to a configured fee recipient.
- The liquidation contract rejects healthy accounts and self-liquidation.
- Liquidation force-reduces positions only through the engine's oracle-band-checked settlement path.
- For positive-equity liquidations, health ratio must improve. For bankrupt accounts, maintenance requirement must decrease so risk is reduced.
- The insurance fund pays capped rewards and records bad debt explicitly when post-liquidation equity is negative.
- Negative vault collateral is treated as debt in health math, not an invalid state that prevents accounting.
- The order gateway tracks filled size per `(owner, nonce)` and rejects overfills/replays.
- Orders can be cancelled on-chain by owner auth.
- Matched fills reject expired orders, same-side matches, self-trades, and fills outside order limit prices.
- The gateway never mutates positions directly; it settles exclusively through `perp-engine`.
- The matcher is intentionally non-custodial. It only sequences orders and emits `MatchedFill` payloads that the gateway must verify again.
- Replaced orders lose queue priority in the matcher.
- Expired resting orders are pruned before matching.
- Governance actions are queued with a minimum execution delay and carry target/action/wasm-hash metadata before execution is marked.
- Guardian pause control is separated from governance proposal execution.
- Contract admin rotation uses a two-step nominate/accept flow so deployer keys can be removed without accidentally assigning authority to an address that cannot authenticate.
- Keeper decisions are pure and replayable for stale oracle, funding, and liquidation paths.
- Monitoring rules emit critical alerts for bad debt, stale feeds, settlement failures, and liquidation backlog.
- Hardening tests assert deterministic replay, stale-feed consistency between keepers and monitors, funding interval gating, and invalid bad-debt metric rejection.
- Node runtime ingestion is append-only and replayable; RPC events are processed by cursor and transaction submission is modeled as a bounded retry queue.
- Load/chaos tests stress deterministic replay, over-retried transactions, and alert storms.

## Upgrade Policy

Production contracts must not ship with unilateral hot-key upgrades. Required
mainnet controls:

- governance multisig
- upgrade timelock
- published wasm hash manifest
- emergency pause with limited powers
- post-upgrade invariant simulation before activation

Implemented baseline: `perp-governance` records queued/executed/cancelled
proposal metadata and guardian pause state. Mainnet wiring must use multisig
admin addresses and deployment scripts that only invoke target contract admin
calls after `execute` succeeds.

## Soroban-Specific Risks

- Storage rent expiry can become protocol downtime. Critical state needs
  redundant TTL extension, alerting, and runbooks.
- Cross-contract calls increase footprint and failure coupling. Core solvency
  checks should be pure and bounded.
- Authentication must be tied to Stellar addresses, not EVM-style signatures,
  unless explicit domain-separated off-chain order signatures are verified.
- Live RPC ingestion must treat remote data as untrusted until replayed through
  deterministic state reconstruction.
- Mainnet transaction submission must use managed signers with nonce/sequence
  handling and durable retry state; hot keys are not acceptable.
