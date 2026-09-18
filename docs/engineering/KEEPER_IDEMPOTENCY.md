# Keeper Retry and Idempotency Arguments

**Written:** 2026-09-18, on `service/keepers`. **Scope:** every retry path in the settlement
reconciler, the funding keeper, the oracle publisher and the liquidation/ADL keeper.

The rule this document exists to enforce: **no keeper re-sends business intent without a written
argument for why a duplicate is safe.** A stuck job is an incident; a double liquidation or a
double settlement is a loss. Where the argument cannot be made, the keeper reports and stops.

Each entry states what a *duplicate submission* does on-chain, established by reading the
contract, not by assumption.

---

## 1. Reconciler

The reconciler holds **no signing key**. That is a design constraint, not an omission, and it
bounds what it can possibly get wrong.

### 1.1 Rebroadcast — safe, always

**Retry:** re-send `TxJob.rawTx` when a job has no receipt and is not in the mempool.

**Argument:** `rawTx` is the *already-signed* transaction. Re-sending those bytes cannot create a
second transaction: same nonce, same payload, same signature, therefore the same transaction
hash. The node either accepts it into the mempool or answers "already known". Even if the
original is mined between our check and our send, the resend fails `nonce too low` and changes
nothing. There is no state in which two transactions result.

This is the only recovery the reconciler performs on a key it does not own.

### 1.2 Fee-bump replacement — not performed

A replacement is a *new signature* at the same nonce, so it needs the private key. The reconciler
does not have other services' keys, and will not be given them: one key per process is what makes
`TxSender`'s nonce ownership sound.

A job stuck past the replacement window is therefore **reported, not fixed** (`reconciler_stuck_jobs`,
plus an error log naming the job and its owning service). The owning process replaces it through
its own `TxSender.wait()`. Implemented in `resolveNonce`, outcome `stuck`.

### 1.3 Nonce-gap filling — not performed

**Why it was considered:** a missing nonce below in-flight jobs blocks every job above it
indefinitely, because the account nonce cannot advance past the hole.

**Why it is not done.** Two reasons, either sufficient:

1. Filling a gap means signing a no-op *with the stranded key*, which the reconciler does not hold.
2. Even for a key it did hold, a gap almost always means **a second process is using that key**.
   A gap filler would then race that process for the nonce rather than unblock it, and the loser's
   transaction is silently dropped — converting a visible stall into an invisible loss.

A nonce gap is an operational fault (two writers on one key), and the fix is operational: find the
second writer and stop it. The reconciler logs it at `error` with the blocked-job count, and
`detectNonceGaps` is unit-tested. Implemented in `reconcileKey`.

### 1.4 Re-settling fills — never

**Retry:** none. Stranded `Fill` rows are classified and reported (`lib/reconciler/fills.ts`).

**Argument for why even a "safe-looking" resend is refused.** `OrderGateway.settleFillsSigned`
settles each fill in its own try/catch and emits `FillRejected` rather than reverting the batch, so
a duplicate `fillId` would likely be rejected harmlessly. That is an argument that a resend is
*probably* cheap, not that it is *correct*: the orders behind a stranded fill may since have
expired, been cancelled, or been re-matched into a different batch, and the reconciler cannot see
any of that. Deciding what a stranded fill means belongs to the matcher, which owns the order
book. The reconciler's job is to guarantee no such fill goes unnoticed.

Mismatches are classified as `indexer-lag` (self-healing), `not-in-receipt` (the batch that landed
is not the batch we recorded — a bug), `batch-failed` and `never-submitted`. All but the first are
written as durable `KeeperAction` rows with status `SKIPPED`, meaning *deliberately not acted on*.

### 1.5 GasSpend roll-up — derived, so idempotent

