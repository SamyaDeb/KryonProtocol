import { PRICE_PRECISION, BPS_PRECISION } from "@/config";

/**
 * Approximate liquidation price for a cross-margin perp position.
 *
 * For a long:  liq = entryPrice * (1 - 1/leverage + maintenanceMarginRate)
 * For a short: liq = entryPrice * (1 + 1/leverage - maintenanceMarginRate)
 *
 * All price values are in 1e18 precision.
 */
export function calcLiqPrice(
  isLong: boolean,
  entryPrice: bigint,
  leverage: number,
  maintenanceMarginBps: number
): bigint {
  if (leverage <= 0 || entryPrice <= 0n) return 0n;

  const SCALE = 1_000_000n;
  const mmRate = BigInt(Math.round((maintenanceMarginBps / BPS_PRECISION) * Number(SCALE)));
  const leverageScaled = BigInt(Math.round(leverage * Number(SCALE)));

  if (isLong) {
    // factor = 1 - 1/leverage + mm_rate  (all scaled by SCALE)
    const factor = SCALE - (SCALE * SCALE) / leverageScaled + mmRate;
    if (factor <= 0n) return 0n;
    return (entryPrice * factor) / SCALE;
  } else {
    // factor = 1 + 1/leverage - mm_rate
    const factor = SCALE + (SCALE * SCALE) / leverageScaled - mmRate;
    return (entryPrice * factor) / SCALE;
  }
}

/**
 * Unrealized PnL for a position given current mark price.
 * Returns value in AMOUNT_PRECISION (1e7) to match vault balance units.
 *
 * pnl = size * (markPrice - entryPrice) / PRICE_PRECISION   [for long]
 * pnl = size * (entryPrice - markPrice) / PRICE_PRECISION   [for short]
 *
 * size is in AMOUNT_PRECISION (1e7), prices in PRICE_PRECISION (1e18).
 * Result is in AMOUNT_PRECISION (1e7).
 */
export function calcUnrealizedPnl(
  isLong: boolean,
  size: bigint,
  entryPrice: bigint,
  markPrice: bigint
): bigint {
  if (markPrice <= 0n || entryPrice <= 0n || size <= 0n) return 0n;
  const priceDelta = isLong ? markPrice - entryPrice : entryPrice - markPrice;
  return (size * priceDelta) / PRICE_PRECISION;
}
