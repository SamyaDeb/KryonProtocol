---
id: onboarding
title: Onboarding Guide
sidebar_position: 3
---

# Onboarding Guide

A path for a new engineer to get productive on Kryon.

## Day 1 — orient

1. Read [Protocol Architecture](/architecture/protocol) and
   [Soroban Contracts](/architecture/contracts).
2. Get the stack running locally ([Local Development](/operations/local-dev)).
3. Connect Freighter (testnet), deposit, and place a trade. Watch it settle in
   the matcher log and appear in the Positions tab.

## Mental model

- **Off-chain = speed, on-chain = truth.** Orders are cheap DB intents;
  settlement is the only chain interaction and the only trust boundary.
- **One position row per market** (cross-margin, VWAP entry). Leverage and liq
  price derive from account equity, not per-position margin.
- **Three services, three jobs**: matcher (match + settle + PnL), oracle keeper
  (prices), indexer (sync + analytics). Each has its own signing key.

## Where things live

| You want to… | Look at |
| --- | --- |
| Change matching/settlement | `client/scripts/matcher-service.ts`, `client/lib/stellar/settlement.ts` |
| Add validation / API behaviour | `client/app/api/**`, `client/lib/validation.ts` |
| Touch contracts | `kryon-protocol/contracts/**`, `crates/**` |
| PnL / margin / liq math | `client/lib/math.ts`, `kryon-protocol/crates/risk-engine/` |
| Leaderboard / portfolio | `scripts/stats-aggregator.ts`, `app/api/leaderboard`, `app/api/portfolio` |
| Frontend trade UI | `client/features/trade/components/**` |
| DB schema | `kryon-protocol/prisma/schema.prisma` |

## First tasks (good starters)

- Add a new market to the matcher/indexer `MARKETS` arrays and verify it trades.
- Add a `metric=winrate` ranking to the leaderboard API + UI.
- Add a `PnlEvent(LIQUIDATION)` writer when the liquidation contract closes a
  position, so liquidation stats populate.

## Conventions to internalise

- Monetary values are **precision strings** (`1e18` price, `1e7` amount). Cast
  to `numeric` in SQL; never to JS floats for accounting.
- Writes are **idempotent** (nonce / unique keys). Design new writers the same
  way.
- API handlers **validate first** and **never leak internal errors**.
- Services must tolerate transient RPC/DB failures (retry, degrade, never crash
  the loop).

## Safety rails

- Don't run admin/operator contract invokes while services are live (sequence
  collisions).
- Don't reuse a signing key across services.
- Don't mark a DB fill as final before its on-chain settlement confirms — the
  matcher's rollback path depends on this ordering.
