/**
 * Typed read helpers for the `Market` projection.
 *
 * WHY THE QUERIES LIVE HERE AND NOT IN THE ROUTES
 * -----------------------------------------------
 * Every statement against the Arc schema is raw SQL in a template string, and
 * `tsc` cannot see into a string. When `prisma/schema.prisma` was replaced with
 * the Arc baseline, the API routes kept issuing the previous deployment's SQL
 * — inserting an `Account` keyed on `address` alone, with `collateral` and
 * `cancelledNonces` columns that no longer exist — and every check in CI stayed
 * green, because nothing type-checks a string.
 *
 * Putting each statement behind one exported, typed helper does not make the
 * SQL type-safe, but it makes the drift *testable*: there is one place per
 * table to point an integration test at, and that test runs the real statement
 * against a real Postgres holding the real schema. The next time the schema
 * moves, a test fails instead of production.
 *
 * Server-side only.
 */

import type { SqlClient } from "@/lib/sql";
import { displayFor, type MarketDisplay } from "@/lib/markets";
import type { ArcNetworkId } from "@/lib/network";

/**
 * `MarketParams` as the indexer stored it — the decoded `MarketParamsSet`
 * payload, normalised to JSON-safe values (see lib/indexer/decode.ts): int256
 * as a decimal string, uint16/uint32 as numbers, bool as bool.
 *
 * Every field is optional because this is whatever JSON the projection wrote.
 * A market listed but never parameterised has `params = {}`, and a params
 * struct that gains a field on chain must not break a client that predates it.
 */
export interface StoredMarketParams {
  oracleId?: string;
  initialMarginBps?: number;
  maintenanceMarginBps?: number;
  liquidationFeeBps?: number;
  maxExecutionDeviationBps?: number;
  maxOracleConfidenceBps?: number;
  maxOracleAge?: number;
  maxLeverageBps?: number;
  active?: boolean;
  listed?: boolean;
  maxOpenInterest?: string;
  minFillNotional?: string;
}

/** On-chain risk parameters, decoded. Absent fields become 0n / 0. */
export interface MarketRisk {
  initialMarginBps: number;
  maintenanceMarginBps: number;
  liquidationFeeBps: number;
  maxExecutionDeviationBps: number;
  maxOracleConfidenceBps: number;
  maxOracleAge: number;
  maxLeverageBps: number;
  /** Cap on long + short open interest, base units (1e18). */
  maxOpenInterest: bigint;
  /** Smallest fill the gateway settles, 1e18 USDC notional. */
  minFillNotional: bigint;
}

/** A market as the app sees it: chain state, plus how to render it. */
export interface Market extends MarketDisplay {
  network: ArcNetworkId;
  /** On-chain uint32 marketId. */
  marketId: number;
  /** bytes32 OracleAdapter feed id. */
  oracleId: string;
  active: boolean;
  risk: MarketRisk;
  /** Per-market fee rates from `MarketFeesSet` (signed, rate units). */
  makerRate: number;
  takerRate: number;
  /** 1e18 scale. */
  lastMark: bigint;
  lastIndex: bigint;
  longFundingIndex: bigint;
  shortFundingIndex: bigint;
  fundingRatePerHour: bigint;
  longOpenInterest: bigint;
  shortOpenInterest: bigint;
  updatedAt: Date;
}

/**
 * The row shape `SELECT *`-style queries below return.
 *
 * `Decimal(78, 0)` arrives from `pg` as a string, not a number: 1e18-scaled
 * values overflow IEEE-754 long before they overflow the column, so parsing
 * them as `number` would round real balances. Every one of them is declared
 * `string` here and converted with `BigInt`, never `Number`.
 */
interface MarketRow {
  network: string;
  id: number;
  symbol: string;
  oracleId: string;
  active: boolean;
  params: StoredMarketParams | null;
  makerRate: number;
  takerRate: number;
  lastMark: string;
  lastIndex: string;
  longFundingIndex: string;
  shortFundingIndex: string;
  fundingRatePerHour: string;
  longOpenInterest: string;
  shortOpenInterest: string;
  updatedAt: Date;
}

