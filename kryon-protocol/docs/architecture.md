# Stellar-Native Architecture

## Why The Legacy Architecture Was Rejected

The legacy implementation split perp, risk, funding, vault, CLOB, and SLP into
separate contracts, but allowed critical invariants to cross module boundaries
without an atomic source of truth. Examples:

- withdrawals checked stored locked margin instead of current equity
- funding compared oracle mark to oracle index and therefore did not move
- liquidations operated on one position while account health was cross-margin
- CLOB settlement accepted midpoint fills without oracle-band enforcement
- SLP NAV could diverge from custody

Those are not patch-level issues. They are solvency model failures.

## New Boundaries

```text
crates/protocol-core
  deterministic math, account snapshots, oracle snapshots, market config,
  position types, collateral accounting

crates/risk-engine
  pure no-IO calculations: account health, withdrawal validation,
  liquidation planning, funding index update

contracts/perp-risk
  thin Soroban boundary that stores market snapshots and delegates all
  calculations to risk-engine

contracts/perp-oracle-adapter
  guarded price adapter. Authorized publishers write either a single-source
  normalized snapshot or a quorum snapshot. All writes reject replayed publish
  times. Quorum writes require unique source publishers, an odd quorum of at
  least three sources, medianize provider prices, reject wide source deviation,
  and validate source publish time plus write time before storage.

contracts/perp-vault
  SEP-41 collateral custody. Deposits transfer real Stellar assets into the
  contract, balances are tracked internally, and withdrawals are blocked unless
  account health remains above initial margin using engine-synced positions.

contracts/perp-engine
  position lifecycle and settlement boundary. It opens, increases, reduces, and
  closes normal positions only through the configured order gateway and inside
  configured oracle execution bands, tracks open interest by side, updates
  funding indexes from market imbalance, realizes funding before position
  mutation, charges maker/taker fees through an authorized collector, rechecks
  post-fee initial margin before crediting protocol fees, realizes PnL into the
  vault, and syncs the vault's protocol-owned position snapshot.

contracts/perp-insurance
  backstop collateral custody. It accepts funded deposits, pays capped
  liquidation rewards through the authorized liquidation contract, and records
  explicit bad debt instead of hiding insolvency inside vault math.

contracts/perp-liquidation
  account-health liquidation executor. It rejects healthy accounts, calls the
  engine's authorized force-reduce path, verifies that liquidation reduces risk,
  pays capped rewards from insurance, and records negative-equity bad debt.

contracts/perp-order-gateway
  matched-fill settlement boundary. Off-chain matchers submit maker/taker order
  intents, while the contract enforces auth, expiry, cancellation, nonce fill
  accounting, side/price validity, self-trade prevention, and settlement through
  the engine. Maker/taker fees are charged by calling the engine after fill
  validation, so the matcher cannot bypass fee accounting.

contracts/perp-governance
  Stellar-native governance control plane. It queues proposal metadata with a
  minimum execution delay, records target/action/wasm hash, supports
  cancellation, and exposes a guardian emergency pause registry. The contract
  deliberately records and gates governance intent; production deployment
  scripts execute target-specific admin calls only after the timelock matures.

```

Everything off-chain lives in `client/scripts/` as TypeScript under PM2: the
matcher, oracle keeper, state indexer, WebSocket server, settlement reconciler,
and the liquidation and TTL keepers. The workspace deliberately carries no Rust
counterparts for them — a second implementation of the matching or keeper logic
is a second thing to keep correct, and only one of them would ever run.

The rule is deliberate: protocol-critical math is pure Rust first, with Soroban
contracts acting as explicit authentication and storage boundaries.

## Soroban-Native Design Principles

- Use Stellar account authorization directly through `Address::require_auth`.
- Keep hot storage keyed and bounded; avoid market-wide scans in contract paths.
- Prefer pure calculation crates that can be fuzzed outside the host.
- Treat transaction simulation as a first-class preflight, not a security layer.
- Use Stellar assets through SEP-41 token contracts and reconcile internal
  accounting against actual token custody.
- Minimize cross-contract call depth on liquidation and withdrawal paths.

## What ships

Eight Soroban contracts (vault, engine, order gateway, oracle adapter,
liquidation, insurance, risk, governance) over two pure crates
(`protocol-core`, `risk-engine`), plus the Prisma/Postgres schema for the
off-chain runtime state and the deployment manifests and runbooks under
`infra/`.
