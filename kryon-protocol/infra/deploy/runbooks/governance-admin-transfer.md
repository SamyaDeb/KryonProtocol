# Governance Admin-Transfer Ceremony — Testnet Rehearsal (2026-07-05)

Status: **nominate + queue executed; `execute` pending timelock maturity.**

## Governance instance

| Item | Value |
|---|---|
| Contract | `CBZT5HUXI42TD55GGB5Y7OZZ72IT5SN64ONOGDYS2PFQCOWIT4XOA6MU` |
| WASM hash | `c96c7cd36a639ec845faadd211866b8af6eb095c7f05f2d35271893a658d3824` (fixed `execute` — actually invokes target) |
| Admin | `GA3SSO6D4YL5W6NDCO5V72BN5PHXC3SOBRAFMDSMUOM7OTXY2S6UAUHF` (deployer, rehearsal only) |
| Guardian | same as admin (rehearsal only — use a separate key on mainnet) |
| min_delay_secs | 172800 (48 h) |

Deployed + initialized 2026-07-05 ~08:54 UTC. The previous governance instance
(`CCRI6YJY…TBQ5`) ran the broken WASM whose `execute` never invoked the target;
it is abandoned and holds no roles.

## Executed steps (2026-07-05)

Operational note: the deployer key is shared with the oracle keeper —
`pm2 stop kryon-oracle` before, `pm2 start kryon-oracle` after any phase.

1. **Deploy + initialize** (above).
2. **nominate** — `ADMIN_SECRET=<deployer> npx tsx scripts/transfer-admin-to-governance.ts nominate`
   - ✓ oracle-adapter `2423c69eefb4…`
   - ✓ vault `f07474f9c118…`
   - ✓ engine `0d1119ea297b…`
   - ✓ order-gateway `2e27b0b7fa25…`
   - ✗ liquidation — **failed: on-chain admin is the ORIGINAL deployer `GBTL7SKBHYAROO5CYGTQ4ITTEPTUUPIXDFDYZNDNAYQJ4J5XENX4TGDI`, not the current one** (see Blockers)
   - ✗ insurance — same admin mismatch (verified by simulation; not attempted on-chain)
3. **queue** — `ADMIN_SECRET=<deployer> npx tsx scripts/transfer-admin-to-governance.ts queue`
   - All 6 `accept_admin` proposals queued, `eta = 1783415375`:
     oracle-adapter `8ea2520b0050…`, vault `5a8957509e95…`, engine `17baaf3ddce9…`,
     order-gateway `81f758269848…`, liquidation `f1f053af7f2a…`, insurance `e4aa61c1c4af…`

## Pending: execute (DO NOT run before ETA)

- **ETA: `1783415375` = 2026-07-07T09:09:35Z** (48 h timelock + 10 min margin; contract-enforced, cannot be shortcut)
- Command (after `pm2 stop kryon-oracle`):

```bash
cd client && ADMIN_SECRET=$ORACLE_PUBLISHER_SECRET \
  npx tsx scripts/transfer-admin-to-governance.ts execute
# then: pm2 start kryon-oracle
```

- Expected: oracle-adapter, vault, engine, order-gateway succeed (governance
  becomes admin). liquidation + insurance **will fail** unless their
  `nominate_admin` is run first by the original deployer key (below).
- After execute, verify: direct EOA admin calls on each transferred contract
  must fail; admin ops go only through governance proposals.

## RESOLVED 2026-07-05 (later the same day): P0 liquidation wiring

Option 2 executed. **Fresh instances deployed, wired, seeded, and enrolled:**

| Contract | Address | State |
|---|---|---|
| liquidation | `CDCRNKXTTTOO7IRVC66KZR5QMVGGZIOF2QPJSVELLD7G7F4IVLM2DCMG` | initialized → current engine/vault/insurance, max_reward_bps 50 |
| insurance | `CA3VD55APWCYLVN7PYGJ7NPKSQBE3VU4MWVCSKLOYAZI5RFWWR76G2CL` | initialized, set_vault(current), **seeded 500 USDC** |

Cross-wiring verified by direct instance-storage reads: engine.{Liquidation,
Insurance} ✓, vault.{Liquidation,Insurance} ✓. Configs updated everywhere
(env local+VM, config defaults, render.yaml, manifests, GitHub production
vars). The June instances (`CCIDLNMN…`, `CD45VRVG…`) are ABANDONED — their
queued proposals (`f1f053af…`, `e4aa61c1…`) will fail execute; ignore them.

**Two NEW proposals queued for the fresh instances, `eta = 1783445784`
= 2026-07-07T17:36:24Z** (later than the core four).

Tooling: `client/scripts/rewire-liquidation.ts` (idempotent; ONLY_GOVERNANCE=1
reruns just the enrollment). Root-cause guard for mainnet: the deploy manifest
must fail if any live contract references a non-manifest address — and verify
every target's on-chain admin before phase 1.

