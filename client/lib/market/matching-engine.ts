/**
 * The price-time matching engine: pure, deterministic, no I/O.
 *
 * Ported from the old chain's `matchAll` (scripts/matcher-service.ts on
 * Stellar) with four changes forced by the Arc contracts:
 *
 *   - Sizes and prices are 1e18 throughout. The old engine used 1e7 amounts.
 *   - There are no market orders. `OrderGateway._consume` reverts
 *     `InvalidAmount` on `limitPrice == 0`, so an order with no limit can never
 *     settle; the old engine's market-order pass is gone.
 *   - The aggressor is the taker. The old engine picked the maker by
 *     `createdAt` regardless of who crossed whom; here the order that rested
 *     first is the maker and its limit is the execution price, which is what
 *     the book displayed to the trader who crossed it.
 *   - `reduceOnly` is checked against the trader's position, because
 *     `Engine._trade` reverts `PositionNotFound` when a reduce-only fill would
 *     open or grow one and `InvalidAmount` when it would overshoot the close.
 *
 * Every rule below has an on-chain counterpart that would reject the fill. A
 * match this module emits should settle; matching something the gateway will
 * refuse costs a transaction and produces a `FillRejected` for nothing.
 *
 * Safe to import anywhere: no database, no network, no clock.
 */

import type { Address, Hex } from "viem";

/** 1e18, the protocol's internal fixed-point scale. */
export const PRECISION = 10n ** 18n;

/** `OrderGateway.MAX_ORDER_TTL`: 7 days, in seconds. */
export const MAX_ORDER_TTL_SECONDS = 7n * 24n * 60n * 60n;

/** One resting order, as the engine sees it. */
export interface EngineOrder {
  /** EIP-712 digest; the engine's identity for the order and its final tiebreak. */
  orderHash: Hex;
  /** Lowercase. */
  owner: Address;
  marketId: number;
  isLong: boolean;
  /** 1e18. */
  size: bigint;
  /** 1e18, always > 0. */
  limitPrice: bigint;
  reduceOnly: boolean;
  nonce: bigint;
  /** Unix seconds. */
  expiry: bigint;
  /** 1e18: settled plus already reserved by pending fills. */
  filledSize: bigint;
  /** Milliseconds since the epoch; the time half of price-time priority. */
  createdAt: number;
}

export interface EngineInput {
  marketId: number;
  /** Injected clock, unix seconds. */
  nowSec: bigint;
  orders: readonly EngineOrder[];
  /**
   * Signed net position in this market per owner (lowercase), 1e18. Absent
   * means flat. Only reduce-only orders consult it.
   */
  positions: ReadonlyMap<string, bigint>;
  /** `Account.minValidNonce` per owner (lowercase). Absent means 0. */
  minValidNonce: ReadonlyMap<string, bigint>;
  /** `MarketParams.minFillNotional`, 1e18 USDC notional. */
  minFillNotional: bigint;
  /**
   * Whether a fill may execute at this price. The runtime passes the oracle
   * execution band; the engine itself has no opinion about prices.
   *
   * Only the maker's price is tested, because that is the execution price. An
   * order whose own limit is outside the band can still cross as the taker —
   * it just cannot set the price. Testing it here rather than dropping the
   * matches afterwards is what stops an unsettleable top-of-book quote from
   * absorbing a taker's whole size and starving the orders behind it: the
   * taker walks past it to the next maker.
   */
  acceptPrice?: (price: bigint) => boolean;
}

export interface EngineMatch {
  maker: EngineOrder;
  taker: EngineOrder;
  /** 1e18. */
  size: bigint;
  /** 1e18; always the maker's limit price. */
  price: bigint;
  /** `size * price / 1e18`, the value the gateway checks against minFillNotional. */
  notional: bigint;
  /** 0-based index among matches sharing (maker, taker, size, price) in this run. */
  sequence: number;
}

export type SkipReason =
  | "expired"
  | "stale-nonce"
  | "fully-filled"
  | "self-trade"
  | "reduce-only-no-position"
  | "below-min-notional"
  | "price-not-acceptable";

export interface EngineSkip {
  reason: SkipReason;
  orderHash: Hex;
  /** Set when the skip concerns a pair rather than a single order. */
  counterpartyHash?: Hex;
}

export interface EngineResult {
  matches: EngineMatch[];
  /** Why orders did not trade. Metrics and logs only; not a control signal. */
  skipped: EngineSkip[];
}

