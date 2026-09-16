# Mainnet Migration Runbook (KRY-Q10)

**Status: SCOPING ONLY. No step in this document has been executed.**

## Why this exists

Mainnet has been silent since 2026-07-10. Verified live against mainnet RPC
(2026-09-07): all 8 deployed contracts predate `upgrade()` — it was only
added to source in commit `9023c95` (2026-09-05), a month after
`infra/deploy/mainnet-deployment.json` was committed (2026-07-08). The
capability cannot be retrofitted onto already-deployed WASM. Compounding
this, `perp_vault`'s on-chain admin is a bare keypair
(`GDG6QFEYHL76TPWYLKNG4A5PG6UQOWW4UF7SV2RBNGGU2G3WQSZKUI34`), not
`perp_governance` — governance was never handed over on mainnet.

There is no in-place fix. The only path forward is: deploy a new contract
set from current source (which has `upgrade()` on all 8, so this never has
to happen again), import every account's state into it, and cut traffic
over. This document scopes that migration. **It does not authorize or
schedule it** — that requires an explicit go-ahead plus the decisions in
"Open decisions" below.

## Correction to an earlier recommendation

The 2026-09-07 findings doc (`Audit Reports/OPEN_FINDINGS_FOLLOWUP_2026-09-07.md`,
not tracked in git) recommended initializing the new contracts with
"`admin = governance address` directly at `initialize()` time" to skip the
nominate/accept handover entirely. **That recommendation does not work and
should not be followed.** `initialize()` calls `admin.require_auth()`;
`require_auth()` on a contract address is only satisfied when that contract
is the direct invoker of the current call. Governance cannot be the invoker
of a target's very first `initialize()` — nothing has wired it in yet, and
`execute()` is itself `require_admin`-gated on governance's own multisig,
so even a queued proposal can't run before governance exists as an admin
of *something*. The nominate → queue → execute(`accept_admin`) sequence
that `governance-admin-transfer.md` already used (and this repo's own
`perp-governance::execute` doc comment confirms: *"governance is the direct
cross-contract caller"*, satisfying the target's `require_auth` naturally)
is the only mechanism that actually works, and this plan uses it — hardened
against the specific failures the July ceremony hit, not replaced.

## Verified current state (cite: mainnet RPC + `mainnet-deployment.json`)

| Contract | Address | Admin |
|---|---|---|
| perp_engine | `CD6OMHCRDDBDO7I57HCUU52RORFPP7DUIRULWFBOX5WLCO5H2OB3W6LZ` | frozen, no `upgrade` |
| perp_liquidation | `CBGSXCZTZOSBMM5RLGZWWLE2USNAXL5ZKCHTZQ6DOKBD3PIEUJXFYDRO` | frozen |
| perp_vault | `CDXGTJQS3XLGXSWDUHKMS5PBBFRRKRXRWH3HTBFNXBIAYEZNDTDKLR4J` | frozen; admin = bare keypair `GDG6QFEYHL76...` |
| perp_order_gateway | `CBA2PSRHSIFTSUAFZWMF6CARNO7YR52PWLWLEXYVRACORS2RXNO2DUTJ` | frozen |
| perp_risk | `CBHZWEIKXULFIH6DCSS7W6BJ3YUVQ5TJFYPP4UKQC4NKLNAF7VLPNVUI` | frozen |
| perp_oracle_adapter | `CD3ZFYZPLJ6W2KO6HD7HE5P5Q27M5N6ITUPHQDRP23NBIVKE6WTUY25F` | frozen |
| perp_insurance | `CCBEJ3F2PUV5OA4JNX3CPSOJFQMYMFDPLNANR2GJZVQEEBFMB6JYNL54` | frozen |
| perp_governance | `CDSIEH7UZ62BT523G3RGJQGJHE7AI4EV265ESKZB672GTIEZNBYPYDXU` | frozen; never became admin of the other 7 |

Re-verify all 8 rows live before starting Phase 0 — this table is a
snapshot, not a live source.

## Phase 0 — Confirm nothing new can accrue

1. Re-run the exact verification from the 2026-09-07 investigation: `stellar
   contract info interface` against mainnet RPC for all 8 addresses, confirm
   none expose `upgrade`.
2. Check `emergency_pause` state on `perp_vault` / `perp_order_gateway` — if
   somehow unpaused, pause via the guardian key (fast path, no timelock)
   so no further deposit/trade/withdraw can land during the migration
   window. Silence since 07-10 makes this unlikely to matter, but the
   check costs nothing and removes a live assumption from the rest of the
   plan.
3. Freeze the off-chain indexer's write path for mainnet (stop ingesting
   new mainnet events) once Phase 0 confirms no new on-chain activity is
   possible — the export in Phase 2 needs a fixed point to reconcile
   against, not a moving one.

