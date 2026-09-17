# System overview

Kryon pairs an off-chain price-time order book with on-chain custody, margin, funding,
liquidation, fees and settlement. Traders sign EIP-712 orders; an operator matches them off-chain
and submits matched fills in batches. Every fill is checked on-chain against both signed orders,
so the operator can only settle trades both traders agreed to.

## Contracts

All eight protocol contracts are UUPS proxies (ERC1967) inheriting `KryonUpgradeable`. All state
lives in ERC-7201 namespaces, and roles are enumerable. `KryonTimelock` is not upgradeable.

| Contract | Role |
|---|---|
| **Vault** | Holds all USDC. Keeps a signed 1e18 internal ledger per account. `deposit` / `depositFor` / `depositWithPermit` (EIP-2612, Permit2 fallback), `withdraw` / `withdrawTo` gated by `Engine.validateWithdrawal`. Global and per-account deposit caps (protocol accounts exempt). `applyPnl` is Engine-only; `transferInternal` is `LEDGER_ROLE` (Engine, FeeRouter, Liquidation, Insurance). `receive`/`fallback` revert |
| **Engine** | One net position per `(trader, marketId)` storing exact cost basis (`openNotional`). Cross-margined health per account (≤ 16 positions). Execution band around the oracle index, OI caps and OI policy, TWAP mark, funding indexes. `applyFill` is gateway-only; `liquidationTransfer`/`adlTransfer` are liquidation-only; `updateFunding` is `KEEPER_ROLE` |
| **OrderGateway** | EIP-712 `Order`/`Cancel` (domain `Kryon`/`1`). Validates fills, binds each nonce to one order digest, tracks fill amount, settles batches of ≤ 40 fills with per-fill isolation. `settleFillsSigned` is `OPERATOR_ROLE` |
| **OracleAdapter** | Publisher allowlist (≤ 5). Per-feed quorum median with spread, jump, monotonic and optional Chainlink reference guards. `pushPrices` is `PUBLISHER_ROLE`; `getPrice` reverts when stale or too uncertain |
| **Liquidation** | Permissionless `liquidate` of unhealthy accounts into the Insurance backstop at the oracle index; capped liquidator reward; permissionless `adl` when there is unfunded bad debt |
| **Insurance** | The backstop account that receives liquidated positions. Staked capital (share epochs, 7-day unstake cooldown) and operating capital (fees, penalties, donations, backstop PnL). Bad-debt ledger. ERC-1271 signer for bounded reduce-only unwind orders |
| **RiskParams** | Per-market IM/MM/liquidation fee/leverage/execution band/oracle bounds/OI cap/min fill notional, funding config, OI policy. Every setter has hard bounds |
| **FeeRouter** | Per-market maker/taker rates in millionths, tiers, net-fee floor, rebate and referral switches, fee split, liquidation-fee split, accrual buckets and claims |
| **KryonTimelock** | OZ `TimelockController`, delay ≥ 48h, guardian veto ≤ 7 days with a 3-day cooldown. Holds every admin role |

### Call graph

```
Trader ──deposit/withdraw──────────────────────────────► Vault ──SafeERC20──► USDC (0x3600…)
Trader ──cancelOrder/cancelUpTo/cancelSigned───────────► OrderGateway
Operator ─settleFillsSigned(Fill[])─► OrderGateway
                                        └─ try this.settleOne(fill)
                                             ├─ OrderLib.isValidSignature (ECDSA → ERC-1271, 100k gas cap)
                                             ├─ Insurance.onBackstopFill        (only if a side is the backstop)
                                             ├─ Engine.applyFill ×2 ──► OracleAdapter.getPrice
                                             │                     └─► Vault.applyPnl / transferInternal (funding)
                                             ├─ FeeRouter.chargeFill ──► Vault.transferInternal
                                             └─ Engine.requireMargin ×2
Publisher ─pushPrices──────────────────────────────────► OracleAdapter ──► Chainlink aggregator (view)
Keeper ───updateFunding────────────────────────────────► Engine ──► OracleAdapter.getPrice
Anyone ───liquidate────► Liquidation ─► Engine.liquidationTransfer ─► Vault
                                      ├─► Vault.transferInternal (reward, penalty)
                                      ├─► FeeRouter.accrueLiquidationFee
                                      └─► Insurance.settleBadDebt (account fully closed and negative)
Anyone ───adl──────────► Liquidation ─► Insurance.unfundedShortfall ─► Engine.accountValue
                                      └─► Engine.adlTransfer, Vault.transferInternal (haircut)
Anyone ───claimTreasury/claimReferral─► FeeRouter ─► Vault.withdrawTo(recipient)
Staker ───stake/requestUnstake/withdrawUnstaked─► Insurance ─► Vault
Vault ────refreshDebt (deposit repays a negative balance)─► Insurance
Timelock ─every bounded setter, upgradeToAndCall, unpause, pauseIndefinitely─► all proxies
Guardian ─pause (72h) ─► any proxy;  pauseExecution (7d) ─► KryonTimelock
```

