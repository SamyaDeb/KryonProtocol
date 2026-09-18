/**
 * The fee schedule and an account's effective rates, for `GET /api/fees`.
 *
 * The UI shows the fee before the user signs, so what it shows must be what
 * `FeeRouter.quote` will charge. The resolution below mirrors `_rateFor` and
 * `quote` line for line:
 *
 *   tier = accountTier[account]
 *   rates = tier == 0 ? marketRates[market] : tiers[tier]
 *   if !rates.set: tier = 0, rates = marketRates[market]   // a removed tier
 *   maker < 0 && !rebatesEnabled → maker = 0
 *   maker + taker < minNetRate   → maker = minNetRate − taker  (per fill pairing)
 *
 * The last clamp depends on the counterparty's taker rate, which nobody knows
 * before the match, so it cannot be applied here. It only ever raises the
 * MAKER side, so the taker rate reported is exact and the maker rate is a lower
 * bound; `net_rate_floor` is reported alongside so the UI can say so.
 *
 * SOURCES
 * -------
 * The indexer projects the per-market schedule (`MarketFeesSet` →
 * `Market.makerRate/takerRate`) and account tiers (`FeeTierSet` →
 * `Account.feeTier`); those are read from the database. Tier definitions,
 * `rebatesEnabled` and `minNetRate` are not projected and are always read from
 * `FeeRouter`. If the database is unavailable the schedule and tier are read
 * from the chain too, and the response says which source answered.
 *
 * Rates are integers in millionths of notional (`RATE_DENOMINATOR = 1e6`):
 * 350 = 3.5 bps. They are rates, not amounts; amounts are computed by the
 * caller in bigint.
 */

import { hexToString, type Address, type Hex, type PublicClient } from "viem";

import { feeRouterAbi, riskParamsAbi } from "@/lib/chain/contracts";
import type { Queryable } from "@/lib/queries/client";

export const RATE_DENOMINATOR = 1_000_000;

export interface Rates {
  makerRate: number;
  takerRate: number;
  set: boolean;
}

/** The FeeRouter/RiskParams reads this module needs; `viemFeeChain` in production. */
export interface FeeChain {
  rebatesEnabled(): Promise<boolean>;
  minNetRate(): Promise<number>;
  tierRates(tier: number): Promise<Rates>;
  accountTier(account: Address): Promise<number>;
  marketRates(marketId: number): Promise<Rates>;
  /** Listed market ids with their oracle symbol, for the database-less path. */
  markets(): Promise<{ id: number; symbol: string; active: boolean }[]>;
}

export type FeeSource = "indexer" | "chain";

export interface MarketFees {
  marketId: number;
  symbol: string;
  active: boolean;
  makerRate: number;
  takerRate: number;
}

export interface AccountFees {
  address: string;
  /** The tier the account is assigned. */
  tier: number;
  /** The tier `quote` will actually apply (0 when the assigned tier was removed). */
  effectiveTier: number;
  rates: { marketId: number; makerRate: number; takerRate: number }[];
}

export interface FeeSchedule {
  rebatesEnabled: boolean;
  netRateFloor: number;
  source: FeeSource;
  markets: MarketFees[];
  account: (AccountFees & { tierSource: FeeSource }) | null;
}

/** `quote`'s rebate clamp, applied to one side's schedule. */
export function applyRebatePolicy(r: { makerRate: number; takerRate: number }, rebatesEnabled: boolean) {
  return { makerRate: r.makerRate < 0 && !rebatesEnabled ? 0 : r.makerRate, takerRate: r.takerRate };
}

/** `_rateFor` for every market: the tier's rates, or the market's when the tier is 0 or unset. */
export function effectiveRates(
  markets: MarketFees[],
  tier: number,
  tierRates: Rates | null,
  rebatesEnabled: boolean
): { effectiveTier: number; rates: AccountFees["rates"] } {
  const useTier = tier !== 0 && tierRates !== null && tierRates.set;
  return {
    effectiveTier: useTier ? tier : 0,
    rates: markets.map((m) => ({
      marketId: m.marketId,
      ...applyRebatePolicy(useTier ? tierRates : m, rebatesEnabled),
    })),
  };
}

async function marketsFromDb(sql: Queryable, network: string): Promise<MarketFees[]> {
  const rows = await sql.query(
    `SELECT "id", "symbol", "active", "makerRate", "takerRate" FROM "Market" WHERE "network" = $1 ORDER BY "id"`,
    [network]
  );
  return rows.map((r) => ({
    marketId: Number(r.id),
    symbol: String(r.symbol),
    active: r.active === true,
    makerRate: Number(r.makerRate),
    takerRate: Number(r.takerRate),
  }));
}

async function tierFromDb(sql: Queryable, network: string, address: string): Promise<number> {
  const rows = await sql.query(`SELECT "feeTier" FROM "Account" WHERE "network" = $1 AND "address" = $2`, [
    network,
    address.toLowerCase(),
  ]);
  // No row: the indexer has never seen the account, so no FeeTierSet either.
  return rows.length === 0 ? 0 : Number(rows[0].feeTier);
}