**Abort here if**: any of the 8 contracts unexpectedly *does* expose
`upgrade` (means the deployed WASM differs from what was assumed — stop and
re-investigate before touching anything else), or emergency_pause cannot be
confirmed/set (means the guardian key is lost — a separate, prior blocker
to resolve first).

## Phase 1 — Account discovery

There is no way to enumerate "every address that ever touched the
protocol" from the contracts themselves — Soroban has no storage-key
listing RPC, and neither `perp_engine.positions()` nor
`perp_vault.balance_of()` can be called without already knowing the
address.

**Correction from the 2026-09-07 investigation**: that document assumed the
indexer's `Position` table could help reconstruct position state. It
cannot — a repo-wide search confirms nothing writes to `prisma.position`;
it is empty by construction, not just stale. Do not query it.

The real candidate-address source is event-derived, from tables that *are*
populated (confirmed against `prisma/schema.prisma`):

- `Fill.maker` / `Fill.taker` filtered to `network = 'mainnet'` — every
  address that ever executed a trade.
- `BalanceChange.address` filtered to `network = 'mainnet'` — every address
  that ever deposited or withdrew (covers an account that deposited but
  never traded).

Union these two sets. Cross-check the union's size and a sample of
addresses against Horizon's operation history for the vault/engine/gateway
contract IDs, to catch anything the indexer might have missed (the
Neon-quota outage on record is a known gap window worth specifically
checking for addresses that acted only during it).

**This list only needs to be complete enough to not lose anyone — it does
not need to be exact.** Phase 4 seeds state for every address on the list;
an address missed here simply isn't seeded and would need the fallback
path (see "Missed addresses" below) rather than losing funds outright,
because the frozen old contracts remain permanently readable (just not
writable) — anyone missed can always be reconciled later by reading their
true balance directly from the old, frozen `perp_vault`/`perp_engine`.

## Phase 2 — Export and reconcile (read-only, no signing)

For every candidate address, via `stellar contract invoke --send=no` /
RPC `simulateTransaction` (no keys needed — pure reads):

