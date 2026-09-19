# Known issues, accepted risks and deviations

These are known and either accepted or tracked. Findings that restate an item here are welcome if
they show a worse impact than described.

## What is in the repository but not in scope

The repository holds more than the audited contracts, and it keeps moving after the freeze. The
off-chain services (matcher, order intake, liquidation and funding keepers, oracle keeper,
reconciler, indexer, monitor, WebSocket and stats aggregator, API) and the frontend land on `main`
**after** `audit-v1` and are **out of scope**, as [SCOPE.md](SCOPE.md) lists. The audited tree is
`kryon-protocol/evm/src/**` at the `audit-v1` commit; nothing outside it was frozen, and later
commits on `main` do not change it. Review the tag, not the branch tip.

## Accepted risks

1. **A stale feed on a held market blocks that account's withdrawals, trading and liquidation.**
   Account health needs a valid oracle price for every market an account holds, and
   `OracleAdapter.getPrice` reverts when stale. This fails closed by design (no withdrawals against
   an unknown price). Mitigation is operational: the oracle keeper publishes every listed feed with
   open interest, the monitor alerts at `maxAge / 2`, and a stale feed re-anchors on its next
   quorum update past the jump guard (FIX 2). `99_VerifyDeployment` requires every listed market to
   have a listed and active feed (FIX 8). Runbook: `oracle-failure.md`.
2. **Governance is the root of trust.** The timelock can upgrade every proxy to arbitrary code
   after 48h. Users rely on monitoring the timelock queue and on the guardian veto.
3. **Guardian pause also stops liquidations, ADL, funding and settlement** (`whenNotPaused`). A
   72h guardian pause during a sharp move can create bad debt that would otherwise have been
   liquidated. Accepted: a pause is an emergency tool, bounded to 72h with a 24h cooldown.
4. **Operator discretion.** The operator can censor, delay and choose the order and pairing of
   valid fills, within both signed limits and the oracle execution band. There is no on-chain
   price-time priority.
5. **Publisher quorum.** Mainnet requires 2 of ≤ 5 publishers. A colluding quorum can move the
   index within `maxSpreadBps` (50) per update, `maxJumpBps` (2000) of a fresh price and, where a
   Chainlink reference is live, `maxDivergenceBps` (150) of it. The reference feed is not
   `required` (the config loader never sets it), so a reference outage removes that bound. After
   an outage longer than `maxAge` the jump guard doesn't apply to the re-anchoring update.
6. **Liquidation closes to the backstop at the oracle index**, not at a market price, and the
   backstop carries the position. Backstop losses are covered by operating capital, then recorded
   as bad debt, then ADL. Backstop unwind orders are **disabled until governance sets
   `setUnwindLimits`**; until then positions leave the backstop only through ADL.
7. **Funding under-charges after a missed update.** One update charges at most 1h of elapsed time
   (`MAX_FUNDING_ELAPSED_SECS`). A keeper outage loses funding; it is never back-charged.
8. **Rounding dust.** Token credits round down and debits round up (`Decimals`); funding payers
   round up and receivers round down; claims pay whole 1e6 units. Dust accumulates in the vault in
   the protocol's favour and is accounted for in the solvency identity.
9. **Arc USDC blocklist behaviour is tested against a mock.** `MockUSDC` reverts transfers from or
   to blocklisted addresses, like Arc's protocol-level blocklist; the real blocklist controller is
   not available on testnet. A blocklisted trader can't deposit or withdraw, but settlement moves
   no tokens, so they can't block a batch, and they can still be liquidated. A blocklisted Vault
   would halt all token movement.
10. **Economic limits of small fills.** An opening fill between brand-new accounts costs ~378k gas,
    ~$0.0076 at 20 gwei; with 4 bps total fees that breaks even at ~$19. Launch `minFillNotional`
    is $40. Fills on existing positions (~280k gas) break even at ~$14.
11. **Protocol limits:** ≤ 16 open positions per account, market ids 1–255, ≤ 32 listed markets,
    ≤ 5 publishers, ≤ 40 fills per batch, order TTL ≤ 7 days.
