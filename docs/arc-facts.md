# Arc facts register

Verification log for the **[U]** items in `ARC_MIGRATION_PLAN.md` (and the [V] items the
code depends on directly). Checked **2026-09-16**, Arc mainnet launch day.

Status legend:

- **Verified**: confirmed from a primary source, on-chain, or both.
- **Partial**: some of it is confirmed. The rest stays a config value.
- **Open**: not confirmed. The value is config-only and must not be hardcoded.

Anything Open is a config value in `infra/deploy/environments/arc-*.toml` and must be
re-checked before the phase that depends on it.

---

## 1. Network

| Item | Finding | Status | Source |
|---|---|---|---|
| Chain IDs | Mainnet `5042`, testnet `5042002`. `eth_chainId` on the public RPCs returned `0x13b2` and `0x4cef52` | Verified (docs + RPC) | [Connect to Arc][connect] |
| Public HTTP RPC | `https://rpc.mainnet.arc.io`, `https://rpc.testnet.arc.io` | Verified | [Connect to Arc][connect] |
| Public WebSocket | Testnet: `wss://rpc.testnet.arc.io`. **No public mainnet WSS** | Verified | [Connect to Arc][connect] |
| Provider mainnet HTTP | Alchemy `https://arc-mainnet.g.alchemy.com/v2/<KEY>`, `https://rpc.blockdaemon.mainnet.arc.io`, `https://rpc.drpc.mainnet.arc.io`, `https://rpc.quicknode.mainnet.arc.io` | Verified (URLs listed in docs; access and pricing not checked) | [Connect to Arc][connect] |
| Provider mainnet WSS | Alchemy `wss://arc-mainnet.g.alchemy.com/v2/<KEY>`, Blockdaemon `wss://rpc.blockdaemon.mainnet.arc.io/websocket`, QuickNode `wss://rpc.quicknode.mainnet.arc.io`. **dRPC mainnet WSS is not listed** | Verified | [Connect to Arc][connect] |
| Provider testnet WSS | Blockdaemon `wss://rpc.blockdaemon.testnet.arc.io:443/websocket`, dRPC `wss://rpc.drpc.testnet.arc.io`, QuickNode `wss://rpc.quicknode.testnet.arc.io` | Verified | [Connect to Arc][connect] |
| Archive / trace / debug support per provider | Not documented by Arc | **Open**: ask the chosen provider before indexer backfill design | [Node providers][nodes] |
| Explorer | `https://explorer.arc.io`, `https://explorer.testnet.arc.io` | Verified | [Connect to Arc][connect] |
| Explorer API (testnet) | Etherscan-V1-style `GET /api?module=…&action=…` works (`eth_block_number` returned a result) | Verified (live call) | explorer.testnet.arc.io |
| Explorer API (mainnet) | viem's `arc` chain declares `apiUrl: https://explorer.arc.io/api/v2` (Blockscout v2). Plain `curl` hits a Cloudflare challenge, so V1 compatibility and `forge verify` support are untested | **Open**: test `arc-forge verify-contract --verifier blockscout` on testnet first | [viem arc.ts][viem-arc], [arc-node #396][arcscan] |
| Testnet faucet | `https://faucet.circle.com` | Verified | [Connect to Arc][connect] |
| Native currency | USDC, 18 decimals (native interface) | Verified | [Connect to Arc][connect] |
| viem / wagmi chains | `viem@2.56.5` exports `arc` and `arcTestnet`. `arc` includes Multicall3 at `0xcA11…CA11` | Verified | [viem chains][viem-arc] |

## 2. Gas

| Item | Finding | Status | Source |
|---|---|---|---|
| Base-fee floor / ceiling | 20 gwei min, 20,000 gwei max, EWMA-smoothed. The page states the 20 gwei floor "on testnet" | Partial: mainnet `eth_gasPrice` returned `0x69a4239d3` (≈28.35 gwei) at check time, consistent with a ≥20 floor. **Keep the floor as config** (`GAS_MIN_BASE_FEE_GWEI=20`) | [Gas and fees][gas] |
| Tip | 0 accepted. 1 gwei suggested under load | Verified | [Gas and fees][gas] |
| Underpriced txs | "may remain pending indefinitely or fail outright" (the plan said "silently dropped"). TxSender drop detection covers both | Verified (wording differs) | [Gas and fees][gas] |
| Block time / gas limit | 0.5s / 30M. The block gas limit can't be overridden in arc-foundry | Verified | [Gas and fees][gas], [arc-foundry][arcfoundry] |

## 3. EVM semantics

