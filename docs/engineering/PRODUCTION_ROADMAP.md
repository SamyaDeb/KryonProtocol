# Kryon on Arc: Implementation Status and Production Roadmap

**Scanned:** 2026-09-17, commit `43a7063` (23 commits). **Build status verified by running:** contracts 224/224 tests passing, client 74/75 passing (1 env-gated skip), `tsc` clean.

Kryon is a perpetual-futures DEX on **Arc mainnet** (chain 5042). It pairs an off-chain price-time CLOB with on-chain custody, margin, funding, liquidation, fees and settlement. USDC is both collateral and gas.

This roadmap treats Kryon as a **standalone product**: its own brand surface, domain, database, hosting, keys, repo and operations, sharing nothing with any earlier deployment.

---

## 1. How much is done

### 1.1 By workstream

| # | Workstream | Done | Evidence |
|---|---|---|---|
| A | **Smart contracts** (Solidity, `kryon-protocol/evm`) | **~85%** | 8 contracts + timelock, UUPS/ERC-7201, deploy scripts 00–05/99, 224 tests, invariants, differential fuzz vs Rust, Arc fork tests 8/8, coverage 97.7% lines / 95.9% branches, Slither 0, gas pass done (279k–378k per fill), ERC-1271 backstop unwind. **Open:** 3 medium review findings + 5 low (`prompts/CONTRACT_FIXES_PROMPT.md`, not yet applied), external audit |
| B | **Chain SDK** (`client/lib/chain`, `lib/market/eip712.ts`) | **~95%** | viem clients with RPC fallback, generated ABIs, EIP-712 parity with the contracts, TxSender (nonce, 20 gwei floor, rebroadcast/replace), settlement encoding, Multicall3 health reads, Chainlink reader. **Nothing uses it yet.** Postgres TxJob store pending |
| C | **Off-chain services** (matcher, oracle, indexer, reconciler, liquidation, funding, monitor, WS, stats) | **~10%** | Matching algorithm (`lib/market/matcher.ts`) and WS/stats logic are reusable. **All 7 chain-facing services still run on the legacy chain SDK** (0 import `lib/chain`) |
| D | **Database** | **0%** | `prisma/schema.prisma` is still the legacy model: ledger cursors, XDR tx jobs, wasm hashes, no fee ledger. No Arc baseline migration |
| E | **Frontend + API** | **~5%** | 6 pages and 19 API routes exist and the UI design is reusable, but **31 files import the legacy SDK or wallet**. No EVM wallet connection (wagmi/RainbowKit not installed), no EIP-712 order flow, no permit deposit, fees hardcoded |
| F | **Infra, CI/CD, ops** | **~15%** | CI has `evm` + `reference-model` jobs (pinned arc-foundry). Everything else (hosting, tunnel, PM2, Docker, runbooks, monitoring, deploy manifests) is legacy |
| G | **Testnet deployment and drills** | **0%** | Only local arc-anvil deploys. No Arc testnet deployment, no E2E, no soak |
| H | **Security and launch** (audit, bounty, legal, compliance) | **0%** | Not started |
| I | **Standalone identity** (domain, DB, hosting, repo, keys, docs) | **~5%** | Fresh git repo with no remote. Everything else still points at legacy infrastructure (see §2) |

### 1.2 Overall

Weighted by the effort remaining to a production mainnet launch (contracts 30%, services 20%, frontend/API 15%, DB 5%, infra/ops 10%, testnet+audit+launch 15%, identity 5%):

> **About 33% complete to production mainnet.**
> The hardest and highest-risk part, the protocol contracts, is mostly done and well tested. Almost everything a user or operator would touch has not been built on Arc yet.

---

## 2. Separation audit: what is still tied to the old deployment

These must be cut before anything is deployed from this repo. Some are **dangerous**: a routine deploy command would overwrite the other product.

