/**
 * The order ticket's arithmetic and checks, as one pure function.
 *
 * Order intake verifies the signature, expiry, market and nonce floor, but not
 * margin or the fill minimum: those the contracts enforce at settlement, where
 * a failure is a REJECTED fill after the user thought they had traded. So the
 * ticket checks them first, with the contracts' own formulas (lib/math.ts),
 * and says plainly why an order cannot go.
 *
 * Every figure is a preview. The margin check holds the account's other
 * positions at the index price and ignores unsettled funding, so it can pass
 * an order that settlement then rejects (or block one near the edge); the
 * contract's answer is final either way.
 *
 * All amounts bigint: prices, sizes and USD at 1e18, rates in millionths.
 */

import { applyFill, feeFor, liquidationPrice, marginAt, notional, type PositionState } from "@/lib/math";

export type Side = "buy" | "sell";
export type OrderKind = "market" | "limit";

export interface TicketMarket {
  active: boolean;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  /** 1e18 USD: the gateway rejects smaller fills. */
  minFillNotional: bigint;
}

export interface TicketHealth {
  equity: bigint;
  initialMarginRequired: bigint;
  maintenanceMarginRequired: bigint;
}

export interface TicketInput {
  market: TicketMarket;
  side: Side;
  kind: OrderKind;
  /** Base size, 1e18; null while the field is empty or invalid. */
  size: bigint | null;
  /** Limit orders only, 1e18. */
  limitPrice: bigint | null;
  /** Market orders: how far past the reference price the order may fill, in bps. */
  slippageBps: number;
  reduceOnly: boolean;
  postOnly: boolean;
  bestBid: bigint | null;
  bestAsk: bigint | null;
  /** Oracle index, 1e18: what margin is computed against. */
  indexPrice: bigint;
  /** The account's position in this market (size 0 when flat). */
  position: PositionState;
  /** Engine.accountHealth, or null when not connected / not read yet. */
  health: TicketHealth | null;
  /** The account's effective rates for this market, millionths. */
  makerRate: number;
  takerRate: number;
}

export type TicketError =
  | "market_inactive"
  | "no_size"
  | "no_price"
  | "no_reference_price"
  | "below_min_notional"
  | "post_only_would_cross"
  | "reduce_only_no_position"
  | "reduce_only_wrong_side"
  | "reduce_only_too_large"
  | "insufficient_margin";

export interface TicketResult {
  /** The limitPrice to sign: the typed limit, or the slippage-bounded aggressive price. */
  limitPrice: bigint | null;
  /** Where it is expected to fill: the best opposite price when crossing, else the limit. */
  execPrice: bigint | null;
  crosses: boolean;
  notional: bigint;
  /** Signed fee estimate, 1e18: taker when crossing, maker (maybe a rebate) when resting. */
  fee: bigint;
  /** Initial margin the order's own notional needs. */
  orderMargin: bigint;
  positionAfter: PositionState;
  /** Estimated index price at which the account is liquidated after this fill. */
  liquidationPrice: bigint | null;
  /** Equity left above initial margin after the fill; negative blocks the order. */
  marginHeadroom: bigint | null;
  errors: TicketError[];
}

export const TICKET_ERROR_TEXT: Record<TicketError, string> = {
  market_inactive: "This market is paused: it accepts no new exposure.",
  no_size: "Enter a size.",
  no_price: "Enter a limit price.",
  no_reference_price: "No price to trade against yet: the book is empty and the oracle has not published.",
  below_min_notional: "Below this market's minimum fill size.",
  post_only_would_cross: "Post-only: this price would trade immediately.",
  reduce_only_no_position: "Reduce-only needs an open position in this market.",
  reduce_only_wrong_side: "Reduce-only must trade against your position.",
  reduce_only_too_large: "Reduce-only size is larger than your position.",
  insufficient_margin: "Not enough free collateral for this order's initial margin.",
};

const BPS = 10_000n;
const abs = (x: bigint) => (x < 0n ? -x : x);

