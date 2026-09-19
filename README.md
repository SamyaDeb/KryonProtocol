# Kryon Protocol

[![ci](https://github.com/SamyaDeb/KryonProtocol/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SamyaDeb/KryonProtocol/actions/workflows/ci.yml)
[![codeql](https://github.com/SamyaDeb/KryonProtocol/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/SamyaDeb/KryonProtocol/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/SamyaDeb/KryonProtocol/badge)](https://scorecard.dev/viewer/?uri=github.com/SamyaDeb/KryonProtocol)
[![latest release](https://img.shields.io/github/v/release/SamyaDeb/KryonProtocol?display_name=tag&sort=semver)](https://github.com/SamyaDeb/KryonProtocol/releases)

Kryon is a perpetual-futures exchange on **Arc**, Circle's EVM layer 1. Orders
are matched off-chain by price and time; custody, margin, funding,
liquidation, fees and settlement are enforced by Solidity contracts, with USDC
as both collateral and gas.

## Status

Pre-launch. The contracts are complete and under hardening; the off-chain
services and the web app are being built on Arc. Nothing is deployed to Arc
mainnet, and there is no public app yet.

## Repository layout

```text
kryon-protocol/
  evm/            Solidity contracts, tests and deploy scripts (arc-foundry)
  crates/         Rust reference model the contracts are fuzzed against
  prisma/         Postgres schema for off-chain state
  infra/          Arc deploy manifests, runbooks, monitoring, host templates
client/           Next.js app, API routes and off-chain services (matcher,
                  indexer, keepers, WebSocket server)
docs/             Docusaurus documentation site and Arc platform facts
docs/engineering/ Protocol plan, build log and production roadmap
```

Some client code still targets the legacy chain (`client/lib/stellar/**`); it
is being replaced by `client/lib/chain/**` and is not a deployment target.

## Build and test

Requirements: [arc-foundry](https://github.com/circlefin/arc-foundry)
(`arc-forge`), Rust 1.89 (pinned in `kryon-protocol/rust-toolchain.toml`),
Node.js (version in `.nvmrc`).

```bash
git clone --recurse-submodules https://github.com/SamyaDeb/KryonProtocol.git
cd KryonProtocol

# Contracts
cd kryon-protocol/evm
arc-forge build --sizes
arc-forge test

# Rust reference model
cd .. && cargo test --workspace --locked

# App and services
cd ../client
npm ci
npx tsc --noEmit
npm test
npm run build
```

Copy `client/.env.local.example` to `client/.env.local` for local runs. Never
commit filled-in env files.

## Documentation

- [Protocol plan](docs/engineering/PROTOCOL_PLAN.md): architecture, contracts, fees, oracle, launch gates
- [Build log](docs/engineering/BUILD_LOG.md): what is built, test results, deviations
- [Production roadmap](docs/engineering/PRODUCTION_ROADMAP.md): remaining work to mainnet
- [Arc platform facts](docs/arc-facts.md)
- [Deployment](kryon-protocol/infra/deploy/README.md)

## Security

Please report vulnerabilities privately to `<SECURITY_CONTACT>`. Do not open
public issues for security reports.
