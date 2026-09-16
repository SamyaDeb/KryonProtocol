/**
 * Per-network configuration registry.
 *
 * WHY THIS EXISTS
 * ---------------
 * Kryon used to resolve its network once, at *build* time, from
 * `NEXT_PUBLIC_STELLAR_NETWORK`. One bundle could therefore only ever talk to
 * one network, and offering testnet meant a second deployment.
 *
 * The navbar toggle needs both networks available inside a single bundle, so
 * every address for both is baked in below. All of these values are public
 * (contract ids, RPC endpoints, network passphrases) — nothing secret is
 * widened by shipping them to the browser.
 *
 * ── The env-inlining trap (do not "clean this up") ───────────────────────────
 * Every `process.env.NEXT_PUBLIC_X` read MUST be written as a literal member
 * expression. Next.js inlines these into the client bundle by *static textual
 * substitution*; a computed key (`process.env[key]`) is not substituted and
 * silently becomes `undefined` in the browser. This cost a day on 2026-07-08,
 * when the compiled chunk still contained the testnet vault address after
 * every Vercel env var had been independently verified correct — the culprit
 * was an `envOrDefault(key, fallback)` helper doing exactly that.
 *
 * ── How env overrides interact with the toggle ───────────────────────────────
 * `NEXT_PUBLIC_STELLAR_NETWORK` still names the deployment's PRIMARY network,
 * and the `NEXT_PUBLIC_*` overrides below still apply to it — so an existing
 * mainnet deployment behaves exactly as it did, fail-fast assertions included.
 * The other network falls back to its baked defaults. This keeps the operator's
 * ability to repoint a deployment at freshly redeployed contracts without a
 * code change, while making the second network available for free.
 */

export const NETWORK_IDS = ["mainnet", "testnet"] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];

export function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === "string" && (NETWORK_IDS as readonly string[]).includes(value);
}

/** The deployment's primary network — the one `NEXT_PUBLIC_*` overrides target. */
export const PRIMARY_NETWORK: NetworkId = isNetworkId(process.env.NEXT_PUBLIC_STELLAR_NETWORK)
  ? process.env.NEXT_PUBLIC_STELLAR_NETWORK
  : "testnet";

export interface ContractSet {
  governance: string;
  oracleAdapter: string;
  vault: string;
  engine: string;
  orderGateway: string;
  insurance: string;
  liquidation: string;
  risk: string;
}

export interface AssetSet {
  nativeXlm: string;
  usdc: string;
  usdcIssuer: string;
}

/**
 * A collateral asset the vault accepts.
 *
 * Listing here does NOT make an asset depositable — the vault's own
 * `set_collateral` does. This registry only tells the client which assets are
 * worth asking the chain about; `lib/stellar/collateral.ts` reads the vault and
 * drops anything not actually listed and active, so a config entry can never
 * present a deposit that would revert.
 */
export interface CollateralAsset {
  /** Ticker shown in the UI. */
  code: string;
  /** SAC contract id — what vault deposit/withdraw take as `asset`. */
  contract: string;
  /** Classic issuer account. Null for the native XLM wrapper. */
  issuer: string | null;
  /** Oracle symbol the vault prices this asset under. */
  oracleSymbol: string;
  /** The asset PnL, funding and liquidation settle in. Exactly one is true. */
  settlement: boolean;
  /**
   * Decimals to round withdrawals down to, when the asset bridges out at fewer
   * decimals than Stellar's 7. USDT0's LayerZero OFT normalises to 6 shared
   * decimals, so a 7th-decimal remainder cannot be bridged and would strand as
   * dust. Undefined means no rounding.
   */
  bridgeDecimals?: number;
  /** Short note surfaced in the deposit dialog. */
  note?: string;
}

export interface NetworkConfig {
  id: NetworkId;
  /** Human label for chrome: "Stellar Mainnet". */
  label: string;
  /** Short label for the navbar toggle: "Mainnet". */
  shortLabel: string;
  rpcUrl: string;
  passphrase: string;
  horizonUrl: string;
  explorerUrl: string;
  contracts: ContractSet;
  assets: AssetSet;
  /** Assets the vault may accept as margin, settlement asset first. */
  collateral: readonly CollateralAsset[];
  /**
   * Whether this network is expected to have keepers (oracle/matcher/indexer)
   * running behind it. When false the UI shows a degraded-venue banner rather
   * than presenting an empty order book as if it were real market state.
   */
  keepersExpected: boolean;
}

// ─── Baked defaults ──────────────────────────────────────────────────────────
// Mainnet: deployed 2026-07-07, kryon-protocol/infra/deploy/mainnet-deployment.json
// Testnet: redeployed 2026-07-05, kryon-protocol/infra/deploy/testnet-deployment.toml

