/**
 * Typed helpers for the `Order` table, and the one definition of an order's
 * remaining size.
 *
 * WHO OWNS WHAT
 * -------------
 * `Order.filledSize` and `Order.status` belong to the indexer:
 * `projections.refreshOrders` recomputes `filledSize` from SETTLED fills on
 * every `FillSettled` and rewrites `status` from it (leaving CANCELLED and
 * EXPIRED alone). The API writes `filledSize = 0` once, at insert, and the only
 * status it ever writes is CANCELLED — the best-effort off-chain cancel.
 *
 * REMAINING SIZE
 * --------------
 *     remaining = size − filledSize − Σ(size of PENDING fills on that order,
 *                                       excluding rows with a rejectReason)
 *
 * The PENDING rows are the matcher's in-flight reservation (see
 * lib/matcher/book.ts). A book or an open-orders view that ignored them would
 * show size the matcher has already committed, and the UI and the matcher
 * would disagree about what is still working. `pendingReservationSql` is the
 * statement both sides join against; the matcher's `loadOrders` uses it too.
 *
 * Server-side only.
 */

import type { ArcNetworkId } from "@/lib/network";
import type { Queryable } from "./client";
import { big } from "./scalars";

export type OrderStatus = "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "EXPIRED";

/** Statuses an order can still trade from. The matcher uses the same pair. */
export const LIVE_STATUSES: readonly OrderStatus[] = ["OPEN", "PARTIALLY_FILLED"];

/**
 * Per-order-hash size held by PENDING fills: `SELECT "orderHash", reserved`.
 *
 * A fill reserves size on both its maker and its taker order, hence the
 * lateral unpivot. A PENDING row carrying a `rejectReason` has been seen to
 * fail on chain and releases its size at once; only the indexer may move it to
 * REJECTED, so the reason is the signal.
 *
 * @param networkParam placeholder holding the network, e.g. `$1`
 * @param extraWhere   further predicates on `f`, starting with `AND`; must be
 *                     a constant string (never caller input)
 */
export function pendingReservationSql(networkParam: string, extraWhere = ""): string {
  return `SELECT h AS "orderHash", SUM(f."size") AS reserved
       FROM "Fill" f
       CROSS JOIN LATERAL (VALUES (f."makerOrderHash"), (f."takerOrderHash")) AS sides(h)
       WHERE f."network" = ${networkParam} AND f."status" = 'PENDING'
         AND f."rejectReason" IS NULL ${extraWhere}
       GROUP BY h`;
}

/** `size − filledSize − reserved`, floored at zero. */
export function remainingSize(size: bigint, filledSize: bigint, reserved: bigint): bigint {
  const r = size - filledSize - reserved;
  return r > 0n ? r : 0n;
}

