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
- **Cadence stays under an hour.** One update charges `min(elapsed, 3600)`, so a keeper that fires
  hourly loses whatever jitter pushes it past 3600s, on every update. `FUNDING_DUE_AFTER_SECS`
  defaults to 3300 and the keeper refuses anything at or above 3600. Updates are prorated, so the
  earlier update charges exactly its elapsed time and nothing is lost.
- **Same-second calls are skipped, not sent.** The keeper plans from `fundingState.lastUpdate`
  against the latest block's timestamp and skips `elapsed <= 0` rather than relying on the
  contract's no-op, because the no-op still consumes the TWAP window.
- A market's first settled trade starts its funding clock. The keeper's `lastUpdate == 0` path
  only fires for a market that has never traded.

Proven on arc-anvil by `scripts/funding-drill.ts`: every index move matches
`rate * min(elapsed, 3600) / 3600` exactly, a 2.5h gap charges one hour and is not chased, and a
stale oracle is reported in pre-flight without sending.

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
(`if (publishTime <= prev.publishTime) revert StaleOracle`). The batch `publishTime` is
`min(chain time, wall clock) - ORACLE_BACKDATE_SECS`, which can collide with our own last push when
two ticks land in the same second. The publisher **holds that feed for one tick** (`publish-time`)
rather than clamping forward: `prev.publishTime + 1` can be ahead of the block timestamp, and a
future `publishTime` reverts the whole batch.

The same strict-monotonic rule is what makes every transport-level retry safe. An observation can
be stored at most once per `publishTime`, so a rebroadcast, a fee-bump replacement or a
reconciler rebroadcast of the same push either lands once or reverts `StaleOracle`. It can never be
applied twice.

### 3.2a Fee-bump replacement of a push — same payload, bounded by `maxAge`

The publisher's `TxSender` rebroadcasts after 1s and replaces after 3s (not the 3s/10s defaults),
and gives up waiting after 12s. The replacement carries the **same** `publishTime`. If it lands
after `maxAge` (15s) it reverts `StaleOracle` and costs gas only. The next tick signs a fresh push
at the next nonce with a new `publishTime`. That is new intent, not a retry.

### 3.2b Predicted skips we still send — quorum and spread

The publisher mirrors `_aggregate` before every send (`lib/oracle/guards.ts`) and **holds** feeds
the contract would reject whatever the other publishers do (jump, divergence, not-monotonic), plus
its own local guards (sources, source disagreement, confidence wider than `getPrice` accepts,
divergence from the Chainlink reference, USDC de-peg).

It still **sends** when the predicted skip is `QuorumNotMet` or `SpreadTooWide`, because both are
disagreements between our fresh observation and the other publishers' older ones, and our stored
observation is what resolves them. If both publishers held for spread, any move wider than
`maxSpreadBps` between their pushes would leave both observations to expire, and the feed would
go stale on an ordinary move. The drill proves the send-through: a 1.5% move converges on the
second publisher's push with `getPrice` never going stale (`scripts/oracle-drill.ts` §2a).

### 3.2c Startup recovery

On start the publisher calls `recoverOpenJobs`: `wait()` on each open job for its key, which is
only a rebroadcast or its own fee bump at the same nonce. Nothing is re-decided. A job that still
won't resolve is left for the reconciler.

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

**The in-flight guard.** "Re-read health, decide again" has one hole: a liquidation whose
`wait()` timed out may still land, and health read while it is pending shows the account still
under water. Deciding again would send a second liquidation at the next nonce, and both would land.
So the keeper calls `runtime.stillInFlight` first: it drives this key's open jobs to a mined
outcome and sends nothing new while any remain. The funding keeper and keeper-refill use the same
guard for the same reason.

**ADL dust.** `adl` caps the close so the haircut never exceeds the shortfall. Once the shortfall is
dust, that cap rounds to zero and the call reverts `NoBadDebtToOffset`. Retrying would fail the
pre-flight every tick forever, so ADL is skipped below `ADL_MIN_SHORTFALL_USDC` (default $1). The
cascade drill ends with 309 wei of shortfall left, which is exactly this case.

**Observed on the drill, by design of the frozen contracts:** ADL starts in the same tick that
close-outs create bad debt. While the backstop itself is under water, `unfundedShortfall` stays at
the recorded bad debt (`badDebt - max(marked, 0)` with `marked < 0`), so the total haircut across
steps can exceed the recorded bad debt: the backstop's own losses are socialised too. Each single
haircut is still bounded by the shortfall when it was taken (checked by the drill). This is the
audited `Insurance`/`Liquidation` semantics, recorded here so nobody reads it as a keeper bug.

Proven on arc-anvil by `scripts/liquidation-drill.ts`: pause, stale-oracle block, full close-outs,
a partial step that stops once healthy, bad debt, the backstop going under, ADL blocked while
unpriceable, ADL to dust, solvency intact, and every confirmed action matched by an indexer row.

### 4b. keeper-refill

Each top-up is decided from the target's live balance, so an in-flight transfer (balance not yet
raised) would draw a second one. The same in-flight guard applies. A top-up whose confirmation
timed out stays `SUBMITTED`, and the per-target daily cap counts both `CONFIRMED` and
`SUBMITTED`, so a runaway keeper cannot draw more than its allowance. The funder knows target
addresses, never target keys.

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