const MAINNET_DEFAULTS = {
  rpcUrl: "https://mainnet.sorobanrpc.com",
  passphrase: "Public Global Stellar Network ; September 2015",
  horizonUrl: "https://horizon.stellar.org",
  contracts: {
    governance: "CDSIEH7UZ62BT523G3RGJQGJHE7AI4EV265ESKZB672GTIEZNBYPYDXU",
    oracleAdapter: "CD3ZFYZPLJ6W2KO6HD7HE5P5Q27M5N6ITUPHQDRP23NBIVKE6WTUY25F",
    vault: "CDXGTJQS3XLGXSWDUHKMS5PBBFRRKRXRWH3HTBFNXBIAYEZNDTDKLR4J",
    engine: "CD6OMHCRDDBDO7I57HCUU52RORFPP7DUIRULWFBOX5WLCO5H2OB3W6LZ",
    orderGateway: "CBA2PSRHSIFTSUAFZWMF6CARNO7YR52PWLWLEXYVRACORS2RXNO2DUTJ",
    insurance: "CCBEJ3F2PUV5OA4JNX3CPSOJFQMYMFDPLNANR2GJZVQEEBFMB6JYNL54",
    liquidation: "CBGSXCZTZOSBMM5RLGZWWLE2USNAXL5ZKCHTZQ6DOKBD3PIEUJXFYDRO",
    risk: "CBHZWEIKXULFIH6DCSS7W6BJ3YUVQ5TJFYPP4UKQC4NKLNAF7VLPNVUI",
  },
  assets: {
    nativeXlm: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    usdc: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    usdcIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
  collateral: [
    {
      code: "USDC",
      contract: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      oracleSymbol: "USDC",
      settlement: true,
    },
    {
      // Tether's USDT0, live on Stellar 2026-09-02. A LayerZero OFT, not a
      // native Tether issuance, so it carries bridge risk on top of issuer
      // risk — hence a haircut, set on-chain via set_collateral.
      // https://developers.stellar.org/docs/tokens/usdt0-layerzero
      code: "USDT0",
      contract: "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF",
      issuer: "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
      oracleSymbol: "USDT0",
      settlement: false,
      bridgeDecimals: 6,
      note: "Margin only. PnL settles in USDC.",
    },
  ],
} as const;

const TESTNET_DEFAULTS = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
  horizonUrl: "https://horizon-testnet.stellar.org",
  // Redeployed 2026-09-06 as v3 (infra/deploy/testnet-deployment-v3.json).
  //
  // EVERY layer must name the same contract set: this file (browser + API), the
  // Railway keeper env vars (NEXT_PUBLIC_CONTRACT_*), and any script. When the
  // web tier briefly pointed at v2 while the keepers ran v3, deposits landed in
  // a vault no matcher was watching, so orders rested unbacked, every fill
  // failed its margin check and rolled back, and one settle job retried 356
  // times. The oracle keeper only feeds the set it is configured for — the
  // other set goes stale within ~10 minutes and settlement stops dead.
  // The v2 deployment's admin key was lost, so its vault could never be
  // reconfigured again — no new collateral, no new markets, no guardian, no
  // admin handover. v3 carries the multi-collateral work AND upgrade() on every
  // contract, so a change no longer costs a redeploy.
  contracts: {
    governance: "CDZDUYFCC7PI2AJMNHV3MC2YDE6PAFGUGORSACJECKJHFA3WBJUJARXR",
    oracleAdapter: "CD554K6KT7ZPJDI2V34EJTTEJECU3VC2HSHD2QJFV2S2L7ABL3RZR2JL",
    vault: "CBUWQHSJNRFVM5QIBZ4DUZOPJVFJL6VAZWW7S5OE5B7ZO7BZPPOBE334",
    engine: "CDHZJ2V4BVIE765YV5SXFMKQAIXTIFN4HJ5D5DVHZSHSY6VNTQI5UBSI",
    orderGateway: "CDR6YWOWWUKUL7IJP54B44N5H6Q3Y6RGWVQ7VQ4UXWRQ2C6FNAQBDVCT",
    insurance: "CA7TCLZU2GOXXNOBE65EA7QO33NQGQBVHAUPORPUZOJN5W6NLG2RWHO4",
    liquidation: "CCU44MEY452T5IESCOGETP3OPVSWSXZMPYG6FICE4JLP2R4YSM4UWODG",
    risk: "CDZNCVMIKW6BPEWCDLJHHLIQM7EBMFC6YOLADBI36ZOICUWDUS2ZAM7B",
  },
  assets: {
    nativeXlm: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  },
  // Real USDT0 is a mainnet-only issuance (its issuer 404s on testnet), so
  // testnet uses the mock from scripts/deploy-testnet-usdt0.ts. Listed on the
  // v3 vault at a 500bps haircut; verified on chain 2026-09-06 — 1,000 USDT0
  // deposited valued at 950 equity.
  collateral: [
    {
      code: "USDC",
      contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      oracleSymbol: "USDC",
      settlement: true,
    },
    {
      code: "USDT0",
      contract: "CCXWM7LWNT4VDRUJ4KZILV6KB7SXWDWDBF5TT65E5IRDEX7QZTDMNLRO",
      issuer: "GDEJSYQQOZIUKFZVS4OKWZCH7D3YCGN2NMUGBCNPVQXFX6XN4JRK32ND",
      oracleSymbol: "USDT0",
      settlement: false,
      bridgeDecimals: 6,
      note: "Margin only. PnL settles in USDC.",
    },
  ],
} as const;