## Units

| Quantity | Unit |
|---|---|
| USDC at the token boundary (`deposit`, `withdraw`, claims) | 1e6 (6 decimals) |
| Internal ledger balances, PnL, fees, notional | 1e18, signed (`int256`, held to the i128 range by `KryonMath`) |
| Conversion | only in `Decimals`: credits round **down** (`toTokenDown`), debits round **up** (`toTokenUp`) |
| Prices (oracle, fills, index, mark) | 1e18 USD per base unit |
| Order and position sizes | 1e18 base units |
| Fee rates | millionths of notional (`RATE_DENOMINATOR = 1_000_000`; 350 = 3.5 bps) |
| Margins, liquidation fee, reward, splits, guards | basis points |
| Funding rate | 1e18 fraction per hour |
| Chainlink answers | scaled from the feed's decimals (≤ 18) to 1e18 |

## Settlement

`OrderGateway.settleFillsSigned(Fill[] fills)` (`OPERATOR_ROLE`, `whenNotPaused`, `nonReentrant`):

1. `1 ≤ fills.length ≤ MAX_BATCH (40)`, else `BatchTooLarge`.
2. For each fill: if `gasleft() < MIN_GAS_PER_FILL (900k)` the **whole batch** reverts
   `InsufficientBatchGas`. The fill runs as `try this.settleOne(fill)`. On a revert, if the fill
   consumed all forwarded gas (`gasleft() < before/64 + 10k`) the batch reverts
   `InsufficientBatchGas`; otherwise `FillRejected(fillId, reason)` is emitted and the batch
   continues. An operator gas shortfall is therefore never recorded as a trader's rejection, and
   trader code cannot burn the reserve because ERC-1271 checks are capped at 100k gas.
3. `settleOne` (callable only by the gateway itself):
   - fill checks: size and price > 0, maker ≠ taker, same non-zero market, opposite sides;
   - for each order: owner ≠ 0, size and limit > 0, not expired, expiry ≤ now + 7 days, nonce ≥
     `minNonce` and not cancelled, nonce bound to this order's digest (first 128 bits), no
     overfill, fill price within the signed limit, valid signature (ECDSA, EIP-7702 delegated EOA,
     or ERC-1271 by `staticcall` with 100k gas);
   - notional = size × price ≥ market `minFillNotional`;
   - backstop hook: if either side is Insurance, `Insurance.onBackstopFill` enforces the unwind band
     and caps;
   - `Engine.applyFill` for maker then taker: price within `maxExecutionDeviationBps` of the oracle
     index, mark TWAP update, funding settlement, position update with exact cost basis and
     realized PnL, OI cap and OI policy, reduce-only enforcement;
   - `FeeRouter.chargeFill`: maker and taker fees (tier or market rates), net-fee floor, split into
     treasury/insurance/referral buckets inside the vault;
   - `Engine.requireMargin` for both: an exposure-increasing fill needs equity ≥ initial margin
     after fees; a reduction must not leave the account liquidatable; a full close must not leave a
     negative balance;
   - `FillSettled` event with both order hashes, fees and tiers.

Fees never leave the vault per fill: they are internal ledger moves. `claimTreasury` and
`claimReferral` pay the configured recipient in 1e6 USDC rounded down.

## Liquidation, backstop and ADL

**Liquidation** (`Liquidation.liquidate(trader, marketId, maxSize)`, permissionless):

1. The caller can't liquidate themselves or the Insurance account.
2. `Engine.planLiquidationSize` returns the smallest close that restores maintenance margin net of
   the penalty, `q = size·shortfall / (notional·(mm − fee)) + 1`, capped at
   `partialLiquidationBps` of the position per step. Accounts with equity ≤ 0 close in full. The
   result is capped by `maxSize`.
3. `Engine.liquidationTransfer` moves the closed size from the trader **to Insurance at the oracle
   index**, so long and short OI stay equal and value is conserved.
4. Penalty = `closedNotional × liquidationFeeBps`. Reward = `min(penalty, closedNotional ×
   maxRewardBps)` goes to the caller; the remainder goes to the FeeRouter and is split
   `liquidationInsuranceBps` to Insurance, the rest to treasury.
