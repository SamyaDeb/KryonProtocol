// Which collateral the vault actually accepts, and whether this wallet can
// deposit it.
//
// The client config in `config/networks.ts` nominates candidate assets. The
// vault is the authority: an asset it has not listed, or has de-listed, would
// revert on deposit. Everything here reconciles the two so the UI never offers
// a deposit that cannot succeed.

import { COLLATERAL, NETWORK, SETTLEMENT_ASSET, type CollateralAsset } from "@/config";
import { getCollateralConfig, getDepositCap, getTotalDeposited } from "./contracts";

export interface ListedCollateral extends CollateralAsset {
  /** Margin discount the vault applies to this asset's oracle value. */
  haircutBps: number;
  /** Gross deposit cap, or null when uncapped. */
  depositCap: bigint | null;
  /** Deposits minus withdrawals so far, measured against the cap. */
  totalDeposited: bigint;
  /** Room left under the cap, or null when uncapped. */
  capHeadroom: bigint | null;
}

/**
 * The candidates the vault has listed and left active, in config order
 * (settlement asset first).
 *
 * Assets the vault does not know about are dropped silently — that is the
 * normal state between a client deploy and the governance call that lists a new
 * asset, not an error worth surfacing to a trader.
 */
export async function listVaultCollateral(): Promise<ListedCollateral[]> {
  // The `collateral` view was added alongside multi-collateral support, so a
  // vault deployed before it answers nothing here. Falling through would leave
  // the picker empty and make even USDC undepositable against a live venue, so
  // probe the settlement asset first: it is listed on any working deployment,
  // and a null there means the view is missing rather than the asset delisted.
  const settlementConfig = await getCollateralConfig(SETTLEMENT_ASSET.contract);
  if (!settlementConfig) return listWithoutCollateralView();

  const results = await Promise.all(
    COLLATERAL.map(async (asset) => {
      const config =
        asset.contract === SETTLEMENT_ASSET.contract
          ? settlementConfig
          : await getCollateralConfig(asset.contract);
      if (!config || !config.active) return null;
      const [depositCap, totalDeposited] = await Promise.all([
        getDepositCap(asset.contract),
        getTotalDeposited(asset.contract),
      ]);
      return {
        ...asset,
        haircutBps: config.haircutBps,
        depositCap,
        totalDeposited,
        capHeadroom:
          depositCap === null ? null : depositCap - totalDeposited > 0n ? depositCap - totalDeposited : 0n,
      } satisfies ListedCollateral;
    })
  );
  return results.filter((r): r is ListedCollateral => r !== null);
}

/**
 * Collateral list for a vault deployed before the `collateral` view existed.
 *
 * There is no way to ask such a vault what it accepts, so listing is inferred
 * from `deposit_cap`, which it does expose. That works because `list-usdt0.ts`
 * always sets the cap immediately BEFORE calling set_collateral — a capped
 * non-settlement asset is one the listing script got to. Keep those two in step
 * if either ever changes.
 *
 * The settlement asset is always included: it is listed on any working venue,
 * and dropping it would make the deposit dialog useless.
 *
 * Haircuts are unknown here (they live in the config the view would have
 * returned), so margin value is reported ungrossed — an old vault predates
 * haircut-aware collateral anyway, since it has no seizure path either.
 */
async function listWithoutCollateralView(): Promise<ListedCollateral[]> {
  const out: ListedCollateral[] = [];
  for (const asset of COLLATERAL) {
    const isSettlement = asset.contract === SETTLEMENT_ASSET.contract;
    const depositCap = await getDepositCap(asset.contract).catch(() => null);
    if (!isSettlement && depositCap === null) continue;
    const totalDeposited = await getTotalDeposited(asset.contract).catch(() => 0n);
    out.push({
      ...asset,
      haircutBps: 0,
      depositCap,
      totalDeposited,
      capHeadroom:
        depositCap === null
          ? null
          : depositCap - totalDeposited > 0n
            ? depositCap - totalDeposited
            : 0n,
    });
  }
  return out;
}

/**
 * Whether the account holds a trustline for a classic asset.
 *
 * Stellar requires a trustline before an account can hold an issued asset, so
 * a deposit of USDT0 from a wallet without one fails at the token transfer with
 * an error that does not explain itself. Checking first lets the UI say so.
 *
 * Returns true for assets with no issuer (native XLM), and true on any Horizon
 * failure — a network blip should not block a deposit that would have worked.
 */
export async function hasTrustline(address: string, asset: CollateralAsset): Promise<boolean> {
  if (!asset.issuer) return true;
  try {
    const res = await fetch(`${NETWORK.horizonUrl}/accounts/${address}`);
    if (!res.ok) return true;
    const account = (await res.json()) as {
      balances?: { asset_code?: string; asset_issuer?: string }[];
    };
    return (account.balances ?? []).some(
      (b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer
    );
  } catch {
    return true;
  }
}

/**
 * Opens a trustline for a classic asset, signed in Freighter.
 *
 * Stellar accounts cannot hold an issued asset without one, so this is a hard
 * prerequisite for depositing anything but the native wrapper. Telling a trader
 * to go and do it by hand means leaving the app, finding "Manage Assets",
 * pasting an issuer address correctly, and coming back — for a step the app can
 * simply perform.
 *
 * This is a CLASSIC operation, not Soroban: built against Horizon and submitted
 * there, rather than through the RPC path the contract calls use.
 *
 * The trustline is opened with no explicit limit, so it defaults to the maximum
 * — the deposit cap is enforced by the vault, and a wallet-side limit would only
 * produce confusing failures at a different layer.
 */
export async function addTrustline(address: string, asset: CollateralAsset): Promise<string> {
  if (!asset.issuer) throw new Error(`${asset.code} has no issuer — no trustline needed`);

  const { Asset, Operation, TransactionBuilder, Horizon, BASE_FEE } = await import(
    "@stellar/stellar-sdk"
  );
  const { freighterSignTx } = await import("./freighter");

  const horizon = new Horizon.Server(NETWORK.horizonUrl);
  const account = await horizon.loadAccount(address);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset(asset.code, asset.issuer) }))
    .setTimeout(120)
    .build();

  const signedXdr = await freighterSignTx(tx.toXDR());
  const signed = TransactionBuilder.fromXDR(signedXdr, NETWORK.passphrase);
  const res = await horizon.submitTransaction(signed);
  return res.hash;
}

/**
 * Rounds a withdrawal down to the decimals the asset can bridge at.
 *
 * USDT0's LayerZero OFT normalises to 6 shared decimals while Stellar holds 7,
 * so a 7th-decimal remainder cannot leave the chain and would sit in the
 * wallet as unbridgeable dust. Keeping the remainder in the vault instead is
 * the friendlier failure.
 *
 * `raw` is in Stellar's 7-decimal contract units.
 */
export function roundToBridgeable(raw: bigint, asset: CollateralAsset): bigint {
  if (asset.bridgeDecimals === undefined || asset.bridgeDecimals >= 7) return raw;
  const step = 10n ** BigInt(7 - asset.bridgeDecimals);
  return (raw / step) * step;
}
