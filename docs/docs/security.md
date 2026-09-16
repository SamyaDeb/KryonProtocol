---
id: security
title: Security Considerations
sidebar_position: 90
---

# Security Considerations

## Trust boundaries

| Asset | Custody | Who can move it |
| --- | --- | --- |
| Collateral | Vault contract | Trader (deposit/withdraw); engine (PnL/fees, gateway-gated) |
| Positions | Engine contract | Order gateway only (operator-authorised settlement); liquidation contract |
| Prices | Oracle adapter | Authorised publisher only; guarded by staleness/confidence |

The matcher **cannot** move funds arbitrarily. Its only privileged action is
`settle_fill`, which the gateway validates before the engine touches margin.

## On-chain validation (authoritative)

`settle_fill` enforces, regardless of what the operator submits:

- **Price band** — fill price must respect each order's limit price/direction.
- **Expiry** — expired orders cannot fill.
- **Cancellation** — on-chain cancelled orders cannot fill.
- **Overfill** — cumulative filled size per `(owner, nonce)` ≤ order size.
- **Self-trade / direction / market** — maker ≠ taker, opposite sides, same market.
- **Margin** — the engine requires initial margin after the position change;
  under-collateralised settlements revert.

## Trusted-operator model — trade-offs

Settlement is authorised by a single operator key (the sequencer pattern).

**What it cannot do:** fabricate trades outside a trader's submitted order
parameters, exceed order size, fill cancelled/expired orders, or move
collateral beyond what a valid fill implies.

**What it can do (and the risk):** choose *which* valid matches to settle and in
what order, and censor/delay settlement. This is the standard centralised-
sequencer trade-off. Mitigations: traders retain an **on-chain cancel**
(`Gateway.cancel_order`) as a veto; the operator key should be HSM-backed with
monitoring; a path to decentralise or add fraud-proof/permissionless settlement
is future work.

## Input validation & API hardening

- Order intake validates address, market, size, price, nonce, and expiry; bad
  payloads get `400` and never reach the DB or matcher.
- Handlers never leak internal error text to clients.
- Ranked leaderboard queries use a **fixed column allowlist** — no raw user
  input in `ORDER BY`; parameterised queries elsewhere prevent SQL injection.

## Key management

- **Current (testnet):** signing keys in `.env.local`. Acceptable for testnet
  only.
- **Required for mainnet:** operator and oracle keys behind KMS/HSM, never on
  disk; rotation procedure; least-privilege per service. See
  [Mainnet Readiness](/mainnet-readiness).

## Idempotency & replay

- Orders keyed by `owner:nonce`; fills by the full match tuple; PnL events by
  `(network, address, kind, refKey)`. Replays are no-ops — protects against
  double-settlement and double-counting.
- Settlement timeout is terminal (no blind resubmit) to avoid double-applying a
  late-confirming transaction.

## Oracle risk

The engine rejects trades against prices older than `max_age` (60s) or beyond
the confidence bound. The keeper publishes every 8s. A stalled keeper halts new
trades rather than trading on stale data — fail-safe. Production should run
redundant keepers and multiple price sources.

## Open items before mainnet

- External audit of the operator-auth change and the full settlement path.
- Liquidation keeper hardening + insurance-fund sizing.
- Rate limiting / anti-spam on order intake (per-address quotas).
- Formal monitoring + alerting on settlement failures and oracle staleness.
