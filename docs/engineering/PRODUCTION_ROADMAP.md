# Kryon on Arc: Implementation Status and Production Roadmap

**Scanned:** 2026-09-17, merge commit `eeadae1` on `integrate/arc-work` (repository setup on `main` plus the contract review fixes, DB baseline and indexer). **Build status verified by running:** contracts 258/258 tests, differential fuzz 9/9, `cargo test` 19/19, storage layouts unchanged, Slither 0 findings at Medium and above; client 91/92 with a local Postgres (1 skip needs a running arc-anvil; 80/81 without the DB), `tsc` clean, lint 0 errors, `next build` ok. Coverage was not re-run (last recorded 97.7% lines / 95.9% branches).

Kryon is a perpetual-futures DEX on **Arc mainnet** (chain 5042). It pairs an off-chain price-time CLOB with on-chain custody, margin, funding, liquidation, fees and settlement. USDC is both collateral and gas.

This roadmap treats Kryon as a **standalone product**: its own brand surface, domain, database, hosting, keys, repo and operations, sharing nothing with any earlier deployment.

---

## 1. How much is done

### 1.1 By workstream

| # | Workstream | Done | Evidence |
|---|---|---|---|
| A | **Smart contracts** (Solidity, `kryon-protocol/evm`) | **~90%** | 8 contracts + timelock, UUPS/ERC-7201, deploy scripts 00–05/99, 258 tests, invariants, differential fuzz vs Rust, Arc fork tests, Slither 0 High/Medium, gas pass done, ERC-1271 backstop unwind. **Review fixes FIX 1–9 applied and merged** (`18ed19d`): bounded guardian veto/pause, oracle re-anchor, insurance mark-to-market, batch gas reserve + bounded ERC-1271 gas, referrer allowlist, exact role verification, liquidation-reward warning. **Phase 1 decisions applied** (fees, split, `max_reward_bps` 15, BTC+ETH launch, XLM/ADA removed) with `EnvironmentConfigTest`; audit package `infra/audit/` (3,339 nSLOC in scope). **Phase 1 complete (2026-09-19):** reduced nightly 275/275 on `c5c0844`, `audit-v1` tagged there. **Open:** external audit, full nightly as an audit addendum |
| B | **Chain SDK** (`client/lib/chain`, `lib/market/eip712.ts`) | **~95%** | viem clients with RPC fallback, generated ABIs (regenerated after the fixes, `380eb89`), EIP-712 parity with the contracts, TxSender (nonce, 20 gwei floor, rebroadcast/replace), settlement encoding, Multicall3 health reads, Chainlink reader, **Postgres `PgTxJobStore`** with a shared contract test suite. Only the indexer consumes it so far |
| C | **Off-chain services** (matcher, oracle, indexer, reconciler, liquidation, funding, monitor, WS, stats) | **~15%** | **Indexer ported** (`da5f8db`, `49b79f2`): `lib/indexer` (decode, projections, replay) + `scripts/state-indexer.ts`, ~1.3k lines with tests. Matching algorithm (`lib/market/matcher.ts`) and WS/stats logic are reusable. **The other chain-facing services still run on the legacy SDK:** 19 of 26 scripts in `client/scripts` import it (matcher, oracle keeper, liquidation keeper, funding keeper, reconciler, monitor, deploy/upgrade/gate scripts). `ws-server` and `stats-aggregator` have no chain imports but read the legacy data model |
| D | **Database** | **~80%** | **Arc baseline committed** (`b86dfbe`): legacy migrations squashed into `20260917000000_arc_baseline`; log-keyed event projections (fills, positions, oracle, funding, liquidation/ADL, backstop unwinds, fee accrual/claim/tier), EVM `TxJob`, `GasSpend`, `DeploymentArtifact`, `GovernanceOperation`, 1e6 analytics; `NUMERIC(78,0)` integers; 98 CHECK constraints. **Open:** provider/project, PITR backups + restore drill, read replica, separate local/staging/prod DBs |
| E | **Frontend + API** | **~5%** | 6 pages and 19 API routes exist and the UI design is reusable, but **29 app/feature/lib/component/store files import the legacy SDK or wallet** (plus 11 files in `lib/stellar`). No EVM wallet connection (wagmi/RainbowKit not installed; only `@wagmi/cli` for codegen), no EIP-712 order flow, no permit deposit, fees hardcoded, `/api/settlements` co-sign flow still present |
| F | **Infra, CI/CD, ops** | **~25%** | CI has `separation-guard`, `client`, `reference-model`, `evm` (pinned arc-foundry, differential, storage layout, Slither), `prisma` (migration drift) and `security` jobs, plus CodeQL and dependency review. **Removed:** legacy deploy workflows, legacy deploy records and tooling, the Render blueprint, the legacy production gate step. Arc deploy manifests exist only as `environments/arc-*.toml`. **Open:** Arc deploy workflows (Phase 5), Docker/PM2 configs and runbooks still describe the legacy services, no monitoring, no hosting |
| G | **Testnet deployment and drills** | **0%** | Only local arc-anvil deploys. No Arc testnet deployment, no E2E, no soak |
| H | **Security and launch** (audit, bounty, legal, compliance) | **~2%** | Auditor RFQ email drafted (kept outside the repository, not sent). No auditor booked, no bounty, no legal work |
| I | **Standalone identity** (domain, DB, hosting, repo, keys, docs) | **~45%** | **Repo done:** public `github.com/SamyaDeb/KryonProtocol`, pushed, CI running; workspace outside iCloud. **Cut ties done:** Vercel link, local env files and legacy audit reports moved to a private archive; wrangler worker renamed to a neutral name; tunnel config is a template with placeholder hostnames and tunnel id; old domain, VM address and account ids replaced by placeholders in infra scripts and docs; legacy deploy records, workflows and Render blueprint deleted; Arc-only env templates (names only); planning docs moved to `docs/engineering/`; Arc-only README; `separation-guard` CI job. **Open:** domain, Cloudflare account/zone and tunnel, DB provider, RPC providers, secrets vault, branch protection, brand decision (see §2) |