async function marketsFromChain(chain: FeeChain): Promise<MarketFees[]> {
  const listed = await chain.markets();
  const out: MarketFees[] = [];
  for (const m of listed) {
    const r = await chain.marketRates(m.id);
    // An unset schedule makes `quote` revert UnknownMarket: the market cannot trade.
    if (!r.set) continue;
    out.push({ marketId: m.id, symbol: m.symbol, active: m.active, makerRate: r.makerRate, takerRate: r.takerRate });
  }
  return out;
}

/**
 * Resolve the schedule, and the account's rates when `address` is given.
 * `sql` null (or failing) means the database path is unavailable.
 * Chain failures propagate: without the globals the fee cannot be stated.
 */
export async function resolveFees(o: {
  network: string;
  sql: Queryable | null;
  chain: FeeChain;
  address?: string | null;
  onDbError?: (e: unknown) => void;
}): Promise<FeeSchedule> {
  const [rebatesEnabled, netRateFloor] = await Promise.all([o.chain.rebatesEnabled(), o.chain.minNetRate()]);

  let markets: MarketFees[] | null = null;
  let dbTier: number | null = null;
  if (o.sql) {
    try {
      markets = await marketsFromDb(o.sql, o.network);
      if (o.address) dbTier = await tierFromDb(o.sql, o.network, o.address);
    } catch (e) {
      o.onDbError?.(e);
      markets = null;
      dbTier = null;
    }
  }
  const source: FeeSource = markets === null ? "chain" : "indexer";
  if (markets === null) markets = await marketsFromChain(o.chain);

  let account: FeeSchedule["account"] = null;
  if (o.address) {
    const tierSource: FeeSource = dbTier === null ? "chain" : "indexer";
    const tier = dbTier ?? (await o.chain.accountTier(o.address as Address));
    const tierRates = tier === 0 ? null : await o.chain.tierRates(tier);
    account = { address: o.address.toLowerCase(), tier, tierSource, ...effectiveRates(markets, tier, tierRates, rebatesEnabled) };
  }

  return {
    rebatesEnabled,
    netRateFloor,
    source,
    markets: markets.map((m) => ({ ...m, ...applyRebatePolicy(m, rebatesEnabled) })),
    account,
  };
}

// ── Chain reader ─────────────────────────────────────────────────────────────

type Reader = Pick<PublicClient, "readContract">;

function rates(raw: unknown): Rates {
  const r = raw as { makerRate: number; takerRate: number; set: boolean } | readonly [number, number, boolean];
  if (Array.isArray(r)) return { makerRate: Number(r[0]), takerRate: Number(r[1]), set: Boolean(r[2]) };
  const o = r as { makerRate: number; takerRate: number; set: boolean };
  return { makerRate: Number(o.makerRate), takerRate: Number(o.takerRate), set: o.set };
}

/** The oracle symbol a `bytes32` id encodes: `bytes32("BTC")` → "BTC". */
function symbolOf(oracleId: Hex): string {
  return hexToString(oracleId, { size: 32 }).replace(/\0+$/, "") || oracleId;
}

export function viemFeeChain(client: Reader, feeRouter: Address, riskParams: Address): FeeChain {
  const read = (address: Address, abi: unknown, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<unknown>;
  return {
    rebatesEnabled: async () => Boolean(await read(feeRouter, feeRouterAbi, "rebatesEnabled")),
    minNetRate: async () => Number(await read(feeRouter, feeRouterAbi, "minNetRate")),
    tierRates: async (tier) => rates(await read(feeRouter, feeRouterAbi, "tierRates", [tier])),
    accountTier: async (account) => Number(await read(feeRouter, feeRouterAbi, "accountTier", [account])),
    marketRates: async (id) => rates(await read(feeRouter, feeRouterAbi, "marketRates", [id])),
    async markets() {
      const ids = (await read(riskParams, riskParamsAbi, "marketIds")) as readonly number[];
      const out = [];
      for (const id of ids) {
        const m = (await read(riskParams, riskParamsAbi, "market", [id])) as { oracleId: Hex; active: boolean };
        out.push({ id: Number(id), symbol: symbolOf(m.oracleId), active: m.active });
      }
      return out;
    },
  };
}

// ── JSON ─────────────────────────────────────────────────────────────────────

export function feesToJson(network: string, f: FeeSchedule) {
  return {
    network,
    rate_denominator: RATE_DENOMINATOR,
    rebates_enabled: f.rebatesEnabled,
    net_rate_floor: f.netRateFloor,
    source: f.source,
    markets: f.markets.map((m) => ({
      market_id: m.marketId,
      symbol: m.symbol,
      active: m.active,
      maker_rate: m.makerRate,
      taker_rate: m.takerRate,
    })),
    account: f.account && {
      address: f.account.address,
      tier: f.account.tier,
      effective_tier: f.account.effectiveTier,
      tier_source: f.account.tierSource,
      // `maker_rate` is a lower bound: the net-floor clamp can raise it per fill.
      rates: f.account.rates.map((r) => ({ market_id: r.marketId, maker_rate: r.makerRate, taker_rate: r.takerRate })),
    },
  };
}
