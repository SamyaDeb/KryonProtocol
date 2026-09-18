/**
 * Loading one market's book, positions and parameters (plan §4.2.1).
 *
 * The important subtlety is who owns `Order.filledSize`. The indexer does:
 * `projections.refreshOrders` recomputes it as the sum of SETTLED fills on
 * every `FillSettled` and rewrites `status` from that. So the matcher must
 * treat it as read-only, and carry its own in-flight reservation separately —
 * otherwise the next settled fill in the market silently erases the
 * reservation and the same size is matched a second time.
 *
 * The reservation ledger is the PENDING `Fill` rows themselves. They are keyed
 * `(network, fillId)` on a deterministic id, so they survive a crash and
 * replay idempotently:
 *
 *     remaining = size - filledSize - Σ(size of PENDING fills on this order)
 *
 * A PENDING row with a `rejectReason` is excluded: the matcher saw the chain
 * reject that fill and wrote the reason, but only the indexer may move the row
 * to REJECTED. The reason is the matcher's way of releasing the size at once
 * without touching a status it does not own.
 *
 * Server-side only.
 */

import { getAddress, type Address, type Hex } from "viem";

import type { EngineOrder } from "@/lib/market/matching-engine";
// The reservation statement is shared with the API's order and book views, so
// the matcher and the UI cannot disagree about what is still working.
import { pendingReservationSql } from "@/lib/queries/orders";
import type { Query, Row } from "./db";

/** Everything one tick needs about a market, from `Market`. */
export interface MarketConfig {
  marketId: number;
  symbol: string;
  /** bytes32 feed id, as `RiskParams` holds it. */
  oracleId: Hex;
  active: boolean;
  /** 1e18 USDC notional; `OrderGateway._checkNotional` compares against this. */
  minFillNotional: bigint;
  /** `Engine.applyFill` rejects a price outside ±this around the index. */
  maxExecutionDeviationBps: number;
  /** Seconds; passed to `OracleAdapter.getPrice` so the matcher sees what the Engine sees. */
  maxOracleAge: number;
  maxOracleConfidenceBps: number;
}

export interface Book {
  market: MarketConfig;
  orders: EngineOrder[];
  /** Signed net position per owner in this market, 1e18. */
  positions: Map<string, bigint>;
  /** `Account.minValidNonce` per owner. */
  minValidNonce: Map<string, bigint>;
}

/** Statuses an order can still trade from. */
const TRADEABLE = ["OPEN", "PARTIALLY_FILLED"] as const;

export class MarketNotConfiguredError extends Error {
  constructor(network: string, marketId: number, detail: string) {
    super(`market ${marketId} on ${network} is not ready to match: ${detail}`);
  }
}

/**
 * Market parameters as the indexer stored them from `MarketParamsSet`
 * (bigints as decimal strings). An unset `params` means the matcher has never
 * seen the market configured and must not guess at a notional floor or a band.
 */
export async function loadMarket(q: Query, network: string, marketId: number): Promise<MarketConfig> {
  const rows = await q.query(
    `SELECT "symbol", "oracleId", "active", "params" FROM "Market" WHERE "network" = $1 AND "id" = $2`,
    [network, marketId]
  );
  if (rows.length === 0) throw new MarketNotConfiguredError(network, marketId, "no Market row");
  const row = rows[0];
  const params = (row.params ?? {}) as Record<string, unknown>;

  const num = (key: string): number => {
    const raw = params[key];
    if (raw === undefined || raw === null) {
      throw new MarketNotConfiguredError(network, marketId, `Market.params has no "${key}"`);
    }
    return Number(raw);
  };
  const big = (key: string): bigint => {
    const raw = params[key];
    if (raw === undefined || raw === null) {
      throw new MarketNotConfiguredError(network, marketId, `Market.params has no "${key}"`);
    }
    return BigInt(String(raw));
  };

  const minFillNotional = big("minFillNotional");
  if (minFillNotional < 0n) {
    throw new MarketNotConfiguredError(network, marketId, `negative minFillNotional ${minFillNotional}`);
  }
  const maxExecutionDeviationBps = num("maxExecutionDeviationBps");
  if (maxExecutionDeviationBps <= 0) {
    throw new MarketNotConfiguredError(network, marketId, "maxExecutionDeviationBps is 0; every fill would reject");
  }

  return {
    marketId,
    symbol: String(row.symbol),
    oracleId: String(params.oracleId ?? row.oracleId) as Hex,
    active: row.active === true,
    minFillNotional,
    maxExecutionDeviationBps,
    maxOracleAge: num("maxOracleAge"),
    maxOracleConfidenceBps: num("maxOracleConfidenceBps"),
  };
}

/**
 * The resting book for one market, with the reservation held by PENDING fills
 * already netted off each order.
 */