### 1.2 Overall

Weighted by the effort remaining to a production mainnet launch (contracts 30%, services 20%, frontend/API 15%, DB 5%, infra/ops 10%, testnet+audit+launch 15%, identity 5%):

> **About 40% complete to production mainnet** (39.7% by the weights above, up from ~33% at `43a7063`).
> Since the last scan: the contract review fixes landed, the Arc database baseline and Postgres TxJob store were built, the indexer was ported, and the repository was published with the old deployment's ties cut (F 20% → 25%, I 15% → 45%; together about +1.8 points). The contracts are close to audit-ready. Most of what a user or operator touches (services other than the indexer, the frontend, hosting, testnet, audit) has not been built on Arc yet.

---

## 2. Separation audit: what is still tied to the old deployment

These must be cut before anything is deployed from this repo. Some are **dangerous**: a routine deploy command would overwrite the other product.

| Severity | Item | Where | Risk | Action |
|---|---|---|---|---|
| ✅ | Vercel project link | `client/.vercel/` | — | **Done:** moved to the private archive. Create a new project only if Vercel is chosen (§4.5) |
| ✅ | Cloudflare Worker name | `client/wrangler.jsonc` | — | **Done:** renamed to a neutral `kryonprotocol-web`; no account, zone or route ids in the file. Deploy only from a new Cloudflare account |
| ✅ | Tunnel hostnames | `kryon-protocol/infra/a1flex/cloudflared-config.yml` | — | **Done:** template with `<TUNNEL_ID>` and `*.<APP_DOMAIN>` hostnames. **Open:** create the tunnel and its credentials in the new account |
| ✅ | Local env files | `client/.env.local`, `client/.env.production.local`, `kryon-protocol/.env` | — | **Done:** moved to the private archive. Arc-only `*.example` templates (names only) are committed |
| 🟠 | Shared host | `infra/a1flex/*` | Resource contention, blast radius, shared SSH/keys | Scripts no longer default to the old host (they require `DOMAIN` / `DB_HOST`). **Open:** a dedicated host or managed platform, new SSH keys and user |
| 🟠 | Database | Legacy client code still routes through the old serverless Postgres driver (`client/lib/sql.ts`) | Accidental writes into another product's DB if an old URL is reused | Templates carry no URLs. **Open:** choose the DB provider, create new projects and roles per environment (Decision 8). Never reuse old connection strings |
| ✅ | Docs/app URLs | `docs/docusaurus.config.ts`, READMEs, `check-go-live.sh` | — | **Done:** `<APP_DOMAIN>` placeholders, "live on…" claims removed. **Open:** fill in once the domain exists |
| ✅ | Legacy deploy records and workflows | `infra/deploy/`, `infra/budget/`, `infra/rpc/`, legacy runbooks, `client/render.yaml`, legacy deploy workflows | — | **Done:** deleted (`docs/engineering/REPO_SETUP_LOG.md`) |
| ✅ | Legacy audit reports | `Audit Reports/` | — | **Done:** moved to the private archive |
| ✅ | `.mailmap`, root migration docs, `docs/SETTLEMENT_AUTH.md` | Repo root/docs | — | **Done:** plan and build log moved to `docs/engineering/`, the rest archived. **Open:** rewrite `docs/arc-facts.md` as "Arc platform facts" |
| ✅ | Stray folder | root `/lib` | — | **Done:** not present; ignored in `.gitignore` |
| ✅ | Workspace location | Outside iCloud | — | **Done** |
| ✅ | Git remote | `github.com/SamyaDeb/KryonProtocol` | — | **Done:** pushed; CI runs on every PR and push to `main` |
| 🟠 | Branch protection, secret scanning | GitHub settings | Force pushes or unreviewed merges to `main` | **Open:** required checks, no force pushes/deletions, push protection |
| 🟠 | Accounts and secrets | Domain, Cloudflare, DB provider, RPC providers, vault | Nothing can be deployed standalone | **Open:** Phase 0 steps 3–4 |
| 🟡 | Brand/name | "Kryon" is also the other product's name | Presented as separate but carries the same name | **Decision:** keep "Kryon" on a new domain, or rebrand (§6 Decision 1) |