12. **Nonce binding uses a 128-bit digest prefix.** The first fill binds `(owner, nonce)` to the
    high 128 bits of the order digest. A second, different order under the same nonce reverts
    `NonceReused` unless its digest shares that prefix (2^-128).
13. **A pure reduction that fully closes an account with a negative balance is refused**
    (`InsufficientCollateral`); such accounts must go through liquidation and
    `settleBadDebt`.
14. **`executeBatch` is blocked during a veto even if it only contains `unpauseExecution`;** the
    lift must be scheduled as a single `execute`.

## Documented deviations (from `docs/engineering/BUILD_LOG.md`)

### From the protocol plan

1. Liquidation **transfers** the position to the Insurance backstop at the oracle index instead of
   closing it one-sidedly, so long and short OI stay equal and invariant 5 is exact.
2. ADL closes the backstop's position against an in-profit counterparty and haircuts the realized
   gain by the unfunded shortfall.
3. Invariant 5 includes open cost basis: `Vault USDC × 1e12 == totalLedger − netCostBasis`.
4. Positions store exact cost basis (`openNotional`); the entry price is derived.
5. Funding settles through a pool (the Engine's vault account).
6. Order sizes are 1e18 base units; USDC amounts are 1e6 only at the token boundary.
7. Fee rates are in millionths (350 = 3.5 bps).
8. OI caps count long + short.
9. A non-increasing fill must not leave the account liquidatable (instead of requiring initial
   margin), so traders between MM and IM can still reduce.
10. `updateFunding` is `KEEPER_ROLE`.
11. Mainnet deposits stay closed until `99_VerifyDeployment` passes and the timelock raises caps.
12. A market's funding clock starts at its first update.
13. **Liquidation sizing formula corrected** in both the Solidity and the Rust reference model:
    `q = size·shortfall / (notional·(mm − fee)) + 1`. The original reference model under-closed by
    `1/(mm − fee)`. Both are differentially fuzzed, and a property test asserts that one uncapped
    step restores maintenance margin. **Please review this formula specifically.**

### From the 2026-09-17 review fixes

1. **FIX 4: gas reserve is per fill, not per remaining fill.** Reserving 900k for every remaining
   fill would need 36M gas for 40 fills, above Arc's 30M block. Each fill must start with
   `MIN_GAS_PER_FILL`; a fill that uses all forwarded gas reverts the batch
   (`InsufficientBatchGas`). ERC-1271 checks are capped at 100k gas, so trader code can't trigger
   this.
2. **FIX 3: `unfundedShortfall = max(0, badDebt − max(marked, 0))` is 0 whenever recorded bad
   debt is 0**, even if the backstop is under water on a mark-to-market basis. An under-water
   backstop without recorded debt therefore doesn't trigger ADL; it reduces OI capacity
   (`effectiveBalance`) and staker redemptions instead. ADL proceeds when recorded debt is covered
   by cash but not by marked capital.
3. **FIX 1: `unpauseExecution` without an active veto is a no-op**, so governance can't use it to
   hold the guardian in a cooldown. `unpause()` of a guardian pause sets its expiry to now, so the
   24h cooldown still applies.
4. **FIX 3: a full unstake can be refused** by the vault when the backstop account would drop below
   initial margin; stakers can redeem part.

## Open items not fixed at `audit-v1`

| Item | Why not fixed |
|---|---|
| `arc-forge fmt --check` reports 34 files (mostly `src/`) not matching `[fmt]` | Cosmetic. Formatting before the freeze would change `src/` after the nightly campaign. Planned right after the audit, as a whitespace-only `audit-v1.1` (`git diff -w` empty for `src/`), together with adding `arc-forge fmt --check` to CI so it cannot drift again |
| Arc USDC blocklist controller and exact blocklist semantics | Not published by Arc; behaviour tested against a mock (item 9) |
| Backstop unwind limits unset | Set by governance after launch, sized to insurance capital |
| Referral program disabled | Business decision; the referral share accrues to treasury |
| Governance, guardian, treasury and service addresses are placeholders in `arc-mainnet.toml` | Set at deploy time. `DeployScript.preflight` refuses zero addresses, empty role lists and non-contract Safes on mainnet |
| XLM and ADA markets | Removed from the Arc configs: no Chainlink reference feed on Arc. They can be listed later by the timelock |