| Severity | Item | Where | Risk | Action |
|---|---|---|---|---|
| 🔴 | Vercel project link | `client/.vercel/project.json` (existing projectId/orgId) | `vercel deploy` from this repo **overwrites the other live site** | Delete `client/.vercel/`. Create a new Vercel project (or skip Vercel, §4.5) |
| 🔴 | Cloudflare Worker name | `client/wrangler.jsonc` `"name": "kryon-client"` | `npm run cf:deploy` **overwrites the existing worker** | Rename, and use a new Cloudflare account/zone |
| 🔴 | Tunnel hostnames | `kryon-protocol/infra/a1flex/cloudflared-config.yml` (the previous product's apex, `ws.` and `ws-testnet.` hostnames; now placeholders) | Running the tunnel **hijacks the other product's domain** | Replace with new hostnames and a new tunnel ID/credentials |
| 🔴 | Local env files | `client/.env.local`, `client/.env.production.local` (old network vars, contract IDs, old app URL and service secrets) | Services or builds silently use the old contracts, DB and keys | Move them out of the repo. Create fresh Arc `.env.*` from new examples |
| 🟠 | Shared host | `infra/a1flex/*` provisions the same OCI box that runs the other fleet | Resource contention, blast radius, shared SSH/keys | New dedicated host (or managed platform), new SSH keys and user |
| 🟠 | Database | Neon URLs in `.env.example`, README, runbooks; `sql.ts` Neon routing | Accidental writes into the other product's DB | New DB project, role and URL. Never reuse the old connection strings |
| 🟠 | Docs/app URLs | `docs/docusaurus.config.ts` (the previous deployment's app URL, tagline), README links and "live on…" claims, `check-go-live.sh` | Public confusion, broken links | New domain everywhere |
| 🟠 | Legacy deploy records | `infra/deploy/{mainnet,testnet}*.toml/json`, `role-transfer.sh`, `optimize-wasm.py`, legacy budget and RPC tooling, two legacy runbooks | Wrong addresses in ops tooling | Delete (Phase 1) |
| 🟡 | Legacy audit reports | `Audit Reports/` (6 files, untracked) | They describe different code; must not be presented as audits of this product | Move out of the repo |
| 🟡 | `.mailmap`, plan/prompt docs at the repo root, `docs/SETTLEMENT_AUTH.md`, `docs/arc-facts.md` wording | Repo root/docs | Transitional framing in a standalone product | Move plan docs to `docs/engineering/`, archive the rest; rewrite `arc-facts` as "Arc platform facts" |
| 🟡 | Stray folder | `/lib/openzeppelin-contracts-upgradeable` at repo root | Confusing duplicate dependency | Delete |
| 🟡 | Workspace location | Repo lives in iCloud-synced `~/Desktop` | Very slow builds and git lock timeouts (seen during this scan) | Move to a non-synced path (e.g. `~/code/kryon`) |
| 🟡 | Brand/name | "Kryon" is also the other product's name | Presented as separate but carries the same name | **Decision:** keep "Kryon" on a new domain, or rebrand (§6 Decision 1) |

Legacy-coupled code inventory (all replaced by the phases below):
- `client/lib/stellar/*` (11 files) and `@stellar/stellar-sdk`, `@stellar/freighter-api`.
- 32 scripts still importing the legacy SDK.
- 31 app/feature/lib files.
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

1. **Workspace:** move the repo out of iCloud. Create a new GitHub org/repo, push, turn on branch protection (required checks, signed commits, CODEOWNERS for `evm/` and `infra/`).
2. **Cut ties** (§2 🔴/🟠): delete `.vercel/`; rename the wrangler worker; replace the tunnel config; move old `.env*.local` files out of the repo; delete the legacy deploy manifests, runbooks and budget/rpc docs; move `Audit Reports/` and the transitional docs out; delete the root `lib/`.
3. **Identity:** decide the name (Decision 1). Register the domain. Create new accounts: Cloudflare account + zone, DB provider project, RPC provider accounts (2), error tracking, uptime/status, email/support inbox, analytics.
4. **Secrets management:** a vault (1Password/Doppler/SOPS) holding every environment variable. No `.env` files with real values on disk except on hosts.
5. **Docs reset:** a README, ARCHITECTURE and docs site that describe Kryon on Arc only.

**Exit gate:**
- `git grep -iE "vercel\.app|kryonprotocol|workers\.dev|neon\.tech"` returns only new values.
- No legacy project IDs remain.
- The new repo passes CI.

### Phase 1: Contract hardening (weeks 1–2)

1. Apply `prompts/CONTRACT_FIXES_PROMPT.md` FIX 1–9:
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

---

## 6. Decisions needed from you

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| 1 | Product name and domain | Keep "Kryon" only with a clearly distinct domain and brand; otherwise rebrand before any public staging | Phase 0 |
| 2 | Fee schedule | 3.5 bps taker / 0.5 bps maker, rebates off | Phase 1 freeze |
| 3 | Fee split | 70 treasury / 20 insurance / 10 referral | Phase 1 freeze |
| 4 | Liquidation reward vs penalty (BTC reward currently = penalty) | `max_reward_bps` 15, so insurance/treasury get a share | Phase 1 freeze |
| 5 | Launch markets | BTC-PERP, ETH-PERP | Phase 1 config |
| 6 | Safe signers and thresholds (governance / guardian / treasury) | 3-of-5 / 2-of-3 / 2-of-3, hardware wallets, distinct people | Phase 5 |
| 7 | Hosting | Web on Vercel (new project) or a dedicated host; services on 2 dedicated hosts | Phase 5 |
| 8 | Database provider | Managed Postgres with PITR and a read replica, a new project | Phase 2 |
| 9 | RPC providers | Two paid (e.g. Alchemy + QuickNode) with mainnet WSS | Phase 3 |
| 10 | Auditors + bounty size | Book 2 firms now; bounty sized to the deposit cap | Phase 7 |
| 11 | Legal entity, jurisdictions to geofence, screening vendor | Counsel review before staging opens publicly | Phase 7 |
| 12 | Insurance seed amount | ≥ 10% of the initial deposit cap | Phase 8 |

---

## 7. Immediate next actions (this week)

1. Decide #1 (name/domain) and move the repo out of iCloud into a new GitHub repo.
2. Execute Phase 0 step 2. **Delete the Vercel link, wrangler name, tunnel config and `.env*.local` before any deploy command is run.**
3. Run `prompts/CONTRACT_FIXES_PROMPT.md` in a dedicated session (Phase 1).
4. In parallel, start Phase 2 (DB baseline) and book auditors.