- `perp_vault.balance_of(addr, asset)` for every listed collateral asset.
- `perp_engine.positions(addr)` — the live, authoritative position list.
  (Do not use the indexer for current position state at all; it was never
  populated. The export's positions come only from this on-chain read.)

Globally, once per market/asset rather than per-account:
- `perp_engine.funding_state(market_id)` for every configured market.
- `perp_vault.collateral(asset)` / `perp_engine` market configs, for every
  listed asset/market.
- `perp_insurance.balance_of(asset)` / `bad_debt_of(asset)`.

**Hard reconciliation gate before Phase 3**: sum every exported vault
balance (per asset) and compare against that asset's real token balance
held by the `perp_vault` contract address (a plain token balance query, not
a vault-internal read). These must match (module any known, separately
accounted-for insurance-covered bad debt). A mismatch here means the export
itself is wrong — chasing it down now is far cheaper than discovering it
after cutover. This is the single most important check in the whole
migration: it is the direct descendant of the "any account health mismatch
between indexer and contract state" abort condition already codified in
`mainnet-readiness.md`.

Order tombstones (`perp_order_gateway`'s `Filled`/`Cancelled` nonces) do
**not** need migrating — they self-prune after expiry + 24h grace, and
every order's TTL has been expired since long before 07-10's silence began.

## Phase 3 — Deploy the new contract set

Follow `mainnet-readiness.md`'s existing Launch Sequence (build, shrink,
hash, upload) with one sequencing change learned directly from the
2026-07-05 ceremony's worst blocker (documented in
`governance-admin-transfer.md`: liquidation + insurance were left pointing
at a superseded engine/vault for weeks because their wiring was never
re-verified after a mid-ceremony redeploy — "every `liquidate()` fails with
`Error(Contract, #6)`"):

1. Deploy `perp_governance` first. Admin = the approved multisig (not an
   individual key — this is already a hard gate in `mainnet-readiness.md`).
   Guardian = a separate key from the multisig.
2. Deploy the other 7 contracts with a **freshly generated, single-purpose
   deploy-operator key** — never reused from any other role (oracle
   publisher, matcher operator, liquidator, guardian), and specifically
   *not* the original mainnet deployer key, whose loss/inaccessibility is
   exactly what caused the June-instance blocker on testnet. Record this
   key's custody plan before generating it, not after.
3. Wire every cross-contract address (`set_engine`, `set_vault`,
   `set_insurance`, `set_liquidation`, `set_oracle`, `set_order_gateway`,
   collateral listings, market configs, oracle feeds, fee recipient) using
   the deploy-operator key.
4. **Hard verification gate, mirroring the exact lesson from the July
   incident**: read every contract's stored peer addresses back and diff
   against the deployment manifest before proceeding. The manifest tooling
   should refuse to continue if any live contract references a
   non-manifest address. Do this even though this is a fresh deployment
   with no redeploy-mid-ceremony risk — it is cheap insurance against a
   copy-paste error in the wiring script, which is exactly how the July
   blocker happened.

## Phase 4 — Seed state (uses the tooling built 2026-09-07)

While the deploy-operator key is still admin (i.e., **before** any
handover to governance — both new entrypoints are `require_admin`-gated):

1. `perp_vault.migrate_import_balances(entries)` — batched, repeatable.
   Batch size bounded by transaction footprint limits; expect multiple
   transactions for a mainnet-sized account set. This credits the internal
   ledger only — it does **not** move tokens. The real tokens backing every
   imported balance must be deposited into the new vault's custody as a
   separate treasury-transfer step, sized to the sum of every export from
   Phase 2, before or interleaved with this call. Skipping this leaves the
   internal ledger promising more than the vault actually holds.
2. `perp_engine.migrate_import_positions(entries)` — batched, repeatable.
   Seeds positions, recomputes open interest, advances `NextPositionId`
   past every imported id, and (built specifically to avoid a gap found
   while implementing this) also syncs the vault's own position mirror via
   `sync_positions`, which `account_health` depends on and would otherwise
   silently see nothing for every migrated account.
3. Re-run the Phase 2 reconciliation check against the **new** contracts:
   sum of seeded balances vs. real token balance in the new vault; sum of
   seeded position notional per market vs. expected open interest.
4. Capitalize `perp_insurance` (a plain `deposit()`, works before or after
   sealing) **before** setting any `set_oi_policy` — an empty fund makes
   the OI-headroom check reject every new position, exactly as already
   observed on testnet.
5. `perp_vault.seal_migration()` and `perp_engine.seal_migration()` —
   closes the import window permanently. Verify `migration_sealed()`
   returns true on both before proceeding; this is a one-way action.

## Phase 5 — Hand off to governance

Using the existing, tested mechanism (`transfer-admin-to-governance.ts`,
`verify-decentralization.ts`) — not the shortcut this document's earlier
draft incorrectly proposed:

1. `nominate_admin(governance_address)` on all 7 non-governance contracts,
   from the deploy-operator key (fast, single signature, no timelock).
2. Queue one governance proposal per contract whose action is
   `accept_admin()`, from the multisig. ETA = now + 48h (contract-enforced
   minimum; cannot be shortened).
3. Wait for maturity.
4. `execute()` each proposal (multisig-signed) — governance becomes admin
   of all 7 contracts.
5. Run `verify-decentralization.ts`: must confirm direct EOA admin calls
   fail on every contract, and that admin operations only succeed via
   governance proposals. The July ceremony's own account of this step
   (`governance-admin-transfer.md`) is the reference for what "done"
   actually looks like — do not consider Phase 5 complete without this
   script's explicit pass, exactly as that ceremony required.

**Missed addresses**: if Phase 1's discovery missed someone (their address
never traded or moved balance while the indexer was recording, but somehow
still held a nonzero balance on the frozen contracts — a narrow but
possible gap, e.g. a raw token transfer into the vault outside its normal
deposit path), they are not stranded: the old contracts remain permanently
readable. Support a manual reconciliation path — read the address's true
`balance_of`/`positions` from the *frozen* contracts and seed them via a
one-off `migrate_import_balances`/`migrate_import_positions` call *before*
`seal_migration()` is invoked. This is why sealing should be the very last
action of Phase 4, done deliberately once Phase 1 discovery is believed
complete, not automatically bundled into the import calls themselves.

