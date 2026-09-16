# Mainnet Readiness Runbook

## Required Gates

- All contracts built with `cargo build --workspace --release`.
- `cargo test --workspace` passes.
- `cargo clippy --workspace --all-targets -- -D warnings` passes.
- Wasm hashes match `infra/deploy/manifest.example.toml`.
- Governance admin is a multisig, not an individual hot key.
- Guardian key is separate from governance admin.
- Oracle quorum publishers are independent operators.
- Keeper dry run shows no missed funding or liquidation jobs.
- Monitoring canary confirms stale oracle and bad debt alerts fire.
- External audit issues are either fixed or explicitly accepted by governance.

## Launch Sequence

1. Build and shrink contract Wasm, then upload the optimized artifacts:

   ```sh
   cargo build --release --target wasm32v1-none \
     -p perp-vault -p perp-engine -p perp-order-gateway -p perp-risk \
     -p perp-oracle-adapter -p perp-insurance -p perp-liquidation -p perp-governance
   python3 infra/deploy/optimize-wasm.py --all \
     target/wasm32v1-none/release target/wasm32v1-none/release/deploy
   ```

   Upload fees are rent-dominated, and rent is charged on the parsed
   module: code/data sections cost ~1.7 XLM per KB while custom sections
   (the ABI spec) are nearly free (~0.07 XLM/KB) — so shrink code, and do
   NOT strip the contract spec (loses on-chain ABI discovery to save
   ~0.3 XLM per contract; the pipeline's `--strip-spec` flag exists but is
   not worth it). The pipeline (deep wasm-opt + spec doc-string stripping,
   interface preserved) plus the `#[inline(never)]` on
   `protocol_core::fixed::mul_div` saves ~65 XLM versus plain
   `stellar contract optimize` at current mainnet rates (simulated
   2026-07-05: 304.2 XLM total for all eight contracts).
   Record the sha256 of each `deploy/*.wasm` in the deployment manifest —
   these, not the raw builds, are the canonical mainnet artifacts.
2. Deploy governance.
3. Deploy oracle, vault, engine, insurance, liquidation, gateway, and risk contracts.
4. Initialize contracts with the approved deployment signer, nominate governance as pending admin on every contract, and accept admin from the governance-controlled signer before enabling markets.
5. Wire contract addresses.
6. Configure collateral, markets, oracle publishers, fee recipient, and funding config.
7. Transfer operational authority to governance.
8. Queue first governance no-op proposal to validate timelock operation.
9. Start indexer in replay-only mode.
10. Start oracle, funding, and liquidation keepers with transaction submission disabled.
11. Enable transaction submission after simulated state matches RPC state.

## Abort Conditions

- Any stale oracle alert during launch.
- Any account health mismatch between indexer and contract state.
- Any failed settlement transaction outside expected duplicate/replay protection.
- Any bad debt before public launch.
- Any contract footprint regression above the approved budget.
