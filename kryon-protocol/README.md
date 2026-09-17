# kryon-protocol

On-chain logic for Kryon, perpetual futures on Arc.

## Layout

```text
evm/                 Solidity contracts (arc-foundry)
  src/               Engine, Vault, OrderGateway, OracleAdapter, RiskParams,
                     Liquidation, Insurance, FeeRouter, governance/, libraries/
  test/              unit, invariant, upgrade, differential, fork, gas
  script/            deployment scripts 00–05, 99 verification, DeployAll
  ffi/               kryon-ref: Rust reference binary for differential fuzzing
  storage-layout/    committed storage layouts for upgrade checks
crates/
  protocol-core/     fixed-point math, types, accounting primitives (reference model)
  risk-engine/       margin, funding and liquidation planning (reference model)
prisma/              Postgres schema for off-chain runtime state
infra/deploy/        Arc environment manifests and runbooks
docs/                architecture and security model notes
```

The Rust crates are the reference model the Solidity suite is fuzzed against;
they are not deployed.

## Build and test

```bash
# Solidity
cd evm
arc-forge build --sizes
arc-forge test
(cd .. && cargo build -p kryon-ref --release --locked)
FOUNDRY_PROFILE=differential arc-forge test

# Rust reference model
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
```

The Rust toolchain is pinned in `rust-toolchain.toml` and must match CI.

## Invariants

1. Withdrawals are validated against current account equity, not stored locked margin.
2. Liquidations are account-health based.
3. Funding is based on market imbalance or independently computed mark/index divergence, never oracle minus itself.
4. Oracle reads carry source, timestamp, confidence, and freshness bounds.
5. Insurance accounting must reconcile to vault custody and known unsettled liabilities.
6. Upgrade authority is protocol risk and is controlled by governance delay plus emergency limits.

The full list, with the Solidity invariant tests, is in
[`docs/engineering/PROTOCOL_PLAN.md`](../docs/engineering/PROTOCOL_PLAN.md) §3.

## Deployment

See [`infra/deploy/README.md`](infra/deploy/README.md).