The old hostnames, domain, VM address and hosting-provider ids are described above, never written out: the `separation-guard` CI job fails the build if any tracked file contains them.

Legacy-coupled code inventory (all replaced by the phases below):
- `client/lib/stellar/*` (11 files) and `@stellar/stellar-sdk`, `@stellar/freighter-api` (still in `package.json`).
- 19 of 26 scripts still importing the legacy SDK (`state-indexer.ts` is ported).
- 29 app/feature/lib/component/store files.
- 85 client, 50 protocol, 24 docs and 1 CI file mention the legacy chain.

---

## 3. Target production architecture (standalone)

```
                    kryon.<tld> (new domain, Cloudflare DNS + WAF)
                    │
   app.<tld> ───────┤ Next.js (web tier)          docs.<tld> ─ Docusaurus
   api.<tld> ───────┤ /api routes (same app)      status.<tld> ─ status page
   ws.<tld>  ───────┤ WS server
                    │
   Service host(s) (dedicated; PM2 or containers)
     matcher[shard per market] · oracle publishers ×2–3 (separate hosts)
     indexer · reconciler · liquidation keeper · funding keeper
     monitor · stats aggregator · ws server
                    │
   Postgres (new project; primary + read replica, PITR backups)
                    │
   Arc mainnet RPC: provider A (primary, WSS) → provider B → public
                    │
   Contracts on Arc (UUPS proxies) ← KryonTimelock 48h ← Governance Safe
                                    ← Guardian Safe (bounded pause/veto)
   Treasury Safe ← FeeRouter claims
```

Environments: **local** (arc-anvil) → **staging** (Arc testnet, public) → **production** (Arc mainnet). Each has its own DB, keys, domain prefix and deployment JSON.

---

## 4. Roadmap to production mainnet

Every phase ends with an **exit gate**. Nothing moves forward until its gate passes.

### Phase 0: Standalone foundation (week 1)

> **Status (2026-09-17):** steps 1–2 and 5 **done**, except branch protection: repository published at `github.com/SamyaDeb/KryonProtocol` with CI (including `separation-guard`); Vercel link, env files and legacy audit reports archived; wrangler worker renamed; tunnel config, domain, VM and account ids replaced by placeholders; legacy deploy records, workflows and Render blueprint deleted; Arc-only env templates; docs moved to `docs/engineering/` and an Arc-only README (see `docs/engineering/REPO_SETUP_LOG.md`). **Open:** branch protection, step 3 (brand decision, domain, Cloudflare account/zone and tunnel, DB provider, RPC providers and other accounts) and step 4 (secrets vault).

