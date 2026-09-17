# Repository setup log (2026-09-17)

This records how Kryon Protocol became a standalone repository at
`github.com/SamyaDeb/KryonProtocol`, and how it was separated from the
infrastructure of the previous deployment. Old hostnames and ids are described
here, never written out, so the `separation-guard` CI job stays meaningful.

## Decisions

| Question | Answer |
|---|---|
| Product name | Kryon Protocol |
| Domain | none yet; `<APP_DOMAIN>` placeholders everywhere |
| Git history | (b) the existing commits are kept and pushed as they are |
| Workspace | `~/code/kryonprotocol` (outside iCloud) |

The default branch was `master` in the old folder; it is `main` here.

## Moved to `~/Kryon-archive/` (mode 700, files 600)

- `kryon-full-history.bundle`: `git bundle --all` of the old folder, verified
- `REPO_SETUP_PROMPT.md`: the instructions for this setup
- `workspace/client/.vercel/`: Vercel project link
- `workspace/client/.env.local`, `workspace/client/.env.production.local`, `workspace/kryon-protocol/.env`
- `workspace/client/scripts/_loadtest_*_{keys,wallets,state,minted,report}.json`, `_loadtest_funded_wallets.json`, `_drill_wallets.json`, `_drill_state.json` (key material)
- `workspace/client/kryon-web.tar.gz`, `workspace/client/logs/`, `workspace/client/.wrangler/`
- `workspace/Audit Reports/`: audits of different code; not audits of this product
- `workspace/ARC_MIGRATION_PROMPT.md`, `workspace/docs/SETTLEMENT_AUTH.md`

`~/Kryon-legacy-secrets/` (from earlier work) was left where it is.

iCloud had evicted 357 files inside the old `.git` and the audit reports; they
were downloaded before bundling and moving.

## Deleted from the repository

- Legacy deploy records: `infra/deploy/environments/{mainnet,testnet}.toml`,
  `mainnet-deployment.json`, `testnet-deployment{-v2,-v3,-v4}.json`,
  `testnet-deployment.toml`, `manifest.example.toml`
- Legacy tooling: `infra/deploy/role-transfer.sh`, `infra/deploy/optimize-wasm.py`,
  `infra/budget/` (both files), `infra/rpc/stellar-rpc.md`, and the
  `budget:simulate` and `deploy:role-transfer` npm scripts
- Legacy runbooks: `mainnet-migration.md`, `governance-admin-transfer.md`
- `client/render.yaml`: a Render blueprint for the old services with old
  contract addresses (not in the original list; same risk as the Vercel link)
- Workflows: `deploy-production.yml`, `mainnet-preflight.yml`,
  `production-validation.yml` (rebuilt for Arc in Phase 5)
- The `production:gate` step in `ci.yml`: it validates the legacy network
  config (`@stellar/stellar-sdk` StrKey and `client/config`). The npm script
  itself is kept for the legacy code.
- `.mailmap`, `ARC_MIGRATION_PROMPT.md`, `docs/SETTLEMENT_AUTH.md` (archived)
- No `testnet*-markets.json` files were tracked.

## Moved within the repository

| From | To |
|---|---|
| `ARC_MIGRATION_PLAN.md` | `docs/engineering/PROTOCOL_PLAN.md` |
| `MIGRATION_PROGRESS.md` | `docs/engineering/BUILD_LOG.md` |
| `ARC_FIXES_PROMPT.md` (was untracked) | `docs/engineering/prompts/CONTRACT_FIXES_PROMPT.md` |
| `PRODUCTION_ROADMAP.md` (was untracked) | `docs/engineering/PRODUCTION_ROADMAP.md` |

Cross-references were updated (including comments in `Gas.t.sol`,
`Invariants.t.sol`, `FeeRouter.t.sol`, `docs/arc-facts.md` and `.gitignore`).
Narrative wording was made neutral ("legacy contracts", "legacy chain code");
technical content, file lists and the CI grep command in PROTOCOL_PLAN §11
were not changed.

## Replaced with placeholders

- `client/wrangler.jsonc`: worker name is now `kryonprotocol-web` (no account,
  zone or route ids were present)
- `infra/a1flex/cloudflared-config.yml`: `<TUNNEL_ID>`, `app.<APP_DOMAIN>`,
  `ws.<APP_DOMAIN>`, `ws-staging.<APP_DOMAIN>`, with a "Template" header
- `infra/a1flex/*.md`, `*.sh`: the old apex domain became `<APP_DOMAIN>`, the
  old VM address became `<OLD_HOST_IP>`, the old Cloudflare account id became
  `<CLOUDFLARE_ACCOUNT_ID>`, and the old Upstash endpoint became
  `<UPSTASH_REDIS_REST_URL>`. `setup-web-tier.sh`, `check-go-live.sh` and
  `seed-web-env.sh` now require `DOMAIN` / `DB_HOST` instead of defaulting to
  the old values; the registry nameserver lookup is derived from the TLD; old
  app URLs to retire come from `OLD_APP_URLS`.