5. Health must improve (margin ratio up, or maintenance requirement down for non-positive
   equity), else `LiquidationWouldNotImproveHealth`.
6. If the trader has no positions left and a negative balance, `Insurance.settleBadDebt` covers it
   from operating cash; any uncovered part is recorded as bad debt.

**Backstop capital.** Insurance's vault balance is staked capital plus operating capital.
`operatingBalance()` is cash; `markedOperatingBalance()` adds the unrealized PnL and pending funding
of positions the backstop holds (`Engine.accountValue`, which never reverts and returns
`priced = false` if a held market can't be priced). The marked value drives:
- OI-policy capacity `effectiveBalance = max(0, marked − badDebt)`, 0 when unpriced;
- the ADL trigger `unfundedShortfall = max(0, badDebt − max(marked, 0))`, reverting `StaleOracle`
  when unpriced;
- unstake payouts `shares × max(0, staked + min(0, marked)) / totalShares`, reverting when
  unpriced.

Losses reach stakers explicitly through the timelocked `sweepToOperating`; a sweep to zero retires
the share epoch.

**ADL** (`Liquidation.adl(counterparty, marketId, maxSize)`, permissionless): only while
`unfundedShortfall > 0`. The counterparty must hold the opposite side and be in profit at the
index. The close is capped so the realized gain does not exceed the shortfall, and the realized gain
is haircut by `min(realized, shortfall)` into Insurance.

**Backstop unwind.** Insurance implements ERC-1271 for orders it owns that are reduce-only, expire
within 1 hour, hash to the gateway's EIP-712 digest and are signed by a `BACKSTOP_SIGNER_ROLE` key.
On every backstop fill the gateway calls `onBackstopFill`, which enforces a price band of
`maxUnwindDeviationBps` (≤ 500) around the index, a per-fill notional cap and a per-UTC-day notional
cap. Unwinds are disabled (`maxUnwindDeviationBps = 0`) until the timelock sets limits.

## Funding

- `Engine.updateFunding(marketId)` (`KEEPER_ROLE`) consumes the TWAP of executed gateway fill
  prices since the previous update (the mark), reads the oracle index, and computes
  `premium = (mark − index) / index`.
- `rate = clamp(premium × premiumCoeff, ±maxRatePerHour)`; the long index increases and the short
  index decreases by `rate × elapsed / 3600`, with `elapsed` capped at 3600s, so a missed update is
  under-charged rather than back-charged.
- `now ≤ lastUpdate` returns the state unchanged (Arc timestamps are non-decreasing, so repeated
  updates in one second are allowed). A market with no trades since the last update has premium 0.
- The clock starts at the first update. Positions settle funding against the index on every
  trade, liquidation and ADL transfer. The Engine's own vault account is the funding pool: payers
  round up and receivers round down, so it only keeps dust.

## Oracle

`OracleAdapter.pushPrices(ids, prices, confidences, publishTime)` (`PUBLISHER_ROLE`):

1. `publishTime ≤ block.timestamp`, within the feed's `maxAge`, and strictly after this publisher's
   previous observation for the feed. Price > 0, confidence ≥ 0.
2. Aggregation per feed, using every publisher's observation that is still within `maxAge`:
   - **quorum:** at least `minPublishers` fresh observations, else `PriceUpdateSkipped(QuorumNotMet)`;
   - **median** (mean of the two middle values for an even count), confidence = max, publish
     time = oldest;
   - **spread:** every observation within `maxSpreadBps` of the median;
   - **monotonic:** the oldest publish time is not before the stored snapshot's;
   - **jump guard:** the median is within `maxJumpBps` of the previous price, **only while the
     previous snapshot is fresh**. A stale feed (older than `maxAge`) re-anchors on a median that
     passes every other guard and emits `PriceReanchored`;
   - **reference:** if enabled, a Chainlink answer (positive, not in the future, within
     `maxRefAge`, decimals ≤ 18) must be within `maxDivergenceBps` of the median. If the reference
     is unreadable, the update is skipped only when `required` is set.
3. A skipped update emits `PriceUpdateSkipped` and leaves the previous snapshot in place; it never
   reverts the batch.

`getPrice(id, maxAge, maxConfidenceBps)` reverts when the snapshot is stale or its confidence is
too wide. Markets read it with their own `maxOracleAge` and `maxOracleConfidenceBps`, so trading,
margin checks, withdrawals with open positions, liquidation and funding all **fail closed** on a
stale feed.