1. **Workspace:** move the repo out of iCloud. Create a new GitHub org/repo, push, turn on branch protection (required checks, signed commits, CODEOWNERS for `evm/` and `infra/`).
2. **Cut ties** (§2 🔴/🟠): delete `.vercel/`; rename the wrangler worker; replace the tunnel config; move old `.env*.local` files out of the repo; delete the legacy deploy manifests, runbooks and budget/rpc docs; move `Audit Reports/` and the migration docs out; delete the root `lib/`.
3. **Identity:** decide the name (Decision 1). Register the domain. Create new accounts: Cloudflare account + zone, DB provider project, RPC provider accounts (2), error tracking, uptime/status, email/support inbox, analytics.
4. **Secrets management:** a vault (1Password/Doppler/SOPS) holding every environment variable. No `.env` files with real values on disk except on hosts.
5. **Docs reset:** a README, ARCHITECTURE and docs site that describe Kryon on Arc only.

**Exit gate:**
- The `separation-guard` CI job passes (✅ on `main`).
- No legacy project IDs remain (✅).
- The new repo passes CI (✅).

### Phase 1: Contract hardening (weeks 1–2)

> **Status (2026-09-19): complete.** FIX 1–9 merged in `18ed19d`; Decisions 2–5 applied to the Arc configs with a regression test; audit package in `kryon-protocol/infra/audit/`; 259 tests, coverage 97.67/95.22, Slither 0 High/Medium, dry-run `99_VerifyDeployment: OK` with no warnings. Step 3: the **reduced** nightly (fuzz 250,000, invariants 1024 × 128) passed on `c5c0844` (21 suites, 275 tests, 0 failures); the full 1M / 2048 × 256 profile runs during the audit as an addendum. Step 4: `audit-v1` on `c5c08443967e92a8952bb805b172bf3fe05097aa`; later `evm/src` changes get `audit-v1.N` with a recorded diff, the first being the whitespace-only `audit-v1.1` formatting pass.

1. Apply `docs/engineering/prompts/CONTRACT_FIXES_PROMPT.md` FIX 1–9:
   - bounded guardian veto and pause;
   - oracle re-anchor after an outage;
   - insurance marked to market;
   - batch gas reserve and bounded ERC-1271 gas;
   - referrer allowlist;
   - exact timelock role verification;
   - liquidation reward warning;
   - oracle-coverage verifier check;
   - housekeeping.
2. Remaining decisions that change code: fee schedule and split final (Decisions 2–3), launch markets (Decision 5), liquidation reward vs fee per market.
3. Run the nightly profile once: 1M-run differential + 2048×256 invariants.
4. **Code freeze** for audit: tag `audit-v1`, then build the audit package (`infra/audit`).

**Exit gate:** all suites green, coverage ≥95/90, Slither 0 High/Medium, storage-layout snapshots committed, `audit-v1` tag.

### Phase 2: Data layer (weeks 2–3, parallel with 3)

> **Status (2026-09-17):** steps 1–2 **done** (`b86dfbe`). Steps 3–4 (backups/replica, per-environment DBs) and the restore drill open.

1. New Prisma baseline, squashed with no legacy migrations:
   - `BlockCursor`;
   - events keyed `(network, txHash, logIndex)`;
   - `Order.orderHash` / `referrer`;
   - `Fill` with real tx hash, block, fees, status;
   - `TxJob` (EVM fields, row per attempt as built in the SDK);
   - `DeploymentArtifact` (proxy/impl/codeHash);
   - `GovernanceOperation`;
   - fee ledger (`FeeAccrual`, `FeeClaim`, `FeeTierAssignment`);
   - `GasSpend`;
   - `BackstopUnwind`;
   - analytics tables in 1e6 units;
   - lowercase-address CHECKs.
2. Postgres `TxJobStore` implementation behind the existing interface.
3. The DB provider's own backups (PITR) and a read replica for the API; migrations run from CI only.
4. Separate DBs: `kryon_local`, `kryon_staging`, `kryon_prod`.

**Exit gate:** `prisma migrate deploy` works on an empty staging DB, the indexer replay test rebuilds all tables from logs, and a restore drill from backup passes.

### Phase 3: Off-chain services on Arc (weeks 2–5)

> **Status (2026-09-17):** indexer **done** (`da5f8db`, replay test included). All other services open.

Build every service on `lib/chain` + TxSender, one process per key.