export async function loadOrders(
  q: Query,
  network: string,
  marketId: number,
  nowSec: bigint
): Promise<EngineOrder[]> {
  const rows = await q.query(
    `SELECT
       o."orderHash", o."owner", o."marketId", o."isLong",
       o."size"::text AS size, o."limitPrice"::text AS "limitPrice",
       o."reduceOnly", o."nonce"::text AS nonce, o."expiry",
       o."filledSize"::text AS "filledSize", o."createdAt",
       COALESCE(p.reserved, 0)::text AS reserved
     FROM "Order" o
     LEFT JOIN (${pendingReservationSql("$1", `AND f."marketId" = $2`)}) p
       ON p."orderHash" = o."orderHash"
     WHERE o."network" = $1
       AND o."marketId" = $2
       AND o."status" = ANY($3::"OrderStatus"[])
       AND o."expiry" > $4
     ORDER BY o."createdAt" ASC, o."orderHash" ASC`,
    [network, marketId, [...TRADEABLE], nowSec.toString()]
  );
  return rows.map(toEngineOrder);
}

function toEngineOrder(r: Row): EngineOrder {
  // `filledSize` is the indexer's settled total; `reserved` is what this
  // matcher has already committed but not yet seen settle. The engine's
  // `filledSize` is the sum, which is what "not available to match" means.
  const settled = BigInt(String(r.filledSize));
  const reserved = BigInt(String(r.reserved));
  return {
    orderHash: String(r.orderHash) as Hex,
    owner: String(r.owner) as Address,
    marketId: Number(r.marketId),
    isLong: r.isLong === true,
    size: BigInt(String(r.size)),
    limitPrice: BigInt(String(r.limitPrice)),
    reduceOnly: r.reduceOnly === true,
    nonce: BigInt(String(r.nonce)),
    expiry: BigInt(String(r.expiry)),
    filledSize: settled + reserved,
    createdAt: new Date(String(r.createdAt)).getTime(),
  };
}

/** Signed net positions in one market for the owners on the book. */
export async function loadPositions(
  q: Query,
  network: string,
  marketId: number,
  owners: readonly string[]
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (owners.length === 0) return out;
  const rows = await q.query(
    `SELECT "trader", "size"::text AS size FROM "Position"
     WHERE "network" = $1 AND "marketId" = $2 AND "trader" = ANY($3::text[])`,
    [network, marketId, [...new Set(owners)]]
  );
  for (const r of rows) out.set(String(r.trader), BigInt(String(r.size)));
  return out;
}

/** `Account.minValidNonce` for the owners on the book; absent means 0. */
export async function loadMinValidNonces(
  q: Query,
  network: string,
  owners: readonly string[]
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (owners.length === 0) return out;
  const rows = await q.query(
    `SELECT "address", "minValidNonce"::text AS "minValidNonce" FROM "Account"
     WHERE "network" = $1 AND "address" = ANY($2::text[])`,
    [network, [...new Set(owners)]]
  );
  for (const r of rows) out.set(String(r.address), BigInt(String(r.minValidNonce)));
  return out;
}

/** One market's complete engine input. */
export async function loadBook(q: Query, network: string, marketId: number, nowSec: bigint): Promise<Book> {
  const market = await loadMarket(q, network, marketId);
  const orders = await loadOrders(q, network, marketId, nowSec);
  const owners = orders.map((o) => o.owner);
  const [positions, minValidNonce] = await Promise.all([
    loadPositions(q, network, marketId, owners),
    loadMinValidNonces(q, network, owners),
  ]);
  return { market, orders, positions, minValidNonce };
}

/**
 * The signed order and its signature, as `settleFillsSigned` needs them.
 * Addresses come back checksummed: the database stores them lowercase, but
 * viem's encoder wants the EIP-55 form.
 */
export interface SignedOrderRow {
  orderHash: Hex;
  owner: Address;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  reduceOnly: boolean;
  nonce: bigint;
  expiry: bigint;
  referrer: Address;
  signature: Hex;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** Signed orders by hash, for the batch builder. */
export async function loadSignedOrders(
  q: Query,
  network: string,
  hashes: readonly Hex[]
): Promise<Map<Hex, SignedOrderRow>> {
  const out = new Map<Hex, SignedOrderRow>();
  if (hashes.length === 0) return out;
  const rows = await q.query(
    `SELECT "orderHash", "owner", "marketId", "isLong",
            "size"::text AS size, "limitPrice"::text AS "limitPrice",
            "reduceOnly", "nonce"::text AS nonce, "expiry", "referrer", "signature"
     FROM "Order" WHERE "network" = $1 AND "orderHash" = ANY($2::text[])`,
    [network, [...new Set(hashes)]]
  );
  for (const r of rows) {
    out.set(String(r.orderHash) as Hex, {
      orderHash: String(r.orderHash) as Hex,
      owner: getAddress(String(r.owner)),
      marketId: Number(r.marketId),
      isLong: r.isLong === true,
      size: BigInt(String(r.size)),
      limitPrice: BigInt(String(r.limitPrice)),
      reduceOnly: r.reduceOnly === true,
      nonce: BigInt(String(r.nonce)),
      expiry: BigInt(String(r.expiry)),
      referrer: r.referrer ? getAddress(String(r.referrer)) : ZERO_ADDRESS,
      signature: String(r.signature) as Hex,
    });
  }
  return out;
}
