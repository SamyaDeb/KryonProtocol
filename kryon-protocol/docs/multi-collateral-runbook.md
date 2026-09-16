# Multi-collateral runbook (USDT0)

How a second collateral asset gets listed, and the failure modes that make the
order matter. Written for USDT0; the sequence generalises.

## The model

One settlement asset (USDC). Everything else is margin.

PnL, funding, liquidation rewards and bad debt are all denominated in the
settlement asset — `perp-engine` and `perp-liquidation` each hold a single
`SettlementAsset`. Other collateral is valued at oracle price minus a haircut
and counts toward equity, but never becomes an accounting unit. This is what
Hyperliquid and dYdX v4 do, and it is why adding an asset is mostly config
rather than code.

The consequence: **a loss always debits the settlement asset**, including for a
trader who has never held any. That debit is covered by seizing their other
collateral (`vault.seize_for_deficit`), at haircut value, lowest haircut first.
Insurance is only reached for what collateral could not cover.

## USDT0 availability — the constraint everything else follows from

Verified against the live networks on 2026-09-06:

```
issuer GATISXX6…  testnet horizon → 404   (does not exist)
issuer GATISXX6…  mainnet horizon → 200   (exists)
```

Tether/LayerZero issued USDT0 to Stellar **mainnet only**. There is no testnet
deployment of it and nothing in this repo's env or config references one.

That forces the split below, and it is not a preference:

| | Asset | Vault |
|---|---|---|
| Testnet (has user traction) | mock only — real USDT0 does not exist there | existing, pre-fix |
| Mainnet | real USDT0 | fix first, then list |

## Track A — mock USDT0 on the existing testnet

Keeps the venue your testers are already on. The vault predates the seizure
work, so this runs with a known bug: a USDT0-margined trader's losses drain the
insurance fund while their USDT0 sits untouched, and their settlement balance
goes negative and stays there. `list-usdt0.ts` warns before it lists. Acceptable
to exercise the flow on testnet; never on mainnet.

The mock is already issued:

```
SAC     CCXWM7LWNT4VDRUJ4KZILV6KB7SXWDWDBF5TT65E5IRDEX7QZTDMNLRO
issuer  GDEJSYQQOZIUKFZVS4OKWZCH7D3YCGN2NMUGBCNPVQXFX6XN4JRK32ND
```

Set `NEXT_PUBLIC_ASSET_USDT0` / `NEXT_PUBLIC_USDT0_ISSUER` to those, then sign
three calls as the vault/oracle admin (`GAPK4UCV…`):

```
ORACLE_ADMIN_SECRET=S… VAULT_ADMIN_SECRET=S… \
  ORACLE_PUBLISHER_PUBKEY=G… npx tsx scripts/list-usdt0.ts --dry-run
```

Leave `VAULT_SETTLE_DEFICITS` **off** — that vault has no `settle_deficit`.

## Track B — real USDT0 on mainnet, after fixing mainnet

The mainnet vault (`CDXGTJQS…`) also predates the fix — `operator` returns
`MissingValue`. It holds ~3.23 USDC, so there is almost nothing to strand, which
makes now the cheapest moment this will ever be.

1. Redeploy mainnet with the multi-collateral artifacts (hashes are pinned in
   `mainnet-deploy.ts` and verified against the testnet v3 rehearsal).
2. Hand admin to the governance timelock **before** anything is listed — the
   new contracts carry `upgrade()`, and under a plain keypair that turns a key
   leak into code replacement.
3. `list-usdt0.ts` against the real SAC `CBSJZEIO…`.

### Do not let a deploy eat your keys

Both deploy scripts used to write generated operator and guardian secrets to a
**fixed filename**, so a second run overwrote the first deployment's secrets
while that deployment was still live. This happened on testnet: the v3 run
destroyed the live testnet guardian's secret, recoverable only because the vault
admin can `set_guardian` to a fresh key.

The secrets path now follows `DEPLOY_STATE_PATH`, and `writeSecretsOrRefuse`
refuses to clobber a non-empty file. Always pass a fresh `DEPLOY_STATE_PATH` for
a new deployment.

## Prerequisite: the deployed contracts predate all of this

The vaults live on testnet and mainnet today have no `seize_for_deficit`, no
`settle_deficit`, no `collateral` view and no `upgrade`. Nothing here reaches
them without a **redeploy** — and because `upgrade` itself has to be deployed
before it can be used, that is unavoidable exactly once.

Listing USDT0 on the *existing* vault would work in the narrow sense that
traders could deposit and trade. It would also run with the known solvency bug:
a USDT0-margined trader's losses drain the insurance fund while their USDT0 sits
untouched. Do not do this on mainnet. On testnet it is a defensible shortcut for
a quick UI check, and nothing else.

## Testnet rehearsal

Do this first. A first collateral listing has real money inside it when it goes
wrong.

```
# 1. Redeploy with multi-collateral support (also installs upgrade())
npx tsx scripts/testnet-deploy.ts

# 2. Issue the mock asset — testnet has no USDT0 of its own
npx tsx scripts/deploy-testnet-usdt0.ts
#    → set NEXT_PUBLIC_ASSET_USDT0 / NEXT_PUBLIC_USDT0_ISSUER from its output

# 3. Keeper: ORACLE_PUBLISH_USDT0=true, VAULT_SETTLE_DEFICITS=true, restart

# 4. Feed → verify price → cap → list
npx tsx scripts/list-usdt0.ts --dry-run
npx tsx scripts/list-usdt0.ts

# 5. Fund a tester (they need a USDT0 trustline in Freighter first)
npx tsx scripts/faucet-usdt0.ts G… 10000
```

