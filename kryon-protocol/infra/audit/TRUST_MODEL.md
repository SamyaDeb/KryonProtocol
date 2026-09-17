# Trust model

**Goal.** A trader's funds move only with that trader's signature (deposit, withdraw, signed
orders, cancels) or through contract-validated logic: settlement that matches both signed orders,
health-based liquidation, and ADL when bad debt is unfunded. Privileged keys can delay, halt or
degrade service within stated bounds; they can't take user funds.

## Roles

| Role | Holder (mainnet) | Can | Cannot / bounds |
|---|---|---|---|
| **Governance** (`DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE`, `RISK_ADMIN_ROLE`, `FEE_ADMIN_ROLE` on every proxy) | `KryonTimelock` only, proposed and executed by the governance Safe (N-of-M) | Upgrade any proxy; set every bounded parameter (markets, funding, OI policy, oracle feeds/publishers/references, liquidation params, fees, tiers, split, treasury, deposit caps, unwind limits); grant and revoke operational roles; `pauseIndefinitely`, `unpause`; `sweepToOperating` (stakers absorb a loss); lift a guardian veto | Act without the ≥ 48h delay (the timelock rejects `minDelay < 48h`, including self-calls to `updateDelay`); exceed setter hard bounds (see [CONFIG.md](CONFIG.md)); re-point a listed market at another oracle id. **Can upgrade to arbitrary code after 48h**, which is the root of trust |
| **Guardian** (`PAUSER_ROLE` on every proxy and on the timelock) | Guardian Safe | `pause()` any proxy for 72h; `pauseExecution()` on the timelock for 7 days | Unpause; pause again within 24h of a pause ending; veto again within 3 days of a veto ending (3 days > 48h, so an operation scheduled during a veto, e.g. revoking the guardian, can execute in the cooldown); schedule or cancel operations; change parameters; move funds. Worst case: delays withdrawals ≤ 72h per 96h window and governance ≤ 7 days per 10 days |
| **Operator** (`OPERATOR_ROLE` on OrderGateway) | Matcher service key | Submit `settleFillsSigned` batches (≤ 40); choose which signed orders to match, at what price within both limits and the oracle band, and in what order | Settle a fill not authorised by both orders (size, limit price, side, market, expiry, nonce, cancel, signature are all checked); overfill; trade outside `maxExecutionDeviationBps` of the index; force a rejection by under-gassing (the batch reverts instead). **Can** censor or delay orders, choose among valid matches, and front-run within those bounds |
| **Publishers** (`PUBLISHER_ROLE` on OracleAdapter, ≤ 5) | Oracle keeper keys | Push observations | Move the price alone when `minPublishers ≥ 2` (mainnet: 2); push outside `maxSpreadBps` of the median, beyond `maxJumpBps` of a fresh price, or beyond `maxDivergenceBps` of a live Chainlink reference; replay old timestamps. **Colluding quorum** can move the price within those guards, which feeds liquidation and settlement bands |
| **Funding keepers** (`KEEPER_ROLE` on Engine) | Funding keeper key | Call `updateFunding` | Choose the rate: it is computed from the TWAP mark and the oracle index, clamped to `maxRatePerHour`. **Can** delay updates (under-charging, capped at 1h per update) |
| **Fee-tier bot** (`FEE_TIER_ROLE` on FeeRouter) | Tier bot key | Assign an account to an existing tier or tier 0 | Create or change tiers or rates; break the net-fee floor. Can give an account a cheaper existing tier |
| **Backstop signer** (`BACKSTOP_SIGNER_ROLE` on Insurance) | Backstop unwind key, governance-revocable | Sign reduce-only orders for the Insurance account | Increase backstop exposure; sign orders living > 1h; fill outside `maxUnwindDeviationBps` (≤ 500) of the index or above per-fill / daily notional caps. Unwinds are disabled until governance sets limits |
| **Treasury** | Treasury Safe | Receive `claimTreasury` payouts (anyone can trigger; funds go only to the configured address) | Anything else |
| **Referrers** | Governance-approved addresses | Receive their referral share when referrals are enabled | Earn on their own fills; earn while unapproved or while referrals are off (the share goes to treasury) |
| **Liquidators / ADL callers** | Anyone | `liquidate` unhealthy accounts for a capped reward; `adl` in-profit counterparties while there is unfunded bad debt; `settleBadDebt` for closed-out deficits; trigger fee claims | Liquidate healthy accounts or themselves; liquidate without improving health; ADL without unfunded shortfall or against a counterparty not in profit; haircut more than the shortfall |
| **Protocol-internal roles** (`LEDGER_ROLE` on Vault, `FEE_SOURCE_ROLE` on FeeRouter, wiring addresses) | Engine, FeeRouter, Liquidation, Insurance / OrderGateway, Liquidation | Move internal balances, charge fees, apply PnL | Held by any EOA; `99_VerifyDeployment` requires the exact member sets |
| **Deployer** | Deploy key, used once | Deploy and configure in `DeployAll`, then hand over in the same run | Hold any role after `05_Handover` (verified). Mainnet preflight requires Safe contracts for proposers, guardian and treasury, and closed deposits |