## EXECUTED 2026-07-07 (core four)

At 2026-07-07 ~15:45–15:49 UTC (core-four timelock matured 09:09), admin of
the four core contracts transferred to governance `CBZT5HUXI…A6MU`:

| Contract | admin now | tx |
|---|---|---|
| oracle-adapter | ✓ GOVERNANCE | 08c2020609… |
| vault | ✓ GOVERNANCE | 76b2ccdc1e… |
| engine | ✓ GOVERNANCE | b42db5dc7365… |
| order-gateway | ✓ GOVERNANCE | 863b8b402806… |

Verified on-chain (instance Admin == governance, PendingAdmin cleared). Oracle
keeper kept publishing throughout (publisher role ≠ admin). Testnet congestion
required retrying oracle+vault (first submits 404'd / timed out) — done via a
direct governance.execute retry loop at fee 10 XLM. **liquidation + insurance
still PENDING** — their proposals mature 2026-07-07T17:36:24Z (`#11 Unauthorized`
= timelock-not-matured until then).

## Remaining: liquidation + insurance (≥ 17:36:24Z) + verify

1. `pm2 stop kryon-oracle` on the VM, then rerun
   `ADMIN_SECRET=$ORACLE_PUBLISHER_SECRET npx tsx scripts/transfer-admin-to-governance.ts execute`
   (the 4 core will `#5` = already-executed; liq/insurance will now succeed).
2. `ADMIN_SECRET=$ORACLE_PUBLISHER_SECRET npx tsx scripts/verify-decentralization.ts`
   → must print "Fully decentralized".
3. `pm2 start kryon-oracle` on the VM.

## Updated July-7 execute sequence (superseded by the two blocks above)

1. ≥ 2026-07-07T09:09:35Z: `pm2 stop kryon-oracle` (on the **VM** — the fleet
   lives there now: `ssh -i ~/.ssh/kryon-vm-oracle.key opc@92.4.91.30`), then
   `ADMIN_SECRET=$ORACLE_PUBLISHER_SECRET npx tsx scripts/transfer-admin-to-governance.ts execute`
   → expect 4 successes (oracle-adapter, vault, engine, order-gateway) and 2
   failures (the abandoned June liquidation/insurance ids — expected).
2. ≥ 2026-07-07T17:36:24Z: rerun the same execute command → the two NEW
   liquidation/insurance proposals execute.
3. `ADMIN_SECRET=$ORACLE_PUBLISHER_SECRET npx tsx scripts/verify-decentralization.ts`
   → must print "Fully decentralized" (simulated EOA admin calls rejected on
   all 6 contracts + governance guardian pause/unpause drill).
4. `pm2 start kryon-oracle` on the VM.

## Guardian fast-path pause (mainnet-bound source change, 2026-07-05)

vault + gateway now have `set_guardian` and `emergency_pause(caller)` where
the guardian may pause instantly but only the admin can unpause (commit
41abc9a). The deployed testnet instances predate this — on testnet the only
fast pause after the transfer is the governance guardian veto. On MAINNET:
deploy with the new WASM, set a distinct guardian key on vault + gateway
BEFORE transferring admin, and include `set_deposit_cap` in launch config.

## Blockers / follow-ups

1. **liquidation (`CCIDLNMN…NRWK`) + insurance (`CD45VRVG…54KT`) admin is the
   original deployer `GBTL7SKB…TGDI`.** The current deployer key cannot
   nominate on them. Locate that key (it was used for the initial 2026-06
   deployment; check the original deploy operator's storage), then:

   ```bash
   stellar contract invoke --id <contract> --source-account <OLD_DEPLOYER_SECRET> \
     --network testnet -- nominate_admin \
     --next_admin CBZT5HUXI42TD55GGB5Y7OZZ72IT5SN64ONOGDYS2PFQCOWIT4XOA6MU
   ```

   The queued proposals then become executable at/after the same ETA. If the
   key is lost, these two contracts must be redeployed (their state is
   testnet-only) — treat as a hard prerequisite for the mainnet ceremony:
   **on mainnet, verify every target's on-chain admin before phase 1.**

   **UPDATE (stress test, same day): this blocker is worse than an admin
   formality.** The June liquidation/insurance instances still point at the
   superseded June engine/vault (`set_engine`/`set_vault` were never run
   after the 2026-07-05 core redeploy), so **no liquidation can execute at
   all** and insurance cover/bad-debt cannot reach the new vault. Every
   `liquidate()` fails with `Error(Contract, #6)`. Fix requires either the
   old key (option 1) or fresh liquidation+insurance instances wired to the
   new core (option 2) — full details and the exact call list in
   `Audit Reports/STRESS_TEST_REPORT.md` (P0 finding).

2. Mainnet: guardian must be a distinct key (ideally multisig), and the
   governance admin itself should not be the deployer EOA.
