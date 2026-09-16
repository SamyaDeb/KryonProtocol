// How much of a position a liquidation should close.
//
// Pure arithmetic, deliberately separate from the keeper daemon so it can be
// tested — the keeper module asserts on secrets at import time and cannot be
// loaded from a test.

import { PRICE_PRECISION } from "@/config";

/**
 * Extra margin over the bare shortfall arithmetic.
 *
 * The closed-form minimum assumes closing a position only removes its
 * maintenance requirement. Closing also REALISES the loss, which lowers equity
 * at the same time, so the true minimum is somewhat larger than the arithmetic
 * says. Rather than iterate a fixed point, ask for a quarter more and let the
 * ladder escalate if the contract still refuses.
 */
const SAFETY_NUM = 125n;
const SAFETY_DEN = 100n;

export interface SizingPosition {
  size: bigint;
}

export interface SizingHealth {
  equity: bigint;
  maintenance_margin_required: bigint;
}

/**
 * Close sizes to attempt, smallest viable first.
 *
 * The first entry is the minimum that should restore the account:
 *
 *   shortfall = maintenance_margin_required - equity
 *   notional  = size * price / PRICE_PRECISION
 *   min_size  = size * shortfall / notional
 *
 * followed by 50% and a full close as escalations, deduplicated and ascending.
 *
 * Ordering is the whole point. The keeper used to try a full close first and
 * step down; because closing 100% always improves health, the first attempt
 * always succeeded, so every liquidatable account was fully liquidated — even
 * one that dipped a fraction below maintenance and would have been restored by
 * closing a tenth of its position. The contract cannot catch that: it enforces
 * that health improved, not that the close was minimal. A liquidator taking
 * more than necessary is taking value from the trader it is liquidating, so the
 * ladder must only ever go up.
 *
 * This is the same arithmetic as `risk_engine::plan_liquidation`, which
 * computes exactly this and which nothing ever called.
 */
export function closeSizeLadder(
  position: SizingPosition,
  price: bigint,
  health: SizingHealth
): bigint[] {
  const size = position.size;
  if (size <= 0n) return [];

  const candidates: bigint[] = [];
  const shortfall = health.maintenance_margin_required - health.equity;
  const notional = (size * price) / PRICE_PRECISION;

  // A non-positive shortfall means the account is not actually short of
  // maintenance margin, and a zero notional means we have no usable price — in
  // both cases fall through to the plain escalations rather than inventing a
  // minimum from bad inputs.
  if (shortfall > 0n && notional > 0n) {
    const minSize = (((size * shortfall) / notional) * SAFETY_NUM) / SAFETY_DEN;
    if (minSize > 0n && minSize < size) candidates.push(minSize);
  }
  candidates.push(size / 2n, size);

  return [...new Set(candidates.filter((c) => c > 0n && c <= size))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
}