- `infra/deploy/runbooks/{rollback,oracle-failure}.md`: the Vercel team scope
  became `<VERCEL_TEAM>`
- `infra/deploy/runbooks/incident.md`: hosting and DB provider links became
  `<HOSTING_PROVIDER>` / `<DB_PROVIDER>`; the contract liveness check uses `cast`
- `docs/docusaurus.config.ts`: `url: "https://docs.<APP_DOMAIN>"`, tagline
  "Perpetual futures on Arc"
- READMEs (root, `client/`, `kryon-protocol/`, `prisma/`, `infra/deploy/`):
  rewritten or edited to remove live claims, old links and provider-specific
  URLs. `ARCHITECTURE.md` now points to PROTOCOL_PLAN §3 (full rewrite deferred
  until the Arc services exist). `client/lib/sql.ts` driver routing unchanged.
- Env templates (`client/.env.{local,testnet,mainnet,production}.example`,
  `kryon-protocol/.env.example`): names only. Arc names are taken from
  `client/lib/chain/networks.ts` and `clients.ts`: `KRYON_NETWORK` (the code
  reads this, not `NEXT_PUBLIC_KRYON_NETWORK`), `ARC_RPC_URLS`,
  `KRYON_DEPLOYMENT_FILE`, `CONTRACT_*` (9), plus `DATABASE_URL`,
  `DIRECT_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_WS_URL`. No Arc service
  calls `serviceAccount(...)` yet, so no service key names exist to list; they
  are added as services are ported. Names still read by legacy code sit in a
  `# LEGACY (removed in Phase 3/4)` block.

## Kept on purpose

- Legacy chain code (`client/lib/stellar/**`, `@stellar/*`, `client/config/`,
  legacy service and deploy scripts, `railway-testnet-entrypoint.sh`), so the
  app keeps building.
- `kryon-protocol/railway.json`, Dockerfiles, PM2 configs: generic build/run
  config with no project ids or hosts.
- `infra/deploy/runbooks/mainnet-readiness.md` and `docs/docs/**`,
  `kryon-protocol/docs/architecture.md`: legacy-chain content, rewritten in a
  later phase.
- `docs/arc-facts.md` link to Chainlink's public reference-data directory.

## CI

`separation-guard` job added. It fails if any tracked file matches the old
app, docs and worker hosts, the old apex domain, Vercel project/team ids, the
old Vercel team slug, the old Cloudflare account id or the old VM address.
Literals in the pattern use character classes so the workflow does not match
itself. `client`, `reference-model`, `evm`, `prisma` and `security` jobs are
unchanged apart from the removed gate step.

## Verification (clean clone, 2026-09-17)

| Check | Result |
|---|---|
| Separation guard pattern, `git grep` | no matches |
| Tracked files named like secrets/keys/env/tarballs | only `*.example` and `client/lib/secrets-check.ts` |
| 64-hex constants | ERC-7201 storage slots only |
| Legacy-format secret seeds, PEM private keys | none |
| gitleaks | not installed (not installed without asking) |
| `arc-forge build --sizes` | ok, all contracts under 24 KB (Engine 21,865 B) |
| `arc-forge test` | 224 passed, 0 failed |
| `cargo test --workspace` | 19 passed, 0 failed |
| `script/storage-layout.sh --check` | storage layouts unchanged |
| Differential fuzz vs `kryon-ref` | 9 passed, 0 failed |
| `npm ci`, `npx tsc --noEmit` | ok |
| `npm test` | 74 pass, 1 skipped, 0 fail |
| `npm run lint` | 0 errors, 3 warnings (after fixing a pre-existing `no-this-alias` error in `lib/chain/tx-sender.test.ts`) |
| `npm run build` | ok, no env file present |

### History scan (history option b)

Every commit reachable from `main` was scanned. No private keys, seeds, PEM
blocks, provider API tokens, webhook URLs, database passwords or Vercel
project/team ids were found. Earlier commits do still contain, and will be
public: the old app/docs/worker hostnames and apex domain, the old VM address,
the old Cloudflare account id, the old Vercel team slug, the old Upstash
endpoint hostname (no token), public Vercel DNS addresses, and the legacy
deploy records and contract addresses. None of these is a credential. The
old Upstash token was never committed, but the old runbook says it was shared,
so that database should be rotated or retired.

## Placeholders still to fill

| Placeholder | Where |
|---|---|
| `<APP_DOMAIN>` | tunnel config, a1flex docs/scripts, docs site URL, env examples |
| `<TUNNEL_ID>`, `<CLOUDFLARE_ACCOUNT_ID>` | new tunnel in the Kryon Cloudflare account |
| `<DB_HOST_IP>`, `<OLD_HOST_IP>`, `DATABASE_URL`, `DIRECT_URL` | new Postgres |
| `<UPSTASH_REDIS_REST_URL>` + token | new rate-limit store |
| `ARC_RPC_URLS` | Arc RPC provider(s) |
| `<HOSTING_PROVIDER>`, `<DB_PROVIDER>`, `<VERCEL_TEAM>` | runbooks |
| `<SECURITY_CONTACT>` | root README |
| Service key variable names | env examples, as services are ported |