/** `size * price / 1e18`, matching `KryonMath.mulPrecision`. */
export function notionalOf(size: bigint, price: bigint): bigint {
  return (size * price) / PRECISION;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const abs = (v: bigint) => (v < 0n ? -v : v);

/** Total ordering by (price, createdAt, orderHash); §3.2. */
function compare(a: EngineOrder, b: EngineOrder, priceAscending: boolean): number {
  if (a.limitPrice !== b.limitPrice) {
    const cheaperFirst = a.limitPrice < b.limitPrice ? -1 : 1;
    return priceAscending ? cheaperFirst : -cheaperFirst;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.orderHash < b.orderHash ? -1 : a.orderHash > b.orderHash ? 1 : 0;
}

/**
 * Tracks what each order and each trader has committed to during one run, so
 * the same liquidity and the same position are never sold twice.
 */
class Ledger {
  private readonly reserved = new Map<Hex, bigint>();
  private readonly closed = new Map<string, bigint>();

  constructor(private readonly positions: ReadonlyMap<string, bigint>) {}

  remaining(o: EngineOrder): bigint {
    return o.size - o.filledSize - (this.reserved.get(o.orderHash) ?? 0n);
  }

  /**
   * How much of `o` may fill, once reduce-only is applied. A reduce-only order
   * can only close, and only as much as is left of the position after the
   * closes already booked in this run.
   */
  fillable(o: EngineOrder): bigint {
    const remaining = this.remaining(o);
    if (!o.reduceOnly || remaining <= 0n) return remaining;
    const position = this.positions.get(o.owner) ?? 0n;
    // A buy reduces only a short, a sell only a long.
    if (position === 0n || o.isLong === position > 0n) return 0n;
    const key = `${o.owner}:${o.marketId}`;
    const headroom = abs(position) - (this.closed.get(key) ?? 0n);
    return headroom <= 0n ? 0n : min(remaining, headroom);
  }

  book(o: EngineOrder, size: bigint): void {
    this.reserved.set(o.orderHash, (this.reserved.get(o.orderHash) ?? 0n) + size);
    if (!o.reduceOnly) return;
    const key = `${o.owner}:${o.marketId}`;
    this.closed.set(key, (this.closed.get(key) ?? 0n) + size);
  }
}

/**
 * Match a book. The result is a function of the input alone, so a rerun after
 * a crash produces the same matches in the same order — which is what makes
 * the derived fill ids stable.
 */
export function matchOrders(input: EngineInput): EngineResult {
  const { marketId, nowSec, minFillNotional } = input;
  const skipped: EngineSkip[] = [];
  const ledger = new Ledger(input.positions);

  const eligible: EngineOrder[] = [];
  for (const o of input.orders) {
    if (o.marketId !== marketId) continue;
    // `_consume` reverts `OrderExpired` both when the order has lapsed
    // (`timestamp > expiry`) and when it was signed more than MAX_ORDER_TTL
    // ahead. `expiry == nowSec` is still valid on-chain, but it cannot survive
    // the trip to a block, so the engine treats it as gone.
    if (o.expiry <= nowSec || o.expiry > nowSec + MAX_ORDER_TTL_SECONDS) {
      skipped.push({ reason: "expired", orderHash: o.orderHash });
      continue;
    }
    if (o.nonce < (input.minValidNonce.get(o.owner) ?? 0n)) {
      skipped.push({ reason: "stale-nonce", orderHash: o.orderHash });
      continue;
    }
    if (o.size - o.filledSize <= 0n) {
      skipped.push({ reason: "fully-filled", orderHash: o.orderHash });
      continue;
    }
    if (o.reduceOnly && ledger.fillable(o) <= 0n) {
      skipped.push({ reason: "reduce-only-no-position", orderHash: o.orderHash });
      continue;
    }
    eligible.push(o);
  }

  const bids = eligible.filter((o) => o.isLong).sort((a, b) => compare(a, b, false));
  const asks = eligible.filter((o) => !o.isLong).sort((a, b) => compare(a, b, true));

  const matches: EngineMatch[] = [];
  const sequences = new Map<string, number>();

  for (const bid of bids) {
    for (const ask of asks) {
      // Asks are cheapest first: once one is above the bid, so is every later one.
      if (bid.limitPrice < ask.limitPrice) break;
      if (ledger.remaining(bid) <= 0n) break;

      if (bid.owner === ask.owner) {
        // §3.3: skip the pair, leave both resting. The gateway reverts
        // `SelfTrade` on this, so a match here would be a wasted fill.
        skipped.push({ reason: "self-trade", orderHash: bid.orderHash, counterpartyHash: ask.orderHash });
        continue;
      }

      const bidFillable = ledger.fillable(bid);
      const askFillable = ledger.fillable(ask);
      if (bidFillable <= 0n || askFillable <= 0n) continue;

      // The order that rested first is the maker and sets the price.
      const bidFirst = compareArrival(bid, ask) <= 0;
      const maker = bidFirst ? bid : ask;
      const taker = bidFirst ? ask : bid;
      const price = maker.limitPrice;

      if (input.acceptPrice && !input.acceptPrice(price)) {
        // The maker cannot set this price. Move on without reserving anything,
        // so the taker's size stays available for the next maker down the book.
        skipped.push({
          reason: "price-not-acceptable",
          orderHash: maker.orderHash,
          counterpartyHash: taker.orderHash,
        });
        continue;
      }

      const size = min(bidFillable, askFillable);

      // Dust: a fill below minFillNotional reverts `FillBelowMinNotional`. If
      // the whole match is too small, leave both orders resting; they may pair
      // with something larger later.
      if (notionalOf(size, price) < minFillNotional) {
        skipped.push({
          reason: "below-min-notional",
          orderHash: maker.orderHash,
          counterpartyHash: taker.orderHash,
        });
        continue;
      }

      // A partial fill that leaves a sub-minimum remainder on one side is
      // fine: the remainder rests rather than becoming a dust fill, and the
      // check above already held the fill itself above the floor.
      const key = `${maker.orderHash}:${taker.orderHash}:${size}:${price}`;
      const sequence = sequences.get(key) ?? 0;
      sequences.set(key, sequence + 1);

      ledger.book(bid, size);
      ledger.book(ask, size);
      matches.push({ maker, taker, size, price, notional: notionalOf(size, price), sequence });
    }
  }

  return { matches, skipped };
}

/** Arrival order: createdAt, then orderHash. Ties never decide by price here. */
function compareArrival(a: EngineOrder, b: EngineOrder): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.orderHash < b.orderHash ? -1 : a.orderHash > b.orderHash ? 1 : 0;
}