// ─── Env overrides (primary network only) ────────────────────────────────────
// Read once, as literal expressions, so Next.js inlines them. `pick` applies an
// override only when THIS network is the primary one.

const OVERRIDES = {
  rpcUrl: process.env.NEXT_PUBLIC_STELLAR_RPC_URL,
  passphrase: process.env.NEXT_PUBLIC_STELLAR_PASSPHRASE,
  horizonUrl: process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL,
  governance: process.env.NEXT_PUBLIC_CONTRACT_GOVERNANCE,
  oracleAdapter: process.env.NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER,
  vault: process.env.NEXT_PUBLIC_CONTRACT_VAULT,
  engine: process.env.NEXT_PUBLIC_CONTRACT_ENGINE,
  orderGateway: process.env.NEXT_PUBLIC_CONTRACT_ORDER_GATEWAY,
  insurance: process.env.NEXT_PUBLIC_CONTRACT_INSURANCE,
  liquidation: process.env.NEXT_PUBLIC_CONTRACT_LIQUIDATION,
  risk: process.env.NEXT_PUBLIC_CONTRACT_RISK,
  nativeXlm: process.env.NEXT_PUBLIC_ASSET_NATIVE_XLM,
  usdc: process.env.NEXT_PUBLIC_ASSET_USDC,
  usdcIssuer: process.env.NEXT_PUBLIC_USDC_ISSUER,
} as const;

// USDT0 is configured separately from OVERRIDES because it is OPTIONAL: unset
// simply means this deployment does not offer it, which is the correct state
// for a testnet that has not had a mock issued yet. Putting it in OVERRIDES
// would trip assertPresentOnPrimaryMainnet and hard-fail mainnet boot on an
// asset that is legitimately not listed yet.
const USDT0_OVERRIDE = {
  contract: process.env.NEXT_PUBLIC_ASSET_USDT0,
  issuer: process.env.NEXT_PUBLIC_USDT0_ISSUER,
} as const;

// Per-network override, applied whether or not that network is the primary one.
// This deployment builds with mainnet primary but serves testnet through the
// navbar toggle, so a primary-only override can never reach the testnet view —
// USDT0 would stay invisible there no matter what the vault had listed. Follows
// the existing NEXT_PUBLIC_*_TESTNET convention (WS_URL, ACTIVE_MARKETS).
const USDT0_TESTNET_OVERRIDE = {
  contract: process.env.NEXT_PUBLIC_ASSET_USDT0_TESTNET,
  issuer: process.env.NEXT_PUBLIC_USDT0_ISSUER_TESTNET,
} as const;

/** The USDT0 address to use for `id`, or null when this network offers none. */
function usdt0For(id: NetworkId, primary: boolean) {
  if (id === "testnet" && USDT0_TESTNET_OVERRIDE.contract) return USDT0_TESTNET_OVERRIDE;
  if (primary && USDT0_OVERRIDE.contract) return USDT0_OVERRIDE;
  return null;
}

/**
 * Mainnet must never silently fall back to a baked address when it is the
 * primary (deployed) network — a wrong vault id there loses real funds. This
 * reproduces the original fail-fast contract exactly.
 */
function assertPresentOnPrimaryMainnet(key: string, value: string | undefined): void {
  if (PRIMARY_NETWORK === "mainnet" && !value) {
    throw new Error(`Missing ${key} for mainnet deployment`);
  }
}

for (const [key, value] of Object.entries(OVERRIDES)) {
  assertPresentOnPrimaryMainnet(key, value);
}