Mainnet deposits start closed (`depositCap = 0`) and are opened by a timelock proposal only after
`99_VerifyDeployment` passes.

## Upgrades

- All eight protocol contracts are UUPS proxies (ERC1967). `_authorizeUpgrade` requires
  `UPGRADER_ROLE`, held only by the timelock, so every upgrade is visible for ≥ 48h before it
  executes and the guardian can veto it.
- Implementations call `_disableInitializers()` in their constructors; proxies can't be
  re-initialized (tested).
- All state lives in ERC-7201 namespaces (`kryon.storage.<Contract>` and
  `kryon.storage.KryonUpgradeable`). The reentrancy guard uses transient storage and holds no slot.
  `storage-layout/*.txt` snapshots are diffed in CI (`./script/storage-layout.sh --check`).
- `KryonTimelock` is not upgradeable.

## External dependencies

| Dependency | Address (mainnet) | Assumed behaviour | Failure impact |
|---|---|---|---|
| **Arc USDC** (ERC-20 interface of the native gas token, 6 decimals) | `0x3600000000000000000000000000000000000000` | Standard ERC-20 with EIP-2612 permit (domain `USDC`, version `2`); `transferFrom` moves exactly `amount`; native and ERC-20 balances are one balance; value transfers to `0x0` revert. **Protocol-level blocklist:** transfers from or to a blocklisted address revert | A blocklisted trader can't deposit or withdraw; their ledger balance and positions are unaffected, and settlement moves no tokens, so batches are unaffected. If the Vault itself were blocklisted, all deposits, withdrawals and claims would halt |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical Uniswap Permit2 | Only the Permit2 deposit path |
| **Chainlink data feeds** (reference cross-check per market) | BTC `0xa109…03De`, ETH `0x50FC…D364`, SOL, XRP, BNB, TRX (see `arc-mainnet.toml`) | AggregatorV3; 8 decimals; 24h heartbeat; 0.5% deviation | Read in try/catch; an unreadable or stale reference is ignored unless `required`. A wrong but live reference can block price updates (divergence halt), which halts trading on that market |
| **Multicall3** | `0xcA11bde05977b3631167028862bE2a173976CA11` | Canonical | Off-chain health scans only; no contract depends on it |
| **Arc chain** | chain ID 5042 | Non-decreasing block timestamps (equal timestamps allowed); 30M gas blocks; ≥ 20 gwei base fee; prague-compatible opcodes; EIP-7702 | Handled: funding and oracle tolerate `dt = 0`; batches ≤ 40 fills (~15.2M gas) |
| **OpenZeppelin** Contracts / Upgradeable | v5.7.0 | Audited library code | — |
| **Off-chain services** | — | Oracle keeper publishes every listed feed with open interest within `maxAge`; liquidation keeper scans health; matcher respects `minFillNotional` and the batch cap | A stale feed halts trading, liquidation and withdrawals of accounts holding that market (see [KNOWN_ISSUES.md](KNOWN_ISSUES.md)) |