| Service | Must do | Tests |
|---|---|---|
| Matcher | Price-time matching (existing algorithm); `minFillNotional`; batches ≤ 40 per market; optimistic pending fills; roll back on `FillRejected`; resize on `InsufficientBatchGas`; real tx hash/block | Unit tests on the book; anvil E2E with partial fills and rejections |
| Order intake API | EIP-712 verify (EOA + 1271), expiry ≤ 7d, nonce rules, rate limits, optional address screening | Fuzzed payloads, replay, bad signatures |
| Oracle publishers ×2–3 | 3-CEX median, USDC de-peg guard, deviation ≥5 bps or 5s heartbeat, Chainlink divergence check; publish every feed with OI > 0 | Outage/re-anchor drill; divergence halt |
| Indexer | `getLogs` windows, idempotent, block cursor, all contract events → tables | Kill-and-resume; full replay equality |
| Reconciler | Drives open TxJobs, re-simulates, decodes reverts | Crash mid-send recovery |
| Liquidation keeper | Multicall3 health scans, partial steps, ADL when `unfundedShortfall > 0`, backstop-unwind signer (bounded) | Liquidation cascade drill |
| Funding keeper | Hourly `updateFunding` per market, verify state | Equal-timestamp and missed-hour cases |
| Monitor | Oracle freshness per feed with OI, signer gas balance, dropped/replaced tx, RPC failover, role/impl drift, invariant #5 (`Vault.solvency`), fees vs gas, backstop exposure, insurance coverage | Alert fires in staging |
| WS server | Book deltas, trades, pending/confirmed fills | Load: 1k clients |
| Stats aggregator | Leaderboard, portfolio, 30-day volume for tiers; fee-tier bot | Against replayed data |

Delete all legacy service code as each replacement lands.

**Exit gate:** the full local E2E (deposit → trade → funding → liquidation → ADL → fee claim → withdraw) runs unattended on arc-anvil, with the monitor showing all green.

### Phase 4: Frontend, API and developer surface (weeks 3–6)

1. **Wallet:** wagmi + viem + RainbowKit (injected, WalletConnect, Coinbase, Ledger); Arc chain enforcement; single USDC balance; gas-buffer warning.
2. **Trading:**
   - `signTypedData` orders and cancels, and on-chain `cancelUpTo`;
   - permit + deposit (Permit2 fallback), withdraw with an equity preview;
   - positions, liquidation price, funding;
   - fee schedule and user tier from `/api/fees`, estimated fee shown before signing.
3. **Remove:** the settlement co-sign modal, `/api/settlements`, trustline and legacy asset UI.
4. **Onboarding:** "Deposit from another chain" via Circle CCTP V2 / App Kit.
5. **Pages:** trade, markets, portfolio, leaderboard, plus **new**:
   - fees/tiers;
   - insurance fund & staking (stake, request/withdraw unstake, share price, backstop exposure);
   - transparency (contract addresses, timelock queue, solvency live);
   - legal (ToS, privacy, risk disclosure);
   - geoblock page.
6. **API:** `/api/eip712`, versioned `/v1`, OpenAPI spec, WS docs, SDK snippets (viem/ethers); agent docs rewritten for EIP-712 and 1e6/1e18 units.
7. **Quality:** Playwright E2E on staging, Lighthouse, accessibility pass, mobile layout, error tracking.

**Exit gate:**
- `npm run build`, lint, tsc and unit tests pass.
- Playwright suite passes against staging.
- No legacy dependency remains in `package.json`.

### Phase 5: Infrastructure, security operations, CI/CD (weeks 4–7)

1. **Hosting.**
   - Web: a new Vercel project or the dedicated host behind the tunnel.
   - Services: a dedicated host per environment (≥2 for production: primary + oracle publisher on separate hosts/regions). Containers (`Dockerfile.services`) managed by PM2 or systemd.
2. **Network:** Cloudflare DNS, WAF, rate limits on `/api`, bot protection, TLS. The WS tunnel runs under a new tunnel ID.
3. **Keys:**

   | Role | Custody |
   |---|---|
   | Governance Safe (e.g. 3-of-5 hardware wallets) | distinct people |
   | Guardian Safe (2-of-3) | on-call |
   | Treasury Safe | finance signers |
   | Operator ×shards, publishers ×3, funding keeper, liquidator, fee-tier bot, backstop signer | KMS or encrypted keystores on hosts |
   | Deployer | single-use, retired after handover |

   Rotation runbook.