| Item | Finding | Status | Source |
|---|---|---|---|
| USDC dual interface | Native 18 dp and ERC-20 6 dp share one balance. Don't credit at 6 dp from native values (truncation) | Verified | [EVM differences][evm] |
| Blocklist | "Enforced at runtime. A value transfer to or from a blocklisted address reverts." Gas is still consumed | Verified | [EVM differences][evm] |
| Blocklist controller / in-contract semantics | Arc doesn't document who controls the list or how it applies to internal ERC-20 `transferFrom` inside our contracts | **Open**: G4 fork test must exercise it. Per-fill isolation assumes a revert | [EVM differences][evm] |
| Timestamps | Non-decreasing, 1 s granularity. Several blocks may share a timestamp | Verified. Funding must tolerate `dt == 0` | [EVM differences][evm] |
| PREVRANDAO | Always 0 | Verified | [EVM differences][evm] |
| Blob txs | Type-3 rejected. `BLOBHASH` = 0, `BLOBBASEFEE` = 1 | Verified | [EVM differences][evm] |
| Zero-address value transfer | Reverts ("Zero address not allowed"). Zero-value succeeds | Verified | [EVM differences][evm] |
| SELFDESTRUCT | Moves USDC out. Non-zero call to a destroyed account reverts. Emits EIP-7708 Transfer log | Verified | [EVM differences][evm] |

## 4. Contract addresses

### 4.1 Arc system / ecosystem (docs)

| Contract | Mainnet | Testnet |
|---|---|---|
| USDC | `0x3600000000000000000000000000000000000000` | `0x3600000000000000000000000000000000000000` |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| CCTP TokenMessengerV2 (domain 26) | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| CCTP MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| CCTP TokenMinterV2 | `0xfd78EE919681417d192449715b2594ab58f5D002` | `0xb43db544E2c27092c107639Ad201b3dEfAbcF192` |
| Gateway Wallet | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Gateway Minter | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | same |
| CREATE2 factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | same |

Status: **Verified** from [Contract addresses][addrs]. CCTP V2 support for Arc (domain 26,
mainnet + testnet) is confirmed separately in [Circle CCTP supported chains][cctp].

The plan's §2.4 addresses match the docs. Testnet addresses differ for EURC, CCTP and Gateway,
so they must live in per-network config.

### 4.2 Safe (was [U])

`safe-global/safe-deployments` lists chain `5042` and `5042002` as **canonical** for v1.4.1.
`eth_getCode` on both networks returned non-empty code at:

| Contract (v1.4.1 canonical) | Address | Mainnet code | Testnet code |
|---|---|---|---|
| SafeL2 | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | 24,421 bytes | 24,421 bytes |
| SafeProxyFactory | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | 3,054 bytes | 3,054 bytes |
| CompatibilityFallbackHandler | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | 5,637 bytes | 5,637 bytes |
| MultiSendCallOnly | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | 410 bytes | 410 bytes |

The Safe singleton factory repo has an artifact for chain `5042`.

Status: **Partial**. The contracts are deployed. **Safe{Wallet} UI / Transaction Service support
on Arc is unconfirmed**: a third-party PR reports that the Allowance Module is missing, which
blocks official Safe{Wallet} listing. That matters for the ops-refill "Safe allowance" in §10.3.
The code hash was not compared byte-for-byte against the canonical build.
Sources: [safe-deployments][safe], [keeperhub PR (secondary)][safe-2nd].

### 4.3 Oracles (was [U])

| Provider | Arc mainnet | Arc testnet | Source |
|---|---|---|---|
| **Chainlink Data Feeds** | **Live.** The `arc-mainnet` list in Chainlink's feed directory has 30 feeds (below). `latestRoundData` read on-chain returned sane prices for BTC, ETH, USDC, SOL and XRP. **Heartbeat 24h, deviation 0.5%** | Not in the directory under the names tried | [feeds-arc-mainnet.json][cl-dir] |
| Pyth | Not listed | Listed ("Arc Network Testnet") | [Pyth EVM addresses][pyth] |
| Stork | Not listed | `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62` | [Stork EVM addresses][stork] |
| RedStone | Not confirmed | Not confirmed | [Arc oracles][oracles] |
| Chronicle | Not confirmed | Not confirmed | [Arc oracles][oracles] |

Chainlink Arc mainnet proxies relevant to Kryon markets (decimals 8, heartbeat 86400s, deviation 0.5%):

| Feed | Proxy |
|---|---|
| BTC / USD | `0xa109B535C70C8Be9995be64Bb6751AcDB27e03De` |
| ETH / USD | `0x50FCDD99D6762D1C170DC6A9111db944AEE6D364` |
| SOL / USD | `0x2d04D354f5fDaE3De723df475745B0a9B4edf90C` |
| XRP / USD | `0xFFb04Fba8384e0a53Ee9975F9164905030F5ea29` |
| BNB / USD | `0x00d1516C06e030Ef2142478ce14CEbce2De81771` |
| TRX / USD | `0x5693D678943AE1FDfCECFf98B6c677FbAf331AE9` |
| USDC / USD | `0x84EA90AC252Dc437031461836DB5164219147905` |
| ADA / USD, XLM / USD | **not published** |

