# Scope

## In scope: `kryon-protocol/evm/src/**`

nSLOC = non-blank lines that are not only a comment, after removing `//` and `/* */` comments
(NatSpec included). `pragma`, `import` and closing-brace lines count. Measured on the `audit-v1`
commit with the script at the end of this file (no `cloc`/`scc` was installed).

| File | nSLOC | Responsibility |
|---|---:|---|
| `src/Engine.sol` | 566 | Positions, OI, execution band, mark TWAP, funding indexes, account health, liquidation/ADL transfers |
| `src/FeeRouter.sol` | 345 | Maker/taker schedule, tiers, net-fee floor, split, referrals, liquidation-fee split, claims |
| `src/Insurance.sol` | 314 | Backstop fund, staking epochs, bad-debt ledger, mark-to-market capital, ERC-1271 unwind limits |
| `src/OracleAdapter.sol` | 298 | Publisher allowlist, quorum median, spread/jump/monotonic guards, re-anchor, Chainlink reference |
| `src/OrderGateway.sol` | 248 | EIP-712 orders and cancels, nonce binding, fill validation, per-fill isolated batch settlement |
| `src/Vault.sol` | 245 | USDC custody (ERC-20 + EIP-2612 + Permit2), 1e18 ledger, caps, withdrawals, internal transfers |
| `src/Liquidation.sol` | 190 | Permissionless liquidation to the backstop, reward/penalty, ADL |
| `src/RiskParams.sol` | 181 | Bounded market, funding and OI-policy parameters |
| `src/governance/KryonTimelock.sol` | 103 | 48h floor, bounded guardian veto with cooldown, enumerable roles |
| `src/governance/KryonUpgradeable.sol` | 86 | UUPS base, ERC-7201 pause namespace, bounded guardian pause |
| `src/governance/Roles.sol` | 15 | Role identifiers |
| `src/interfaces/IKryon.sol` | 127 | Internal interfaces |
| `src/libraries/RiskLib.sol` | 158 | Account health, withdrawal validation, liquidation planning |
| `src/libraries/Types.sol` | 92 | Shared structs |
| `src/libraries/OrderLib.sol` | 82 | EIP-712 typehashes, ECDSA / EIP-7702 / gas-capped ERC-1271 verification |
| `src/libraries/KryonMath.sol` | 71 | 1e18 fixed point, i128 bounds, rounding |
| `src/libraries/LiquidationLib.sol` | 68 | Partial-liquidation sizing |
| `src/libraries/Errors.sol` | 62 | Custom errors (`KryonErrors`) |
| `src/libraries/RiskCalc.sol` | 38 | Linked library (keeps Engine under 24 KB) |
| `src/libraries/FundingLib.sol` | 31 | Premium-based funding |
| `src/libraries/Decimals.sol` | 19 | The single 1e6 ↔ 1e18 boundary |
| **Total** | **3,339** | |

Grouped: core contracts 2,387; governance 204; interfaces 127; libraries 621.

## Optional scope: deployment and verification scripts

These scripts run once at deploy and then read-only against mainnet. A mistake here could leave an
EOA with an admin role or deploy wrong parameters, so a review is useful but optional.

| File | nSLOC |
|---|---:|
| `script/DeployAll.s.sol` | 18 |
| `script/lib/DeploymentVerifier.sol` | 277 |
| Supporting: `script/lib/KryonDeploy.sol` | 284 |
| Supporting: `script/lib/ConfigLoader.sol` | 106 |
| Supporting: `script/lib/DeployScript.sol` | 91 |
| Supporting: `script/99_VerifyDeployment.s.sol` | 60 |
| **Total** (`DeployAll` + `DeploymentVerifier` only) | **295** |
| **Total** (with supporting files) | **836** |

## Out of scope

- `kryon-protocol/evm/lib/**` (OpenZeppelin, forge-std). Assumed correct at the pinned versions.
- `kryon-protocol/evm/test/**` and `kryon-protocol/evm/ffi/**`, `kryon-protocol/crates/**` (the
  Rust reference model is a test oracle, not deployed code).
- The numbered scripts `00_DeployImpls` … `05_Handover` (thin wrappers over `KryonDeploy`).
- Off-chain services (matcher, oracle keeper, liquidation/funding keepers, indexer, reconciler,
  monitor), the frontend and API, the database, and infrastructure.
- Arc protocol components: the USDC system contract and its blocklist, Permit2, Multicall3 and
  Chainlink feeds. Their assumed behaviour is listed in [TRUST_MODEL.md](TRUST_MODEL.md).

## Counting script

```python
import re, sys, pathlib
def nsloc(text):
    text = re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), text, flags=re.S)
    return sum(1 for line in text.splitlines() if re.sub(r'//.*', '', line).strip())
for p in sorted(pathlib.Path(sys.argv[1]).rglob('*.sol')):
    print(nsloc(p.read_text()), p)
```

Run as `python3 nsloc.py kryon-protocol/evm/src`. The regex does not special-case `//` inside
string literals; no in-scope file has one on a code line.