export function evaluateTicket(x: TicketInput): TicketResult {
  const errors: TicketError[] = [];
  const buy = x.side === "buy";
  const delta = x.size === null ? 0n : buy ? x.size : -x.size;

  // ── Price ──
  let limitPrice: bigint | null = null;
  if (x.kind === "limit") {
    limitPrice = x.limitPrice !== null && x.limitPrice > 0n ? x.limitPrice : null;
    if (limitPrice === null) errors.push("no_price");
  } else {
    const reference = (buy ? x.bestAsk : x.bestBid) ?? (x.indexPrice > 0n ? x.indexPrice : null);
    if (reference === null) errors.push("no_reference_price");
    else {
      const slip = BigInt(Math.max(0, Math.round(x.slippageBps)));
      limitPrice = buy ? (reference * (BPS + slip)) / BPS : (reference * (BPS - slip)) / BPS;
      if (limitPrice <= 0n) limitPrice = 1n;
    }
  }
  const opposite = buy ? x.bestAsk : x.bestBid;
  const crosses = limitPrice !== null && opposite !== null && (buy ? limitPrice >= opposite : limitPrice <= opposite);
  // A crossing order fills at the resting price (the maker's); a resting one at its own limit.
  const execPrice = limitPrice === null ? null : crosses ? opposite : limitPrice;

  // ── Market and size ──
  if (!x.market.active && !x.reduceOnly) errors.push("market_inactive");
  if (x.size === null || x.size <= 0n) errors.push("no_size");
  if (x.postOnly && x.kind === "limit" && crosses) errors.push("post_only_would_cross");

  const orderNotional = execPrice !== null && x.size !== null ? notional(x.size, execPrice) : 0n;
  if (orderNotional > 0n && orderNotional < x.market.minFillNotional) errors.push("below_min_notional");

  // ── Reduce-only ──
  const pos = x.position;
  if (x.reduceOnly && x.size !== null && x.size > 0n) {
    if (pos.size === 0n) errors.push("reduce_only_no_position");
    else if (pos.size > 0n === buy) errors.push("reduce_only_wrong_side");
    else if (x.size > abs(pos.size)) errors.push("reduce_only_too_large");
  }

  // ── Fee, position after, margin ──
  const rate = BigInt(crosses ? x.takerRate : x.makerRate);
  const fee = orderNotional > 0n ? feeFor(orderNotional, rate) : 0n;
  const orderMargin = (orderNotional * BigInt(x.market.initialMarginBps)) / BPS;
  const after = execPrice !== null && delta !== 0n ? applyFill(pos, delta, execPrice) : { ...pos, realized: 0n, increased: false };
  const positionAfter = { size: after.size, openNotional: after.openNotional };

  let marginHeadroom: bigint | null = null;
  let liq: bigint | null = null;
  if (x.health && x.indexPrice > 0n && execPrice !== null && delta !== 0n) {
    const index = x.indexPrice;
    // Filling away from the index moves equity at once: buying above it costs
    // the difference, selling above it earns it.
    const fillPnl = (delta * (index - execPrice)) / 10n ** 18n;
    const equityAfter = x.health.equity - fee + fillPnl;
    const imOther = x.health.initialMarginRequired - marginAt(pos.size, index, x.market.initialMarginBps);
    const mmOther = x.health.maintenanceMarginRequired - marginAt(pos.size, index, x.market.maintenanceMarginBps);
    const imAfter = imOther + marginAt(positionAfter.size, index, x.market.initialMarginBps);
    marginHeadroom = equityAfter - imAfter;
    // Only exposure-increasing fills need initial margin (Engine: `increased`).
    if (after.increased && marginHeadroom < 0n) errors.push("insufficient_margin");
    liq = liquidationPrice({
      size: positionAfter.size,
      equity: equityAfter,
      price: index,
      maintenanceMarginBps: x.market.maintenanceMarginBps,
      otherMaintenance: mmOther > 0n ? mmOther : 0n,
    });
  }

  return {
    limitPrice,
    execPrice,
    crosses,
    notional: orderNotional,
    fee,
    orderMargin,
    positionAfter,
    liquidationPrice: liq,
    marginHeadroom,
    errors,
  };
}

/**
 * The largest base size the free collateral supports at `price` for a new or
 * increased position: headroom / (price × IM + fee), rounded down to the
 * market's size step. For the "Max" button; the check above is what decides.
 */
export function maxOrderSize(opts: {
  headroom: bigint;
  price: bigint;
  initialMarginBps: number;
  takerRate: number;
  /** Size step, 1e18 (10^(18 − sizeDecimals)). */
  step: bigint;
}): bigint {
  const { headroom, price, initialMarginBps, takerRate, step } = opts;
  if (headroom <= 0n || price <= 0n || step <= 0n) return 0n;
  // Cost per 1e18 of size, in 1e18 USD: price × (IM/1e4 + taker/1e6).
  const perUnit = (price * (BigInt(initialMarginBps) * 100n + BigInt(Math.max(0, takerRate)))) / 1_000_000n;
  if (perUnit <= 0n) return 0n;
  const raw = (headroom * 10n ** 18n) / perUnit;
  return (raw / step) * step;
}
