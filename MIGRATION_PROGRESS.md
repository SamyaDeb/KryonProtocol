# Arc migration progress

Source of truth: `ARC_MIGRATION_PLAN.md`. Working instructions: `ARC_MIGRATION_PROMPT.md`.

| Step | Status |
|---|---|
| 0. Setup (Appendix B, git init, arc-facts) | ✅ done, ⏸ awaiting go-ahead |
| 1. Contracts | not started, **blocked on `arc-forge` install** |
| 2. Chain layer + TxSender | not started |
| 3. Services | not started |
| 4. Database | not started |
| 5. Frontend + API + agent docs | not started |
| 6. Infra, CI, runbooks | not started |
| 7. Remove Stellar | not started |
| 8. Testnet readiness | not started |

---

## Step 0: Setup (2026-09-16)

### Done

- **Appendix B.** Appended explicit entries to the root `.gitignore` for the load-test and drill
  key/wallet/state JSONs, `client/kryon-web.tar.gz`, `client/logs/`, `.wrangler`, `.vercel`,
  `.dev.vars*`, `*secrets*.env`, keystores/PEM/key files, and the arc-foundry `out/`, `cache/`,
  and local/dry-run `broadcast/` outputs. Most of these were already covered by nested
  `.gitignore` files. The root entries make coverage independent of those files.
- **Legacy secret env files moved out of the working tree** (not deleted):
  `kryon-protocol/infra/deploy/{mainnet,testnet,testnet-v3}-secrets.env` →
  `~/Kryon-legacy-secrets/` (dir mode 700, files 600). They hold Stellar-era keys. Decide
  whether to keep, rotate, or destroy them.
- **`git init` + baseline commit** `f650754` (340 files).
  - Staged-file secret scan (Stellar `S…` seeds, 32-byte hex keys, PEM keys, credentialed
    Postgres URLs, AWS/GitHub/Stripe tokens) found only placeholders: `PASSWORD`, `<PW>`,
    `${DB_PASSWORD}`, and the CI throwaway `postgresql://ci:ci@localhost`.
  - `git check-ignore` confirmed that all of these are ignored: `_loadtest_*_keys.json`,
    `client/.env.local`, `kryon-protocol/.env`, `client/logs/*`, the tarball,
    `Audit Reports/`, and `client/.vercel/`. Tracked files matching key/wallet/secret/.env.local
    patterns: **0**.
  - Tracked files over 1 MB are images and video only (`client/public/images/dd.png` 2.0 MB and others).
- **`docs/arc-facts.md`** created. All [U] items were checked against docs.arc.io,
  developers.circle.com, provider docs, GitHub, and read-only calls to the public Arc RPCs.

### Deviations from the plan / new facts

1. **Chainlink Data Feeds are live on Arc mainnet.** The plan says none are published. There are
   30 feeds, including BTC, ETH, SOL, XRP, BNB, TRX and USDC. Prices were confirmed on-chain.
   The feeds have a 24h heartbeat and 0.5% deviation, so they suit a cross-check only. There are
   no ADA/XLM feeds and none on testnet. The cross-check stays disabled in config pending your approval.
2. **Mainnet WebSocket** is available from Alchemy, Blockdaemon and QuickNode (documented), but not from the public RPC.
3. **Safe v1.4.1** contracts are deployed canonically on both networks. Safe{Wallet} UI support
   is unconfirmed (Allowance Module reportedly missing), which affects the "ops refill Safe allowance" design.
4. The docs describe underpriced txs as "may remain pending indefinitely or fail outright", not
   "silently dropped". The docs state the 20 gwei floor for testnet. Mainnet gas price was about 28 gwei.
5. Testnet EURC, CCTP and Gateway addresses differ from mainnet, so they need per-network config.

### Blockers / actions for you

- **Install arc-foundry `v0.8.0-1`.** It isn't on this machine (only upstream `forge` is).
  The exact commands are in `docs/arc-facts.md` §5. Step 1 can't build or test without it.

### Open [U] items

See `docs/arc-facts.md` §6: the explorer API and verification, RPC archive/trace, blocklist
in-contract semantics, Safe{Wallet} support, Chainlink approval, RedStone/Chronicle, and the
mainnet gas floor wording.

### Open decisions (§15)

The prompt's defaults apply. These stay as placeholders: Safe signers and thresholds, RPC provider,
auditor(s), bug bounty, and compliance vendor and jurisdictions.