Implications:

- The plan's claim that "no mainnet feed addresses are published" is out of date. The rest of the
  oracle design still holds: at a 24h heartbeat and 0.5% deviation these feeds can be up to
  0.5% stale, which is far too slow for a perp mark. They are usable only as a **divergence
  cross-check** whose tolerance is wider than 0.5% or keyed on `updatedAt`.
- Per the default decision, the external cross-check stays **disabled** in config until you
  approve these addresses. The docs.chain.link addresses page (>10 MB) could not be fetched for
  a second confirmation. The directory JSON is the dataset that page renders.
- **No Arc testnet Chainlink feeds were found**, so a cross-check test on testnet needs Stork,
  Pyth, or a mock.

## 5. Toolchain

| Item | Finding | Status | Source |
|---|---|---|---|
| arc-foundry | Latest release **`v0.8.0-1`** (2026-09-08). Assets include `arc-foundry-v0.8.0-1-aarch64-apple-darwin.tar.gz` + `.sha256`. Binaries ship as `forge`/`cast`/`anvil` and are renamed to `arc-*` on install. Chisel is unsupported. Hardforks `arc:zero6/7/8`. Auto-selects Arc when forking | Verified | [arc-foundry][arcfoundry], [releases][arcfoundry-rel] |
| Explorer verification via arc-forge | Not documented | **Open** | – |
| Local install | **Not installed** on this machine (`arc-forge not found`). Upstream `forge` exists at `~/.foundry/bin/forge` and must not be used for Arc-semantics tests | Action for you | – |

Pinned install for this machine (macOS Apple Silicon):

```bash
V=v0.8.0-1
cd "$(mktemp -d)"
curl -LO https://github.com/circlefin/arc-foundry/releases/download/$V/arc-foundry-$V-aarch64-apple-darwin.tar.gz
curl -LO https://github.com/circlefin/arc-foundry/releases/download/$V/arc-foundry-$V-aarch64-apple-darwin.tar.gz.sha256
shasum -a 256 -c arc-foundry-$V-aarch64-apple-darwin.tar.gz.sha256
tar -xzf arc-foundry-$V-aarch64-apple-darwin.tar.gz
mkdir -p ~/.local/bin
mv forge ~/.local/bin/arc-forge && mv cast ~/.local/bin/arc-cast && mv anvil ~/.local/bin/arc-anvil
arc-forge --version
```

(Extracted file layout inside the tarball wasn't inspected. Adjust the `mv` paths if the
binaries are in a subdirectory. `~/.local/bin` must be on `PATH`.)

## 6. Open items summary

1. Mainnet explorer API flavour and `arc-forge verify-contract` support.
2. RPC provider archive / trace / debug availability and plan limits.
3. USDC blocklist controller and in-contract behaviour (covered by the G4 test).
4. Safe{Wallet} UI / Transaction Service support on Arc (Allowance Module missing).
5. Chainlink mainnet feeds: approve for the cross-check, or keep disabled. No ADA/XLM feeds. No testnet feeds.
6. RedStone / Chronicle Arc deployments.
7. Whether the 20 gwei floor is documented for mainnet as well as testnet (observed ≥20).

[connect]: https://docs.arc.io/arc/references/connect-to-arc
[nodes]: https://docs.arc.io/arc/tools/node-providers.md
[gas]: https://docs.arc.io/arc/references/gas-and-fees.md
[evm]: https://docs.arc.io/arc/references/evm-compatibility
[addrs]: https://docs.arc.io/arc/references/contract-addresses
[oracles]: https://docs.arc.io/arc/tools/oracles.md
[cctp]: https://developers.circle.com/cctp/cctp-supported-blockchains
[arcfoundry]: https://github.com/circlefin/arc-foundry
[arcfoundry-rel]: https://github.com/circlefin/arc-foundry/releases/tag/v0.8.0-1
[viem-arc]: https://github.com/wevm/viem/blob/main/src/chains/definitions/arc.ts
[arcscan]: https://github.com/circlefin/arc-node/pull/396
[safe]: https://github.com/safe-global/safe-deployments/blob/main/src/assets/v1.4.1/safe_l2.json
[safe-2nd]: https://github.com/KeeperHub/keeperhub/pull/2228
[cl-dir]: https://reference-data-directory.vercel.app/feeds-arc-mainnet.json
[pyth]: https://docs.pyth.network/price-feeds/core/contract-addresses/evm
[stork]: https://docs.stork.network/resources/contract-addresses/evm