4. **Observability:** metrics (Prometheus/Grafana or a provider), logs, alert routing (PagerDuty/Telegram) with on-call, and a public status page.
5. **CI/CD:**
   - `ci.yml`: client + evm + reference model + Playwright + grep guard against legacy references.
   - `deploy-staging` on merge to main; `deploy-production` on tag with manual approval.
   - `mainnet-preflight` asserts chain ID 5042, addresses == deployment JSON, roles exact, fees and risk params == approved config.
   - `invariants-nightly`.
6. **Runbooks:** incident, oracle-failure (incl. re-anchor), matcher-failure, settlement-stuck (nonce/replacement), liquidation-cascade, backstop-unwind, timelock-operations, guardian-pause, key-rotation, fee-treasury, DB restore, RPC failover.
7. **Budget:** gas cost model (oracle, settlement, keepers) vs fee revenue; RPC and hosting costs.

**Exit gate:** staging runs entirely on the production topology; an alert-fire drill for every monitor rule is acknowledged by on-call; the DB restore drill passes.

### Phase 6: Arc testnet staging (weeks 6–9)

1. Fund staging keys (testnet USDC faucet). Deploy with `DeployAll` to Arc testnet; `99_VerifyDeployment: OK`; verify source on the explorer.
2. Run all services on staging, and open the app at `staging.<tld>` to an invited group.
3. **Drills:**
   - liquidation cascade;
   - oracle outage + re-anchor;
   - RPC provider failure;
   - matcher crash mid-batch;
   - DB failover;
   - guardian pause/expiry;
   - timelock upgrade of one contract;
   - backstop unwind;
   - ADL;
   - fee claim.
4. **Load:** 40+ wallets, sustained order flow, 40-fill batches, 1k WS clients.
5. **7-day soak:** no unreconciled TxJob, invariant #5 exact, oracle freshness SLO ≥ 99.9%, fees accounted to the wei.

**Exit gate:** every drill documented with results; soak clean; open defects triaged, none High.

### Phase 7: Security review and launch readiness (weeks 7–13, overlaps 6)

1. **External audit** of `audit-v1` (two firms, or one firm + a competitive contest). The package includes the liquidation-sizing change, backstop unwind and fee router.
2. **Fix review:** re-audit of the diffs, then tag `mainnet-v1`.
3. **Bug bounty** (e.g. Immunefi) live **before** deposits open.
4. **Legal and compliance:**
   - entity; ToS, privacy, risk disclosures;
   - jurisdiction geofencing (web + API);
   - address screening vendor (Chainalysis/TRM/Elliptic);
   - review of perps + fee-taking exposure.
5. **Operational readiness review:** runbooks walked through, on-call rota, Safe signers rehearsed on testnet (schedule/execute/cancel, guardian veto), treasury claim rehearsal.
6. **Economic review:**
   - fee schedule vs competitors on Arc;
   - insurance seed amount;
   - OI caps per market;
   - liquidation reward/penalty per market;
   - oracle parameters per feed.

**Exit gate:** audits closed with no open Critical/High; bounty live; legal sign-off; readiness review signed.

### Phase 8: Mainnet launch (weeks 13–14), then scale

1. **Ceremony** (recorded, checklist-driven):
   - fresh deployer;
   - `DeployAll` on Arc mainnet with the approved config;
   - handover in the same run;
   - `99_VerifyDeployment: OK`;
   - explorer verification;
   - publish the deployment JSON and addresses on the transparency page.
2. **Seed** insurance (donate/stake) before any OI-policy value is set.
3. **Guarded launch:** `depositCap = 0` at deploy → timelock raises it to $250k total / $10k per account after verification. Two markets (BTC, ETH), low OI caps, `minFillNotional` $40, referrals off, rebates off.
4. **Hypercare, 2 weeks:** on-call 24/7, daily solvency + fee reconciliation report, no parameter changes except through the timelock.
5. **Scale via timelock:**
   - raise caps;
   - add markets with Chainlink coverage (SOL, XRP, BNB, TRX);
   - lower `minFillNotional` when the fill mix confirms gas;
   - enable fee tiers, then referrals (with the approved-referrer allowlist);
   - evaluate EURC collateral and smart-wallet onboarding.

