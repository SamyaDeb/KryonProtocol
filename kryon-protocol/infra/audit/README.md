# Kryon Protocol: audit package

This directory is the starting point for the external security review of the Kryon Protocol smart
contracts, a perpetual-futures DEX on Arc (Circle's EVM L1; mainnet chain ID 5042, testnet
5042002). USDC is both the collateral and the gas token.

| | |
|---|---|
| Tag | `audit-v1` (annotated) |
| Commit | the commit `audit-v1` points to (`git rev-parse audit-v1^{commit}`) |
| Freeze date | 2026-10-01 |
| In-scope code | `kryon-protocol/evm/src/**` (see [SCOPE.md](SCOPE.md)) |

After the tag, any change under `kryon-protocol/evm/src/**` ships with a re-audit diff
(`git diff audit-v1 -- kryon-protocol/evm/src`) and is tagged `audit-v1.N`.

## Documents

| File | Contents |
|---|---|
| [SCOPE.md](SCOPE.md) | In-scope files with nSLOC, optional and out-of-scope code |
| [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) | Contract roles, call graph, units, settlement, liquidation/backstop/ADL, funding, oracle |
| [INVARIANTS.md](INVARIANTS.md) | Protocol invariants and where each is tested |
| [TRUST_MODEL.md](TRUST_MODEL.md) | Every role, what it can and cannot do, upgrades, external dependencies |
| [KNOWN_ISSUES.md](KNOWN_ISSUES.md) | Accepted risks, documented deviations, open items not fixed |
| [RESULTS.md](RESULTS.md) | Tests, coverage, Slither, gas, nightly/differential/fork runs, storage layout |
| [CONFIG.md](CONFIG.md) | Approved mainnet parameters and how deployment verification enforces them |

Background design documents: `docs/engineering/PROTOCOL_PLAN.md` (§3 invariants, §4 contracts,
§4.4 liquidation/backstop/ADL, §5 fees, §7 oracle) and `docs/engineering/BUILD_LOG.md`
(implementation log, review fixes FIX 1–9, deviations).

## Toolchain

| Tool | Version |
|---|---|
| arc-foundry (`arc-forge`, `arc-anvil`) | v0.8.0-1 (forge 1.7.1-dev `f567f94`). Stock Foundry executes Ethereum rules; use `arc-forge` |
| solc | 0.8.30, via-IR, optimizer 200 runs, EVM target `prague`, `bytecode_hash = "none"` |
| OpenZeppelin Contracts / Contracts Upgradeable | v5.7.0 (submodules under `kryon-protocol/evm/lib/`) |
| forge-std | v1.9.7 |
| Rust (reference model `kryon-ref`) | 1.89.0 (pinned by `kryon-protocol/rust-toolchain.toml`) |
| Slither | 0.11.6 (`uvx --from slither-analyzer==0.11.6`) |

## Build and test

```bash
git clone --recurse-submodules https://github.com/SamyaDeb/KryonProtocol && cd KryonProtocol
git checkout audit-v1 && git submodule update --init --recursive
cd kryon-protocol/evm

arc-forge build --sizes                                                   # all contracts < 24,576 bytes
arc-forge test                                                            # unit + upgrade + invariant
(cd .. && cargo test --workspace)                                         # Rust reference model
(cd .. && cargo build -p kryon-ref --release) && FOUNDRY_PROFILE=differential arc-forge test
FOUNDRY_PROFILE=fork arc-forge test --network arc                         # read-only Arc testnet fork
FOUNDRY_PROFILE=gas arc-forge test -vv
FOUNDRY_PROFILE=nightly arc-forge test                                    # 1M fuzz runs, 2048x256 invariants (hours)
arc-forge coverage --ir-minimum --report summary --no-match-coverage "(^script/|^test/|^lib/)"
arc-forge build --build-info --skip "test/**" --skip "script/**" && \
  uvx --from slither-analyzer==0.11.6 slither . --foundry-out-directory out --ignore-compile \
  --filter-paths "lib/|test/|script/" --exclude-informational --exclude-low
./script/storage-layout.sh --check
```

The fork suite reads `ARC_TESTNET_RPC_URL` (default `https://rpc.testnet.arc.io`). The
differential and nightly profiles use `ffi` to call the `kryon-ref` binary.

## Repository map (in-scope and supporting code)

```
kryon-protocol/
├── evm/
│   ├── src/                       IN SCOPE
│   │   ├── Vault.sol              USDC custody, 1e18 internal ledger, deposit caps, withdrawals
│   │   ├── Engine.sol             positions, OI, mark TWAP, funding, account health
│   │   ├── OrderGateway.sol       EIP-712 orders, cancels, batched signed settlement
│   │   ├── OracleAdapter.sol      publisher quorum median, spread/jump guards, Chainlink reference
│   │   ├── Liquidation.sol        liquidation to the insurance backstop, ADL
│   │   ├── Insurance.sol          backstop fund, staking epochs, bad debt, ERC-1271 unwind
│   │   ├── RiskParams.sol         bounded per-market parameters
│   │   ├── FeeRouter.sol          fee schedule, tiers, split, referrals, claims
│   │   ├── governance/            KryonTimelock, KryonUpgradeable (UUPS base), Roles
│   │   ├── interfaces/IKryon.sol  internal interfaces
│   │   └── libraries/             KryonMath, Decimals, RiskLib, RiskCalc, FundingLib,
│   │                              LiquidationLib, OrderLib, Types, Errors
│   ├── script/                    OPTIONAL: DeployAll, 00–05, 99_VerifyDeployment, lib/
│   ├── test/                      unit, upgrade, invariant, differential, fork, gas
│   ├── storage-layout/            committed storage-layout snapshots (CI diff)
│   └── ffi/                       kryon-ref: Rust reference model binary for differential fuzzing
├── crates/                        protocol-core, risk-engine (Rust reference model)
└── infra/deploy/environments/     arc-mainnet.toml, arc-testnet.toml, arc-local.toml
```
