You are taking over the full migration of **Kryon**, a perpetual-futures DEX, to **Arc** (Circle's EVM L1, chain ID 5042 on mainnet and 5042002 on testnet; USDC is the gas token). The finished product must run **entirely on Arc**, with no Stellar code, dependencies or references left.

The repository is at `/Users/samya/Desktop/Kryon`. The complete plan is in **`ARC_MIGRATION_PLAN.md`** at the repo root. That file is the source of truth. Read all of it before doing anything else, then read the files it names before changing them.

---

## 1. What the repo contains today

- `kryon-protocol/contracts/`: 8 Soroban (Rust) contracts: vault, engine, order-gateway, oracle-adapter, liquidation, insurance, risk, governance. They are the **behavioural spec** for the Solidity port: read their logic and tests carefully, then delete them at the end.
- `kryon-protocol/crates/`: `protocol-core` (1e18 fixed-point math) and `risk-engine` (margin, funding, liquidation). **Keep these.** They are the reference model for differential fuzzing.
- `kryon-protocol/prisma/`: the Postgres schema.
- `kryon-protocol/infra/`: deploy manifests, runbooks, OCI A1.Flex host scripts, monitoring.
- `client/`: a Next.js 16 / React 19 app with `/api` routes, 81 scripts (including 7 always-on PM2 services: matcher, oracle keeper, indexer, WS server, reconciler, liquidation keeper, monitor; plus a funding keeper), and `client/lib/stellar/*`.
- `client/lib/market/matcher.ts`: the price-time CLOB. It does not depend on any chain. **Keep its logic.**
- `docs/`: Docusaurus. `.github/workflows/`: CI.
- There is **no git repository** (`.git` was deleted on purpose).

## 2. Goal

Carry out Phases A–H of `ARC_MIGRATION_PLAN.md` so that:

1. `kryon-protocol/evm/` holds a complete, tested, audit-ready Solidity suite: Vault, Engine, OrderGateway, OracleAdapter, Liquidation, Insurance, RiskParams, **FeeRouter**, and timelock/roles. It uses UUPS proxies, and admin passes to the timelock inside the deploy scripts.
2. **Trading fees are live and enforced on-chain** from the first fill, as specified in §5 of the plan: maker/taker bps, hard caps, a net-fee floor, a treasury/insurance/referral split, claims, tiers, and `minFillNotional`. Fees are shown correctly in the UI and recorded exactly in the database.
3. Every off-chain service, API route and UI flow runs on viem, wagmi and EIP-712 against Arc.
4. The Prisma schema is the Arc baseline described in §9.
5. Infra, CI, docs and runbooks describe Arc only.
6. All Stellar, Soroban, Freighter and XLM-collateral code, dependencies and docs are removed (§11 and Appendix A).
7. Everything is ready for an Arc **testnet** deployment, with scripts, config and a checklist prepared.

## 3. Hard rules

- **Never deploy to Arc mainnet, create or fund mainnet keys, move funds, or send any mainnet transaction.** Prepare scripts and a checklist, then stop and ask me.
- **Arc testnet deploys also need my go-ahead and a funded key from me.** Never generate keys and write them into the repo.
- **No secrets in files that will be committed.** Use `.env` files that are gitignored, and do Appendix B first.
- **Use `arc-foundry`** (`arc-forge`, `arc-cast`, `arc-anvil`), not upstream Foundry, for build, test, fork and deploy, and pin its version. If it isn't installed, tell me the install command. Don't substitute upstream Foundry for Arc-semantics tests.
- **Verify every [U] item** in the plan against primary sources (docs.arc.io, developers.circle.com, provider docs) before relying on it. Record what you found in `docs/arc-facts.md` with links. Never invent addresses, feed IDs or RPC URLs. If a fact can't be confirmed, make it a config value and list it as open.
- **Protocol invariants from §3 of the plan are non-negotiable.** Every monetary operation uses checked math and the single `Decimals` boundary (1e6 USDC ↔ 1e18 internal; credits round down, debits round up).
- Don't change the matching logic in `lib/market/matcher.ts` beyond what the plan requires.
- Match the existing code style and comment density. Don't add features beyond the plan.
- Report results honestly. If a test fails or a step is skipped, say so with the output.

## 4. Defaults for the open decisions (§15 of the plan)

Use these unless I say otherwise. Every value must be **configurable** (a deploy config or a timelock setter), never hardcoded logic.

| Decision | Default |
|---|---|
| Fees | taker 3.5 bps, maker 0.5 bps. Caps: taker ≤ 25 bps, maker −2…25 bps. Net floor ≥ 1 bps. Rebates supported but off (maker ≥ 0) |
| Fee split | 70% treasury / 20% insurance / 10% referral (accrues to treasury until referrals are enabled) |
| `minFillNotional` | $20 |
| Upgradeability | UUPS behind OZ `TimelockController`, 48h delay. Safe as proposer. Guardian holds `PAUSER_ROLE` only. Unpause goes through the timelock |
| Collateral | USDC `0x3600000000000000000000000000000000000000` (ERC-20 interface, 6 decimals) only. Keep the `setCollateral` interface |
| Launch markets | BTC-PERP, ETH-PERP enabled. SOL, XRP, ADA, BNB, TRX, XLM configured but inactive |
| Oracle | pushed CEX median (Binance/Coinbase/Kraken, at least 2 sources, USDC de-peg guard). Push on a ≥5 bps move or a 5s heartbeat. On-chain `maxAge` 15s. External cross-check behind an interface, disabled until feeds are confirmed |
| Wallet | wagmi + viem + RainbowKit |
| Database | fresh baseline migration. Network ids `arc-mainnet` and `arc-testnet` |
| Hosting | keep OCI A1.Flex + PM2 + Cloudflare Tunnel |
| Guarded launch | total deposit cap $250k, $10k per account, low OI caps |

Safe signers and thresholds, the RPC provider, the auditor and compliance vendors stay as placeholders in config and docs.

## 5. Order of work

Keep `MIGRATION_PROGRESS.md` at the repo root updated after every step: what's done, test results, deviations from the plan, open questions. At each ⏸ checkpoint, stop and give me a short summary before continuing.

**Step 0: Setup**
- Do Appendix B first: extend `.gitignore` to cover the key JSONs, logs, tarballs, `.wrangler`, `.vercel` and secrets.
- `git init`, then make a baseline commit of the current state (after confirming no secrets are staged: show me `git status` and flag anything suspicious).
- Create `docs/arc-facts.md` and verify the [U] items.
- ⏸

**Step 1: Contracts (Phase A + fee contracts from Phase B)**
- Scaffold `kryon-protocol/evm/` exactly as §4.1 lays it out.
- Port the math into Solidity libraries. Build the differential fuzz harness (`ffi` calling a small Rust binary built on `risk-engine` / `protocol-core`).
- Implement all contracts per §4.2 and §5.1–5.4. That includes batched `settleFillsSigned` with per-fill isolation and `FillRejected`; EIP-712 `Order`/`Cancel` with ERC-1271 support; `cancelUpTo`; bounded setters; complete events; and ERC-7201 storage.
- Port **every** existing Soroban test scenario, and add the fee tests (§5.8), the invariant tests (§3 invariants 1–6) and the Arc-semantics fork tests (G4).
- Write deploy scripts `00`–`05` and `99_VerifyDeployment` (it fails if any EOA holds an admin role, if wiring is wrong, or if fees or risk params differ from the config).
- Acceptance: `arc-forge build --sizes` passes (every contract under 24KB), all tests pass, coverage ≥95% lines / ≥90% branches, Slither is clean of High/Medium (or each finding is justified), and storage-layout snapshots are committed.
- ⏸

**Step 2: Chain layer + TxSender (Phase C §6.1–6.2)**
- Create `client/lib/chain/*`, with ABIs generated by `@wagmi/cli` from `evm/out`.
- Build `lib/market/eip712.ts` and a parity test showing `hashTypedData` equals the contract's `hashOrder`.
- Build `tx-sender.ts` with nonce management, the 20 gwei floor, dropped-transaction detection and replacement, and TxJob persistence. Unit-test it.

**Step 3: Services (§6.3–6.4, §7)**
- Port the matcher, oracle keeper, indexer, reconciler, liquidation keeper, funding keeper, monitor, stats aggregator, keeper refill and WS server. Delete the TTL keeper.
- Fees in `Fill` must come from `FillSettled` receipts. Remove the placeholder tx hash and `ledger = 0`.
- Acceptance: an end-to-end run against a local `arc-anvil` with the contracts deployed. Two wallets deposit, trade (partial fills), pay fees, see funding, one gets liquidated, and the fee bucket is claimed. The invariant check in the monitor passes.
- ⏸

**Step 4: Database (Phase F)**
- New Prisma baseline per §9, including `FeeAccrual`, `FeeClaim`, `FeeTierAssignment` and `GasSpend`, lowercase-address CHECK constraints, and `(network, txHash, logIndex)` idempotency.
- Update every SQL query that touches changed columns.

**Step 5: Frontend + API + agent docs (Phase E, §5.7)**
- wagmi/RainbowKit wallet, wrong-chain handling, `signTypedData` orders and cancels, permit + deposit, withdraw, and a single USDC balance with a gas-buffer warning.
- Fee schedule and tier come from `/api/fees`, and the estimated fee shows before signing.
- `/api/eip712`, 1e6 amount precision, Arc explorer links, and `networks.ts` with `NEXT_PUBLIC_KRYON_NETWORK` (keep the literal `process.env.X` rule).
- Delete `SettlementModal` and `/api/settlements`.
- Rewrite `docs/docs/agents/*`.
- Acceptance: `npm run build`, `npm run lint` and `npm test` pass. Then use the run skill (or a browser) to walk the full trade flow on local anvil.
- ⏸

**Step 6: Infra, CI, runbooks (Phase G)**
- Update the PM2 configs, Dockerfiles, compose, render and wrangler files, and the `infra/a1flex` env seeding.
- Write `infra/rpc/arc-rpc.md`, the Arc deployment environment TOMLs and the deployment JSON template.
- Write every runbook listed in §10.4, and the workflows in §10.5 (including `mainnet-preflight` assertions and `invariants-nightly`).

**Step 7: Remove Stellar (Phase H)**
- Delete everything in the Appendix A "Delete" list, `kryon-protocol/contracts/**`, `client/lib/stellar/**`, and the `@stellar/*` dependencies.
- Rewrite `README.md`, `ARCHITECTURE.md`, `client/README.md`, `client/CLAUDE.md`, `client/AGENTS.md` and `docs/docs/**` for Arc.
- Add a CI grep guard for `stellar|soroban|freighter|sep-53|stroop`.
- Acceptance: that grep returns nothing (outside the allowed exceptions in §11), and the full build and all tests are green.
- ⏸

**Step 8: Testnet readiness**
- Write `infra/deploy/runbooks/arc-testnet-deploy.md`: the exact commands, the env vars I must provide, the funding amounts per key, and the verification steps (explorer source verification, `99_VerifyDeployment`, drills G5/G6).
- Port the drill and load scripts to viem.
- **Stop and ask me before deploying.**

## 6. Definition of done

- Every acceptance check above passes, with the output shown.
- `MIGRATION_PROGRESS.md` lists what was built, the test and coverage numbers, deviations from the plan with reasons, the remaining [U] items, and the open decisions from §15.
- The repo contains no Stellar code, no secrets, and no mainnet actions taken.
- Commits are small and grouped by phase, with clear messages.

Start now by reading `ARC_MIGRATION_PLAN.md` in full, then Step 0.