**The hazard it replaced:** an additive upsert (`txCount + 1`) guarded by "only the process that
moves the job to terminal adds its gas". That undercounts badly: the owning service's
`TxSender.wait()` confirms nearly every job itself, writing the receipt without the guard, and those
jobs never appear in the reconciler's `openJobs` pass. The matcher's gas would have been almost
entirely missing from `GasSpend`, and `GasSpend` is what the refill and monitor read.

**The design:** `GasSpendRollup.recompute(days)` rebuilds whole days from `TxJob` with a single
`INSERT ... SELECT ... GROUP BY ... ON CONFLICT DO UPDATE SET "txCount" = EXCLUDED."txCount", ...`.
It counts `CONFIRMED` and `REVERTED` attempts (mined, so paid for) and skips `REPLACED`/`DROPPED`
(never landed). The bucket is the job's `createdAt` day, which never changes. The reconciler runs it
once per tick over yesterday, today and tomorrow; the extra day absorbs a host that is not running
in UTC (and `bootstrap()` pins `TZ=UTC` anyway).

Running it twice, or from two processes at once, writes the same numbers. Covered by
`gas is rolled up for jobs the owning service confirmed itself` and
`replaced and dropped attempts cost nothing; the roll-up is a set, not an add`.

`finalize()` still makes its terminal write compare-and-set, so that of two racing reconcilers
exactly one logs the transition, but gas accounting no longer depends on it.

---

## 2. Funding keeper — retries are **not** free

**This is the one that looks idempotent and is not.** `Engine.updateFunding` calls
`_consumeTwap(marketId)` *before* `FundingLib.updateFromPremium` decides anything.
`updateFromPremium` returns the state unchanged when `now_ <= state.lastUpdate`, so a second call
in the same block does not move the funding indexes — but `_consumeTwap` has already closed the
mark averaging window. The next genuine update then prices its premium off a shorter, noisier TWAP
sample.

So a duplicate `updateFunding` is **not** a no-op. It is invisible in the funding indexes and
visible in the mark quality.

**Consequences for the design:**

- The keeper reads `fundingState(marketId)` and skips when an update would not be due. It never
  infers due-ness from the wall clock — `lastUpdate` is a chain timestamp.
- A funding job left open by a crash is driven to a terminal state by the reconciler, which
  rebroadcasts (§1.1, safe) but never re-*decides*. If the job ends `DROPPED` or `REVERTED`, the
  funding keeper re-evaluates from `fundingState` on its next tick, which is the only place that
  decision may be made.
- A missed hour is logged, not chased. `FundingLib.MAX_FUNDING_ELAPSED_SECS = 3600` caps one
  update at one hour of elapsed time, so a missed hour is under-charged and can never be
  back-charged. Sending a second update to "catch up" would charge a second hour against a fresh
  TWAP and is wrong twice over.
- `dt = 0` (equal block timestamps) must not revert: Arc timestamps are non-decreasing, not
  strictly increasing. `updateFromPremium` handles it; the keeper must not treat it as an error.

---

## 3. Oracle publisher

### 3.1 The guards skip, they do not revert

Worth stating plainly because it inverts the obvious error handling. In `OracleAdapter._aggregate`,
a failed guard emits `PriceUpdateSkipped(id, reason, candidate)` and **returns** — the transaction
still succeeds. The skip reasons are `QuorumNotMet`, `SpreadTooWide`, `JumpTooLarge`,
`ReferenceDiverged`, `ReferenceUnavailable` and `NotMonotonic`.

A publisher that classified failures by decoding reverts would see a successful receipt and
conclude the price landed. Classification must read the **events in our own receipt**.

These actually revert, and are the true error classes: `UnknownFeed`, inactive feed
(`InvalidConfig`), non-positive price (`InvalidPrice`), `publishTime` in the future or older than
`cfg.maxAge` (`StaleOracle`), `publishTime` not newer than *this publisher's own* previous
observation (`StaleOracle`), and `AccessControl` for a key without `PUBLISHER_ROLE`.

### 3.2 Republishing a price — safe, with one constraint