**Launch gate (all required):**
- [ ] Contracts: audit closed, `mainnet-v1` deployed, verified, roles exact, no EOA admin
- [ ] Safes: governance, guardian and treasury created on Arc mainnet, signers rehearsed
- [ ] Services: all running on production topology; monitor green 72h pre-launch
- [ ] Oracles: ≥2 independent publisher hosts; Chainlink cross-check live for launch markets
- [ ] DB: backups + restore drill; replica serving API
- [ ] Web: domain, WAF, geofence, legal pages, status page
- [ ] Bug bounty live; incident runbooks + on-call rota
- [ ] Insurance seeded; caps and params match the approved config (preflight CI green)

---

## 5. Timeline

| Weeks | Work |
|---|---|
| 1 | Phase 0 foundation; Phase 1 fixes start |
| 1–2 | Phase 1 hardening → `audit-v1` freeze |
| 2–5 | Phase 2 DB + Phase 3 services |
| 3–6 | Phase 4 frontend/API |
| 4–7 | Phase 5 infra, CI/CD, runbooks |
| 6–9 | Phase 6 Arc testnet staging, drills, soak |
| 7–13 | Phase 7 audit, bounty, legal, readiness (audit calendar is the long pole) |
| 13–14 | Phase 8 mainnet ceremony + guarded launch |

**About 13–14 weeks to a guarded mainnet launch**, assuming an auditor slot is booked in week 2.

**Update 2026-09-17:** the Phase 1 fixes, the Phase 2 schema and the indexer are done ahead of schedule. That leaves roughly **11–13 weeks**, still limited by when an auditor slot can be booked.

---

## 6. Decisions needed from you

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| 1 | Product name and domain | Keep "Kryon" only with a clearly distinct domain and brand; otherwise rebrand before any public staging | Phase 0 |
| 2 | Fee schedule | ✅ **Decided 2026-09-17:** 3.5 bps taker / 0.5 bps maker, 1 bps net floor, rebates off | Phase 1 freeze |
| 3 | Fee split | ✅ **Decided 2026-09-17:** 70 treasury / 20 insurance / 10 referral (to treasury while referrals are off); liquidation remainder 50/50 insurance/treasury | Phase 1 freeze |
| 4 | Liquidation reward vs penalty | ✅ **Decided 2026-09-17:** `max_reward_bps` 25 → 15 (BTC 15/10, ETH 15/20 reward/remainder), guarded by `EnvironmentConfigTest` | Phase 1 freeze |
| 5 | Launch markets | ✅ **Decided 2026-09-17:** BTC-PERP, ETH-PERP; SOL/XRP/BNB/TRX listed inactive; XLM/ADA removed. Caps $250k / $10k, OI BTC 5 / ETH 100, min fill $40, batch 40 | Phase 1 config |
| 6 | Safe signers and thresholds (governance / guardian / treasury) | 3-of-5 / 2-of-3 / 2-of-3, hardware wallets, distinct people | Phase 5 |
| 7 | Hosting | Web on Vercel (new project) or a dedicated host; services on 2 dedicated hosts | Phase 5 |
| 8 | Database provider | Managed Postgres with PITR and a read replica, a new project | Phase 2 |
| 9 | RPC providers | Two paid (e.g. Alchemy + QuickNode) with mainnet WSS | Phase 3 |
| 10 | Auditors + bounty size | Book 2 firms now; bounty sized to the deposit cap | Phase 7 |
| 11 | Legal entity, jurisdictions to geofence, screening vendor | Counsel review before staging opens publicly | Phase 7 |
| 12 | Insurance seed amount | ≥ 10% of the initial deposit cap | Phase 8 |

---

## 7. Immediate next actions (this week)

1. ✅ **Done:** planning docs committed under `docs/engineering/`; the auditor RFQ draft and superseded prompts archived outside the repository.
2. ✅ **Done:** repository published, ties to the old deployment cut, and the two working copies integrated into one `main`. Remaining Phase 0: branch protection, accounts, secrets vault, brand decision.
3. ✅ **Done (Phase 1 complete):** #2–#5 decided and applied, audit package built, reduced nightly green on `c5c0844` (275/275), `audit-v1` tagged there; nSLOC recounted at the tag (3,339).
4. **Send the auditor RFQ email now** (final text kept outside the repository) and book auditors: the audit calendar is the long pole. During the audit: run the full nightly profile and add it to `RESULTS.md` as an addendum.
5. Continue Phase 3 with the matcher + order intake, then the reconciler and keepers, on `lib/chain` + `PgTxJobStore`.
6. ✅ Client tests and `tsc` re-verified after the integration (see the scan line at the top).
