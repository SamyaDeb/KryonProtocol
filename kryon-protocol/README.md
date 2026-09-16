# Kryon Protocol

The Rust workspace behind Kryon: eight Soroban contracts and the pure crates
they share. Live on Stellar mainnet since 2026-07-07.

Everything off-chain — matcher, oracle keeper, indexer, WebSocket server,
reconciler, liquidation and TTL keepers — is TypeScript under `client/scripts/`
and supervised by PM2. This tree is on-chain logic only.

## Workspace

```text
crates/
  protocol-core/   Deterministic fixed-point math, types, oracle snapshots, accounting primitives
  risk-engine/     Pure Rust risk, margin, funding, liquidation planning

contracts/
  perp-governance/    Timelock proposal registry and guardian pause control
  perp-engine/        Position lifecycle, execution bands, fees, funding, realized PnL settlement
  perp-insurance/     Insurance fund custody, rewards, bad-debt accounting
  perp-liquidation/   Account-health liquidation executor
  perp-order-gateway/ Matched-order settlement, nonce tracking, cancellations
  perp-oracle-adapter/ Guarded normalized oracle snapshots for collateral and markets
  perp-risk/          Thin Soroban boundary around the pure risk engine
  perp-vault/         SEP-41 collateral custody with risk-gated withdrawals

infra/
  deploy/          Deployment manifests and upgrade governance runbooks
  monitoring/      Metrics, alerts, and incident hooks

prisma/
  schema.prisma    Postgres persistence schema for the off-chain runtime state

docs/
  architecture.md
  security-model.md
  legacy-issues-fixed.md
```

`protocol-core` and `risk-engine` are `#![no_std]` and dependency-light on
purpose: the accounting rules are testable without a chain, and the contracts
are a thin authorization and storage layer over them.

## Non-Negotiable Invariants

1. Withdrawals are validated against current account equity, not stored locked margin.
2. Liquidations are account-health based. Position-local liquidation is only valid for explicit isolated margin.
3. Funding is based on market imbalance or independently computed mark/index divergence, never oracle minus itself.
4. Oracle reads carry source, timestamp, confidence, and freshness bounds.
5. SLP/insurance accounting must reconcile to vault custody and known unsettled liabilities.
6. Upgrade authority is treated as protocol risk and must be controlled by governance delay plus emergency limits.

## Markets

`XLM-PERP` was the launch market, quoted and settled in `USDC` — a perpetual
futures market for XLM/USDC exposure, not a spot pair. Seven further markets
(BTC, ETH, SOL, XRP, ADA, BNB, TRX) are configured; `NEXT_PUBLIC_ACTIVE_MARKETS`
decides which are live on a given deployment.

## Build and test

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
cargo build --workspace --release --locked   # wasm32v1-none for deployment
```

The toolchain is pinned in `rust-toolchain.toml` and must match the version CI
installs. Release builds are `opt-level = "z"` with LTO and stripped symbols —
Soroban charges for bytecode size and rent, so the wasm is optimized further by
`infra/deploy/optimize-wasm.py` before upload.

## Deployment

`infra/deploy/` holds the environment manifests (`environments/*.toml`),
the recorded live deployments (`mainnet-deployment.json`,
`testnet-deployment-*.json`), and the runbooks for governance admin transfer,
rollback, incidents, and stuck settlement. Contract addresses that the frontend
and keepers read come from `client/config/networks.ts` — change those together
with the keeper environment, never one side alone.