export interface OrderView {
  orderHash: string;
  network: ArcNetworkId;
  owner: string;
  marketId: number;
  isLong: boolean;
  /** 1e18. */
  size: bigint;
  /** 1e18. */
  limitPrice: bigint;
  reduceOnly: boolean;
  nonce: bigint;
  /** Unix seconds. */
  expiry: bigint;
  referrer: string | null;
  status: OrderStatus;
  /** Settled size, from the indexer. 1e18. */
  filledSize: bigint;
  /** Size reserved by PENDING fills. 1e18. */
  pendingSize: bigint;
  /** What is still available to match. 1e18. */
  remainingSize: bigint;
  /** `Account.minValidNonce` for the owner; an order below it is dead on chain. */
  minValidNonce: bigint;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = `SELECT
       o."orderHash", o."network", o."owner", o."marketId", o."isLong",
       o."size"::text AS "size", o."limitPrice"::text AS "limitPrice", o."reduceOnly",
       o."nonce"::text AS "nonce", o."expiry"::text AS "expiry", o."referrer", o."status",
       o."filledSize"::text AS "filledSize", COALESCE(p.reserved, 0)::text AS "pendingSize",
       COALESCE(a."minValidNonce", 0)::text AS "minValidNonce",
       o."createdAt", o."updatedAt"`;

/**
 * What "working" means, identically to `matchOrders`' eligibility filter: a
 * live status, not yet expired, not under the owner's `minValidNonce`, and
 * size left after the PENDING reservation. (Reduce-only orders also depend on
 * the owner's position, which a listing does not model.)
 */
const WORKING = `AND o."status" = ANY('{OPEN,PARTIALLY_FILLED}'::"OrderStatus"[])
       AND o."expiry" > $NOW
       AND o."nonce" >= COALESCE(a."minValidNonce", 0)
       AND o."size" - o."filledSize" - COALESCE(p.reserved, 0) > 0`;

export function orderFromRow(r: Record<string, unknown>): OrderView {
  const size = big(r.size);
  const filledSize = big(r.filledSize);
  const pendingSize = big(r.pendingSize);
  return {
    orderHash: String(r.orderHash),
    network: String(r.network) as ArcNetworkId,
    owner: String(r.owner),
    marketId: Number(r.marketId),
    isLong: r.isLong === true,
    size,
    limitPrice: big(r.limitPrice),
    reduceOnly: r.reduceOnly === true,
    nonce: big(r.nonce),
    expiry: big(r.expiry),
    referrer: r.referrer === null || r.referrer === undefined ? null : String(r.referrer),
    status: String(r.status) as OrderStatus,
    filledSize,
    pendingSize,
    remainingSize: remainingSize(size, filledSize, pendingSize),
    minValidNonce: big(r.minValidNonce),
    createdAt: new Date(r.createdAt as string),
    updatedAt: new Date(r.updatedAt as string),
  };
}

export interface OwnerOrdersQuery {
  /** `working` (default) applies the matcher's eligibility; `all` returns history. */
  scope: "working" | "all";
  marketId: number | null;
  limit: number;
  nowSec: bigint;
}

/** One account's orders, newest first. */
export async function listOrdersForOwner(
  q: Queryable,
  network: ArcNetworkId,
  owner: string,
  opts: OwnerOrdersQuery
): Promise<OrderView[]> {
  const working = opts.scope === "working";
  const params: unknown[] = [network, owner, opts.marketId, opts.limit];
  if (working) params.push(opts.nowSec.toString());
  const rows = await q.query(
    `${SELECT}
     FROM "Order" o
     LEFT JOIN (${pendingReservationSql("$1", `AND (f."maker" = $2 OR f."taker" = $2)`)}) p
       ON p."orderHash" = o."orderHash"
     LEFT JOIN "Account" a ON a."network" = o."network" AND a."address" = o."owner"
     WHERE o."network" = $1 AND o."owner" = $2
       AND ($3::int IS NULL OR o."marketId" = $3::int)
       ${working ? WORKING.replace("$NOW", "$5") : ""}
     ORDER BY o."createdAt" DESC, o."orderHash" DESC
     LIMIT $4`,
    params
  );
  return rows.map(orderFromRow);
}

/** Every working order in one market — the public book, before aggregation. */
export async function listWorkingOrdersForMarket(
  q: Queryable,
  network: ArcNetworkId,
  marketId: number,
  nowSec: bigint
): Promise<OrderView[]> {
  const rows = await q.query(
    `${SELECT}
     FROM "Order" o
     LEFT JOIN (${pendingReservationSql("$1", `AND f."marketId" = $2`)}) p
       ON p."orderHash" = o."orderHash"
     LEFT JOIN "Account" a ON a."network" = o."network" AND a."address" = o."owner"
     WHERE o."network" = $1 AND o."marketId" = $2
       ${WORKING.replace("$NOW", "$3")}
     ORDER BY o."createdAt" ASC, o."orderHash" ASC`,
    [network, marketId, nowSec.toString()]
  );
  return rows.map(orderFromRow);
}

export async function getOrderByHash(
  q: Queryable,
  network: ArcNetworkId,
  orderHash: string
): Promise<OrderView | null> {
  const rows = await q.query(
    `${SELECT}
     FROM "Order" o
     LEFT JOIN (${pendingReservationSql("$1")}) p ON p."orderHash" = o."orderHash"
     LEFT JOIN "Account" a ON a."network" = o."network" AND a."address" = o."owner"
     WHERE o."network" = $1 AND o."orderHash" = $2`,
    [network, orderHash]
  );
  return rows.length > 0 ? orderFromRow(rows[0]) : null;
}

export interface BookLevel {
  /** 1e18. */
  price: bigint;
  /** Σ remaining size at this price, 1e18. */
  size: bigint;
  orders: number;
}

/**
 * Aggregate working orders into price levels: bids best (highest) first, asks
 * best (lowest) first. Sizes are remaining sizes, never gross order sizes.
 */
export function aggregateBook(orders: readonly OrderView[]): { bids: BookLevel[]; asks: BookLevel[] } {
  const bids = new Map<bigint, BookLevel>();
  const asks = new Map<bigint, BookLevel>();
  for (const o of orders) {
    if (o.remainingSize <= 0n) continue;
    const side = o.isLong ? bids : asks;
    const level = side.get(o.limitPrice) ?? { price: o.limitPrice, size: 0n, orders: 0 };
    level.size += o.remainingSize;
    level.orders += 1;
    side.set(o.limitPrice, level);
  }
  const desc = (a: BookLevel, b: BookLevel) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0);
  return {
    bids: [...bids.values()].sort(desc),
    asks: [...asks.values()].sort((a, b) => desc(b, a)),
  };
}