/**
 * Resolves a network's collateral list.
 *
 * The settlement asset honours the NEXT_PUBLIC_ASSET_USDC override so a
 * redeployed SAC stays consistent with `assets.usdc`.
 *
 * USDT0 can also be injected by env. Testnet has no USDT0 issuance of its own,
 * so a testnet deployment issues a mock (scripts/deploy-testnet-usdt0.ts) and
 * points NEXT_PUBLIC_ASSET_USDT0 at the resulting SAC. Unset means the network
 * does not offer USDT0 at all, which is the right default: `listVaultCollateral`
 * would drop it anyway, but not asking the chain about a placeholder address is
 * cleaner than relying on that.
 */
function buildCollateral(
  id: NetworkId,
  defaults: readonly CollateralAsset[],
  pick: (override: string | undefined, fallback: string) => string,
  primary: boolean
): readonly CollateralAsset[] {
  const resolved = defaults.map((c) =>
    c.settlement
      ? {
          ...c,
          contract: pick(OVERRIDES.usdc, c.contract),
          issuer: pick(OVERRIDES.usdcIssuer, c.issuer ?? ""),
        }
      : c
  );

  if (resolved.some((c) => c.code === "USDT0")) return resolved;
  const usdt0 = usdt0For(id, primary);
  if (!usdt0?.contract) return resolved;

  return [
    ...resolved,
    {
      code: "USDT0",
      contract: usdt0.contract,
      issuer: usdt0.issuer ?? null,
      oracleSymbol: "USDT0",
      settlement: false,
      bridgeDecimals: 6,
      note: "Margin only. PnL settles in USDC.",
    },
  ];
}

function buildNetwork(
  id: NetworkId,
  defaults: typeof MAINNET_DEFAULTS | typeof TESTNET_DEFAULTS
): NetworkConfig {
  // Overrides target the deployment's primary network only; the secondary
  // network always uses its baked defaults.
  const primary = id === PRIMARY_NETWORK;
  const pick = (override: string | undefined, fallback: string): string =>
    primary && override ? override : fallback;

  const isMainnet = id === "mainnet";
  return {
    id,
    label: isMainnet ? "Stellar Mainnet" : "Stellar Testnet",
    shortLabel: isMainnet ? "Mainnet" : "Testnet",
    rpcUrl: pick(OVERRIDES.rpcUrl, defaults.rpcUrl),
    passphrase: pick(OVERRIDES.passphrase, defaults.passphrase),
    horizonUrl: pick(OVERRIDES.horizonUrl, defaults.horizonUrl),
    explorerUrl: isMainnet
      ? "https://stellar.expert/explorer/public"
      : "https://stellar.expert/explorer/testnet",
    contracts: {
      governance: pick(OVERRIDES.governance, defaults.contracts.governance),
      oracleAdapter: pick(OVERRIDES.oracleAdapter, defaults.contracts.oracleAdapter),
      vault: pick(OVERRIDES.vault, defaults.contracts.vault),
      engine: pick(OVERRIDES.engine, defaults.contracts.engine),
      orderGateway: pick(OVERRIDES.orderGateway, defaults.contracts.orderGateway),
      insurance: pick(OVERRIDES.insurance, defaults.contracts.insurance),
      liquidation: pick(OVERRIDES.liquidation, defaults.contracts.liquidation),
      risk: pick(OVERRIDES.risk, defaults.contracts.risk),
    },
    assets: {
      nativeXlm: pick(OVERRIDES.nativeXlm, defaults.assets.nativeXlm),
      usdc: pick(OVERRIDES.usdc, defaults.assets.usdc),
      usdcIssuer: pick(OVERRIDES.usdcIssuer, defaults.assets.usdcIssuer),
    },
    // The settlement asset honours the NEXT_PUBLIC_ASSET_USDC override so a
    // redeployed SAC stays consistent with `assets.usdc`; the rest are baked.
    collateral: buildCollateral(id, defaults.collateral, pick, primary),
    // Keepers are wired per network by the operator. `NEXT_PUBLIC_KEEPERS_*`
    // lets a deployment declare which venues are actually live; unset means
    // "only the primary network is live", which is the safe reading.
    keepersExpected: isMainnet
      ? parseKeepersFlag(process.env.NEXT_PUBLIC_MAINNET_KEEPERS_LIVE, id === PRIMARY_NETWORK)
      : parseKeepersFlag(process.env.NEXT_PUBLIC_TESTNET_KEEPERS_LIVE, id === PRIMARY_NETWORK),
  };
}

function parseKeepersFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  mainnet: buildNetwork("mainnet", MAINNET_DEFAULTS),
  testnet: buildNetwork("testnet", TESTNET_DEFAULTS),
};

export function getNetworkConfig(id: NetworkId): NetworkConfig {
  return NETWORKS[id];
}
