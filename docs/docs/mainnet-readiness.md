---
id: mainnet-readiness
title: Mainnet Readiness
sidebar_position: 93
---

# Mainnet Readiness

An honest gap analysis. The protocol is **functionally complete and stable on
testnet** — trading, settlement, PnL, leaderboard, and portfolio all work
end-to-end against live contracts. This page lists what remains before a
responsible **mainnet** launch. Nothing here is hand-waved; each item is a real
prerequisite.

## Status legend

✅ Done · 🟡 Partial · 🔴 Required before mainnet

## Core protocol & trading

| Item | Status | Notes |
| --- | --- | --- |
| On-chain margin/settlement engine | ✅ | Deployed, tested |
| Real order execution (market/limit/cancel/partial/reduce) | ✅ | Live, operator-signed settlement |
| Automatic settlement | ✅ | Trusted-operator model |
| Realized/unrealized PnL | ✅ | Event-sourced, verified |
| Funding accrual per account | 🟡 | Market indices live; per-account `FundingPayment` writer should be wired to liquidation/funding events |
| Liquidation execution | 🟡 | Contract exists; needs a hardened liquidation keeper + `PnlEvent(LIQUIDATION)` emission |
| Insurance fund sizing/policy | 🔴 | Define funding policy & backstop limits |

## Infrastructure & operations

| Item | Status | Notes |
| --- | --- | --- |
| Contracts on mainnet | 🔴 | Currently testnet; redeploy + governance bootstrap |
| Secret management (KMS/HSM) | 🔴 | Keys are in `.env.local`; mainnet needs KMS/HSM, rotation |
| Operator key HA / failover | 🔴 | Single operator key = SPOF; add redundancy or multi-operator |
| Redundant oracle keepers + multi-source prices | 🔴 | Single keeper + Binance today |
| Monitoring + alerting | 🔴 | Add metrics (settlement latency, match rate, RPC errors, oracle staleness) + alerts |
| Always-on service orchestration | 🟡 | Documented; needs container/worker deploy with restart policy |
| Rate limiting / anti-spam on order intake | 🔴 | Per-address quotas |
| Dedicated Soroban RPC node | 🟡 | Public RPC works; co-located node recommended for throughput |

## Security & assurance

| Item | Status | Notes |
| --- | --- | --- |
| Input validation + error hygiene | ✅ | Order/cancel routes hardened |
| Idempotency / replay protection | ✅ | Nonce + unique-key everywhere |
| DB/chain consistency on failure | ✅ | Rollback path |
| External audit of operator-auth + settlement | 🔴 | Required before custody of real funds |
| Decentralisation / sequencer trust minimisation | 🔴 | Operator can censor/order; plan fraud-proof or permissionless settlement |
| Formal incident runbook | 🔴 | Pause/withdraw-only mode, key compromise response |

## Realtime & scale

| Item | Status | Notes |
| --- | --- | --- |
| Realtime via polling | ✅ | Resilient, reconnect-safe |
| WebSocket streaming server | 🔴 | Client ready (`NEXT_PUBLIC_WS_URL`); server not built |
| Matcher market sharding | 🟡 | Single matcher today; sharding designed, not deployed |
| Analytics caching layer | 🟡 | HTTP cache headers set; add Redis for high concurrency |
| Production build perf testing | 🔴 | Latencies measured in dev; validate on prod build + load |

## Recommended launch sequence

1. **Audit** the contracts (esp. operator-auth + settlement) and the settlement
   service.
2. **Key management**: move operator/oracle keys to KMS/HSM; define rotation +
   compromise runbook.
3. **Redundancy**: multi-keeper oracle with multiple price sources; operator
   failover; co-located RPC.
4. **Observability**: metrics + alerting on settlement failures, oracle
   staleness, RPC error rate, match latency.
5. **Anti-abuse**: per-address rate limiting; spam quotas.
6. **Liquidation + insurance**: harden the liquidation keeper, emit liquidation
   PnL events, size the insurance fund.
7. **Streaming**: deploy the WS server; flip `NEXT_PUBLIC_WS_URL`.
8. **Mainnet deploy**: redeploy contracts to mainnet, bootstrap governance,
   update config, run the [deployment checklist](/operations/deployment).
9. **Staged rollout**: caps on position size / OI; gradual limit increases.

## Honest bottom line

What exists is a **working, hardened testnet perp DEX** with real on-chain
execution and a clean, scalable architecture. The remaining 🔴 items are
genuine production prerequisites — primarily **audit, key management,
redundancy, monitoring, and mainnet deployment** — not feature gaps. They are
infrastructure and assurance work that must not be skipped before the platform
custodies real user funds.