export interface CancelledOrder {
  orderHash: string;
  nonce: bigint;
}

/**
 * Best-effort off-chain cancel of one order: it stops the matcher picking the
 * order up. It is NOT authoritative — the signed order stays valid on chain
 * until `cancelOrder`/`cancelUpTo` is mined, and a fill already PENDING may
 * still settle. Only live orders move; CANCELLED survives the indexer's
 * `refreshOrders`.
 */
export async function cancelOrderByNonce(
  q: Queryable,
  network: ArcNetworkId,
  owner: string,
  nonce: bigint
): Promise<CancelledOrder[]> {
  const rows = await q.query(
    `UPDATE "Order" SET "status" = 'CANCELLED', "updatedAt" = now()
     WHERE "network" = $1 AND "owner" = $2 AND "nonce" = $3
       AND "status" = ANY('{OPEN,PARTIALLY_FILLED}'::"OrderStatus"[])
     RETURNING "orderHash", "nonce"::text AS "nonce"`,
    [network, owner, nonce.toString()]
  );
  return rows.map((r) => ({ orderHash: String(r.orderHash), nonce: big(r.nonce) }));
}

/** Best-effort cancel of every live, unexpired order, optionally in one market. */
export async function cancelAllOrders(
  q: Queryable,
  network: ArcNetworkId,
  owner: string,
  marketId: number | null,
  nowSec: bigint
): Promise<CancelledOrder[]> {
  const rows = await q.query(
    `UPDATE "Order" SET "status" = 'CANCELLED', "updatedAt" = now()
     WHERE "network" = $1 AND "owner" = $2
       AND ($3::int IS NULL OR "marketId" = $3::int)
       AND "status" = ANY('{OPEN,PARTIALLY_FILLED}'::"OrderStatus"[])
       AND "expiry" > $4
     RETURNING "orderHash", "nonce"::text AS "nonce"`,
    [network, owner, marketId, nowSec.toString()]
  );
  return rows.map((r) => ({ orderHash: String(r.orderHash), nonce: big(r.nonce) }));
}

// ── Intake ───────────────────────────────────────────────────────────────────

export interface NewOrder {
  orderHash: string;
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  reduceOnly: boolean;
  nonce: bigint;
  expiry: bigint;
  /** Lowercase; null for the zero address (no referrer). */
  referrer: string | null;
  /** Lowercase 0x hex. */
  signature: string;
}

export type InsertOrderResult = "inserted" | "duplicate" | "nonce_reused";

/**
 * Store a validated order: create the `Account` row if this is the owner's
 * first appearance, and insert the `Order` as OPEN with `filledSize = 0` —
 * the only time the API writes either field.
 *
 * One statement, so one transaction: the account upsert runs in a CTE and the
 * order's foreign key sees it when the statement's constraints are checked.
 *
 * Keyed on the EIP-712 order hash, so resubmitting the identical signed order
 * is an idempotent no-op (`duplicate`) rather than a second row. A DIFFERENT
 * order under an (owner, nonce) already taken is `nonce_reused`: the gateway
 * binds a nonce to the first digest that fills, so the second could never
 * settle.
 */
export async function insertOrder(q: Queryable, network: ArcNetworkId, o: NewOrder): Promise<InsertOrderResult> {
  try {
    const rows = await q.query(
      `WITH account AS (
         INSERT INTO "Account" ("network", "address", "updatedAt") VALUES ($1, $2, now())
         ON CONFLICT ("network", "address") DO NOTHING
       )
       INSERT INTO "Order" ("orderHash", "network", "owner", "marketId", "isLong", "size", "limitPrice",
         "reduceOnly", "nonce", "expiry", "referrer", "signature", "status", "filledSize", "updatedAt")
       VALUES ($3, $1, $2, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'OPEN', 0, now())
       ON CONFLICT ("orderHash") DO NOTHING
       RETURNING "orderHash"`,
      [
        network,
        o.owner,
        o.orderHash,
        o.marketId,
        o.isLong,
        o.size.toString(),
        o.limitPrice.toString(),
        o.reduceOnly,
        o.nonce.toString(),
        o.expiry.toString(),
        o.referrer,
        o.signature,
      ]
    );
    return rows.length > 0 ? "inserted" : "duplicate";
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === "23505" && e.constraint === "Order_network_owner_nonce_key") return "nonce_reused";
    throw err;
  }
}