## Integration (2026-09-17)

### Why there were two copies

The repository setup above was done in a fresh workspace from commit
`43a7063`. Meanwhile the former local checkout kept going and gained 16 more
commits on its `master`: the contract review fixes FIX 1–9 (merge `18ed19d`),
the Arc Prisma baseline and `PgTxJobStore` (`b86dfbe`), the protocol indexer
(`da5f8db`, `49b79f2`) and regenerated ABIs (`380eb89`). Each copy had work the
other lacked.

### Merge

Those commits were fetched as `import/arc-work` and merged into
`integrate/arc-work` with `--no-ff` (merge commit `eeadae1`), keeping every
commit from both lines. Nothing published was rebased or squashed.

| Path | Result |
|---|---|
| `.gitignore` | Conflict. Union: the `docs/engineering/PROTOCOL_PLAN.md` reference from this repo, and the fuller `/lib/` comment from the fixes |
| `kryon-protocol/prisma/README.md` | Conflict. The Arc baseline README (databases per environment, conventions, migrations, tests), plus the placeholder connection-string setup step. No real hosts |
| `ARC_MIGRATION_PLAN.md` → `docs/engineering/PROTOCOL_PLAN.md`, `MIGRATION_PROGRESS.md` → `docs/engineering/BUILD_LOG.md` | Rename detected, merged cleanly. All 49 and 60 added lines are present; no root copies. One absolute path to the old checkout in BUILD_LOG was made neutral |
| `Gas.t.sol`, `Invariants.t.sol`, `FeeRouter.t.sol`, `client/lib/chain/tx-sender.test.ts` | Merged cleanly; the renamed doc references and the scoped `no-this-alias` disable are kept |
| `kryon-protocol/prisma/migrations/` | The four legacy migrations are deleted; only `20260917000000_arc_baseline` remains |
| Legacy deploy records, workflows, budget/rpc docs, `.mailmap`, `ARC_MIGRATION_PROMPT.md` | Stay deleted (the fixes line did not touch them) |
| `kryon-protocol/evm/src/**`, `script/**`, `storage-layout/**`, `client/lib/chain/**`, `client/lib/indexer/**` | Taken from the fixes line (no competing edits) |
| Env templates | Arc-only templates kept; added `INDEXER_START_BLOCK`, `INDEXER_POLL_MS`, `INDEXER_MAX_WINDOW` (local, testnet, mainnet) and `KRYON_TEST_DATABASE_URL` (local). Names only |

### Moved and archived

| What | Where |
|---|---|
| `git bundle --all` of the former checkout at `49b79f2` (verified) | `~/Kryon-archive/kryon-arc-downloads-49b79f2.bundle` |
| The now-stale Phase 1 hardening prompt (FIX 1–9 already applied) | `~/Kryon-archive/stale-prompts/` |
| Auditor RFQ email draft (private outreach) | `~/Kryon-archive/private/` |
| `PRODUCTION_ROADMAP.md` (newest status) | `docs/engineering/PRODUCTION_ROADMAP.md`, with Phase 0 corrected (§1.1 rows F and I, §2, Phase 0 status, §7) |
| `ARC_FIXES_PROMPT.md` | Not committed: it differs from `docs/engineering/prompts/CONTRACT_FIXES_PROMPT.md` only in pre-move paths. Two absolute paths in the committed prompt were made repo-relative |
| `REPO_SETUP_PROMPT.md` | Not committed: identical to the archived copy |

### Verification

Run on `integrate/arc-work` after the merge.

| Check | Result |
|---|---|
| Separation guard pattern (exact `ci.yml` PATTERN over tracked files) | no matches |
| Tracked files named like secrets/keys/env/tarballs | only `*.example` and `client/lib/secrets-check.ts` |
| PEM private keys, legacy-format secret seeds | none |
| New 64-hex constants from the merge | one ERC-7201 storage slot (`KryonUpgradeable.sol`) |
| gitleaks | not installed |
| `arc-forge build --sizes` | ok; largest runtime is Engine at 22,821 B (1,755 B margin) |
| `arc-forge test` | 258 passed, 0 failed, 0 skipped (was 224 before the merge) |
| `script/storage-layout.sh --check` | storage layouts unchanged |
| `cargo test --workspace --locked` | 19 passed |
| Differential fuzz vs `kryon-ref` | 9 passed (5,000 runs each) |
| Slither 0.11.6 (arc-forge build, High/Medium) | 0 results, 76 contracts |
| `npm ci`, `npx tsc --noEmit` | ok |
| `npm test` without a database | 81 tests: 80 pass, 1 skipped, 0 fail |
| `npm test` with `KRYON_TEST_DATABASE_URL` | 92 tests: 91 pass, 1 skipped, 0 fail. The database was a throwaway local Postgres 16 cluster (baseline SQL applied with `psql`, deleted afterwards). The skip is the arc-anvil EIP-712 parity test |
| `npm run lint` | 0 errors, 5 warnings |
| `npm run build` | ok |
| `prisma validate` (6.8.2) | valid |
| Coverage | not re-run |