Then verify the thing that actually matters: deposit only USDT0, open a
position, take a loss, get liquidated, and confirm the insurance fund balance is
untouched beyond the liquidator reward. That is the behaviour the contract tests
assert; this confirms it against a real ledger.

## Order of operations

Each step exists because doing it later breaks something specific.

### 1. Oracle feed, before anything else

`vault.account_health` prices **every** asset an account holds. Once USDT0 is
listed and deposited, every health check on that account calls
`oracle.get_price("USDT0")`.

A missing or stale feed does not degrade gracefully — `get_price` errors, and
the account can no longer trade, withdraw, **or be liquidated**. Funds are
frozen inside. Testnet settled nothing for weeks from exactly this failure on
USDC; with collateral it is worse, because money is already in.

```
ORACLE_ADMIN_SECRET=… ORACLE_PUBLISHER_PUBKEY=… \
  npx tsx scripts/list-usdt0.ts --dry-run
```

Set `max_age_secs` **tighter than or equal to** the USDC feed. A pegged asset's
price barely moves, so a stale feed looks healthy right up until it isn't.

### 2. Keeper publishing

Set `ORACLE_PUBLISH_USDT0=true` and restart the keeper. It sources USDT/USD
from Coinbase and Kraken and halts publication on a depeg beyond
`USDT0_DEPEG_HALT_BPS` (default 100), so valuation goes stale and the protocol
fail-stops rather than valuing depegged collateral at par.

Never hardcode a pegged asset at 1.0. A constant price is a collateral asset
that cannot be liquidated when it depegs — the only time it matters.

### 3. Deposit cap, then listing

`list-usdt0.ts` (without `--dry-run`) waits for a guard-passing price to read
back off-chain, then sets the cap **before** `set_collateral`, so the cap is
live the instant deposits open. It exits without listing if no price appears.

### 4. Operator for deficit settlement

```
vault.set_operator(<keeper address>)
```

Losses debit the settlement asset on every fill, not only at liquidation, so an
account margined in USDT0 accrues a negative USDC balance while perfectly
healthy. That balance is real reserves already paid to the winning side. A
keeper calling `settle_deficit` clears it; an account owner can always call it
for themselves.

It is not permissionless on purpose — seizure converts collateral at a haircut,
and a third party should not be able to force that on someone who would rather
deposit USDC.

## Risk parameters

**Haircut** prices what can go wrong with the asset. USDT0 carries Tether issuer
risk *plus* LayerZero OFT bridge risk *plus* a thin Stellar-side book, stacked on
USDC's zero. Open wide (500bps) and ratchet down with observed liquidity, not the
other way round.

**Deposit cap** prices liquidity, and it is the control that actually protects
you. Set it to what you could unwind into USDC on-chain in a bad hour — not to a
TVL target. Stellar-side USDT0 supply was ~$2.6M across 89 funded trustlines at
listing time.

## Traps

**Do not use `active: false` to respond to a depeg.** `account_snapshot_all_assets`
skips inactive collateral, and `deposit`/`withdraw` both reject it. Flipping it
would erase the asset from every holder's equity — mass-liquidating them — while
simultaneously trapping their funds. It is a de-listing tool, for use only after
balances are drained to zero.

The real depeg levers, in order of severity: raise `haircut_bps`, drop
`deposit_cap` to current `total_deposited` to stop inflow, guardian
`emergency_pause` for an actual emergency.

**Seized collateral needs a treasury leg.** Seizure moves the user's internal
claim, not tokens. After a seizure the vault holds surplus USDT0 against a USDC
credit it has already paid out. Something has to swap that surplus back, or USDC
reserves drift down while USDT0 accumulates.

**Round withdrawals to 6 decimals.** The SAC holds 7; the OFT bridges at 6. The
client does this (`roundToBridgeable`), and the remainder stays as vault balance
rather than stranding as unbridgeable dust in the wallet.

## Alerts

Each of these has a specific failure it catches. The 2026-07 outage ran silent
because the monitor had no webhook — delivery is the point.

| Alert | Why |
|---|---|
| USDT0 price outside ±50bps | Depeg. Haircut alone will not save you. |
| USDT0 feed age nearing `max_age_secs` | A stale collateral feed reverts every `account_health`, which halts liquidations. |
| `CollateralSeized` with non-zero `uncovered_value` | Exactly what insurance is about to absorb. |
| `total_deposited` above ~80% of cap | Raise deliberately, not under pressure. |
| Any `record_bad_debt` | Post-seizure this should be rare enough to look at every time. |

## Upgrades

Every contract now has `upgrade(new_wasm_hash)`, so changes no longer need a
redeploy and state migration.

It is admin-gated, and that gate is the entire security model. **Admin must be
the governance timelock before this is live on mainnet**, so an upgrade inherits
the 48h delay and cancel window. While a plain deployer keypair holds admin,
`upgrade` turns a key compromise into total protocol takeover.

`list-usdt0.ts` refuses to run when the signer is not the current admin, and
says to queue a governance proposal instead. That is the intended path.