const COLUMNS = `"network", "id", "symbol", "oracleId", "active", "params", "makerRate", "takerRate",
  "lastMark", "lastIndex", "longFundingIndex", "shortFundingIndex", "fundingRatePerHour",
  "longOpenInterest", "shortOpenInterest", "updatedAt"`;

/** Parse a Decimal(78,0) column. Null/empty is 0, never NaN. */
function big(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  return BigInt(value);
}

function num(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function riskFromParams(params: StoredMarketParams | null | undefined): MarketRisk {
  const p = params ?? {};
  return {
    initialMarginBps: num(p.initialMarginBps),
    maintenanceMarginBps: num(p.maintenanceMarginBps),
    liquidationFeeBps: num(p.liquidationFeeBps),
    maxExecutionDeviationBps: num(p.maxExecutionDeviationBps),
    maxOracleConfidenceBps: num(p.maxOracleConfidenceBps),
    maxOracleAge: num(p.maxOracleAge),
    maxLeverageBps: num(p.maxLeverageBps),
    maxOpenInterest: big(p.maxOpenInterest),
    minFillNotional: big(p.minFillNotional),
  };
}

export function marketFromRow(row: MarketRow): Market {
  return {
    ...displayFor(row.symbol),
    // The database is authoritative for the symbol; `displayFor` only supplies
    // presentation. Spreading it first and overwriting here keeps a stale table
    // entry from renaming a market.
    symbol: row.symbol,
    network: row.network as ArcNetworkId,
    marketId: row.id,
    oracleId: row.oracleId,
    active: row.active,
    risk: riskFromParams(row.params),
    makerRate: row.makerRate,
    takerRate: row.takerRate,
    lastMark: big(row.lastMark),
    lastIndex: big(row.lastIndex),
    longFundingIndex: big(row.longFundingIndex),
    shortFundingIndex: big(row.shortFundingIndex),
    fundingRatePerHour: big(row.fundingRatePerHour),
    longOpenInterest: big(row.longOpenInterest),
    shortOpenInterest: big(row.shortOpenInterest),
    updatedAt: row.updatedAt,
  };
}

/** Every market the indexer has seen on `network`, listed or not. */
export async function listMarkets(sql: SqlClient, network: ArcNetworkId): Promise<Market[]> {
  const rows = await sql.query<MarketRow[]>(
    `SELECT ${COLUMNS} FROM "Market" WHERE "network" = $1 ORDER BY "id"`,
    [network]
  );
  return rows.map(marketFromRow);
}

/** Only the markets governance has activated — what the UI should offer. */
export async function listActiveMarkets(sql: SqlClient, network: ArcNetworkId): Promise<Market[]> {
  const rows = await sql.query<MarketRow[]>(
    `SELECT ${COLUMNS} FROM "Market" WHERE "network" = $1 AND "active" = true ORDER BY "id"`,
    [network]
  );
  return rows.map(marketFromRow);
}

export async function getMarketBySymbol(
  sql: SqlClient,
  network: ArcNetworkId,
  symbol: string
): Promise<Market | null> {
  const rows = await sql.query<MarketRow[]>(
    `SELECT ${COLUMNS} FROM "Market" WHERE "network" = $1 AND "symbol" = $2`,
    [network, symbol]
  );
  return rows.length > 0 ? marketFromRow(rows[0]) : null;
}

export async function getMarketById(
  sql: SqlClient,
  network: ArcNetworkId,
  marketId: number
): Promise<Market | null> {
  const rows = await sql.query<MarketRow[]>(
    `SELECT ${COLUMNS} FROM "Market" WHERE "network" = $1 AND "id" = $2`,
    [network, marketId]
  );
  return rows.length > 0 ? marketFromRow(rows[0]) : null;
}