## Phase 6 — Cutover

1. Repoint client config, keeper fleet (funding/liquidation/oracle
   publishers), and any monitoring from a **single shared config source**,
   in one deploy — not staggered across services. The `ea9609f` commit
   message already documents why: non-atomic repointing across layers
   previously caused a 356-retry incident on testnet.
2. Start the indexer against the new contract addresses in replay-only
   mode first (mirrors `mainnet-readiness.md`'s existing launch sequence:
   "Start indexer in replay-only mode" → "Start ... keepers with
   transaction submission disabled" → "Enable transaction submission after
   simulated state matches RPC state"). Do not skip this staging even
   though it's a migration rather than a first launch — it is the same
   check for the same reason: catching a config or wiring error before it
   can touch real funds.
3. Update the client's displayed contract addresses and, if applicable, a
   one-time user-facing notice explaining the new contract set (users may
   reasonably want to independently verify the new addresses before
   trusting them with funds again).

## Phase 7 — Old contract disposition

The old mainnet contracts cannot be paused via `upgrade` (they don't have
it) and may or may not still be pausable via `emergency_pause` depending on
Phase 0's finding. Practical containment:

- Stop directing any deposit/trade UI traffic at the old addresses (this is
  already true today, but make it explicit and permanent in config rather
  than incidental).
- Treat any unexpected late activity on the old contracts (a stray deposit,
  a leftover approval someone exercises) as requiring manual one-off
  reconciliation against the new contracts, not as something that "can't
  happen" — the old contracts remain live and callable forever; only their
  *admin* actions and (if paused) trading are blocked, not arbitrary token
  transfers someone could still send directly to the vault address.

## Risk register

| Risk | Mitigation |
|---|---|
| Export undercounts accounts (Phase 1 gap) | Frozen contracts stay permanently readable; manual reconciliation path in Phase 5, gated by sealing being the deliberate last step |
| Export/import balance mismatch (double-accounting) | Hard reconciliation gate in Phase 2 and again in Phase 4, against real token balances, not just internal counters |
| Cross-contract wiring error post-deploy | Hard manifest-diff verification gate in Phase 3, directly reproducing the July incident's root cause and its fix |
| Deploy-operator key loss mid-ceremony | Freshly generated, single-purpose key with a custody plan decided *before* generation; never reused from another role |
| Non-atomic cutover causes split-brain traffic | Single shared config source, one deploy, per the `ea9609f` lesson |
| Insurance fund empty at go-live blocks all trading | Explicit capitalize-before-set_oi_policy step in Phase 4 |
| 48h timelock elongates the downtime window | Unavoidable by design (this is what a timelock is for); factor into the go/no-go decision on communicating an expected downtime window to users |

## Open decisions needing an explicit answer before scheduling this

1. **Multisig membership and threshold** for the new governance admin —
   who holds keys, what threshold, where are they custodied.
2. **Guardian key holder** — must be distinct from the multisig signers
   per `mainnet-readiness.md`'s existing gate.
3. **Deploy-operator key custody plan** — who generates it, who holds it
   during the ceremony, confirmed destruction/rotation after handover.
4. **Insurance fund capitalization amount** for the new deployment — this
   is also where the Q11 OI-cap sizing fix and the Q4 staked-backstop-pool
   feature (both shipped 2026-09-07, PR #43) should be applied from day
   one rather than retrofitted later.
5. **User communication plan** for the migration window — expected
   downtime given the 48h timelock is contract-enforced and cannot be
   shortened, and what (if anything) users need to do themselves versus
   what's handled automatically by the import.
6. **Timing** — no technical blocker dictates *when* this runs, only that
   every step above is agreed first.

## Explicitly out of scope for this document

- Actually executing any step above.
- Generating or handling any real key material.
- Moving any real funds.
- Choosing the multisig membership, guardian key, or capitalization amount
  (see "Open decisions").

This document is a plan to be reviewed and approved, not a script to be
run.