**Retry:** publish again on the next cycle after a skip.

**Argument:** `pushPrices` stores one observation per `(feed, publisher)` and re-aggregates. A
republish overwrites our own previous observation; it does not accumulate. There is no double-count
because the aggregate is recomputed from the publisher set each time, and `_aggregate` only counts
observations still inside `cfg.maxAge`.

**The constraint:** `publishTime` must be **strictly greater** than our own previous observation's
(`if (publishTime <= prev.publishTime) revert StaleOracle`). Back-dating by
`PUBLISH_TIME_BACKDATE_SECS` to stay behind the block timestamp can therefore collide with our own
last push. The publisher clamps forward to `prev.publishTime + 1` rather than sending a revert.

### 3.3 Re-anchor after an outage — deliberate, and logged

After a gap longer than `cfg.maxAge` the previous aggregate is stale, and `_aggregate` skips the
jump guard entirely (`prevStale`), emitting `PriceReanchored`. This is correct — holding a
recovering feed to a stale anchor would keep it stale forever — but it is also the one moment the
jump guard is not protecting us. The publisher logs the re-anchor explicitly, at `warn`, with the
previous and new price, so it is never silent.

---

## 4. Liquidation and ADL keeper — retries are **not** idempotent

**`Liquidation.liquidate(trader, marketId, maxSize)` re-plans on-chain each call.** Against an
account that is no longer liquidatable, `planLiquidationSize` returns 0 and the call reverts
`InvalidAmount`; a step that would not improve health reverts
`LiquidationWouldNotImproveHealth`. So a duplicate against a *healthy* account fails safe.

**Against an account still under water, a duplicate liquidates again.** It is a second real
liquidation: a second penalty, a second reward, a second transfer to the backstop. That is the
whole argument for the rule below.

**The rule:** the liquidator sends and never blind-retries. A liquidation job that ends `DROPPED`
or `REVERTED` is not re-sent from the job record. The next tick re-reads `accountHealth` and
decides again from current state. Health is the only input allowed to authorise a liquidation, and
it must be read after, not before, the failure.

**`adl(counterparty, marketId, maxSize)`** reverts `NoBadDebtToOffset` once
`unfundedShortfall() <= 0`, and `PositionNotInProfit` if the counterparty is no longer in profit,
so a stale duplicate fails safe. It is still re-decided per tick from `unfundedShortfall()`, for
the same reason as above. Note `unfundedShortfall()` **reverts `StaleOracle`** when the backstop
cannot be priced — that is "blocked on the oracle", not "no shortfall", and must not be read as
zero.

**`Insurance.settleBadDebt(trader)` is genuinely idempotent.** It recomputes the deficit from
`vault.balanceOf(trader)`, covers what operating capital allows, and only writes when
`remaining != previous`. Calling it twice with no state change in between emits `DeficitCovered`
again but moves no funds and changes no recorded debt. It also requires `positionCount(trader) == 0`,
so it cannot run against an account still being unwound. This is the one call in the keeper set
that may be retried freely.

---

## 5. Summary

| Path | Duplicate is safe? | Retry policy |
|---|---|---|
| Rebroadcast signed bytes | Yes — same transaction | Automatic |
| Fee-bump replacement | N/A — needs the key | Owning process only |
| Nonce-gap fill | No — races the second writer | Report only |
| Re-settle fills | Unproven | Report only |
| GasSpend roll-up | Yes — recomputed from TxJob | Set, not add |
| `updateFunding` | **No** — consumes the TWAP | Re-decide from `fundingState` |
| `pushPrices` | Yes — overwrites our observation | Automatic, `publishTime` clamped forward |
| `liquidate` | **No** — liquidates again | Re-decide from `accountHealth` |
| `adl` | Fails safe, but re-decide anyway | Re-decide from `unfundedShortfall` |
| `settleBadDebt` | Yes — recomputes from balance | Free to retry |
