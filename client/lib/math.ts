/**
 * Position arithmetic for the UI, mirroring the contracts. All values are
 * bigint at 1e18 (prices, sizes, USD amounts); sizes and basis are signed,
 * positive for long.
 *
 * These are PREVIEWS. The contracts decide. Each function names the Solidity
 * it copies, so a divergence is easy to spot:
 *
 *   notional       KryonMath.mulPrecision (truncating), OrderGateway:163
 *   fee            FeeRouter.quote: debits round up (`_ceilMul`), rebates down
 *   entry price    Engine._riskInputs: |openNotional| / |size|, floored at 1 wei
 *   unrealized PnL size × price − openNotional, the basis Engine keeps
 *   applyFill      Engine._applyFill: close first, basis removed pro rata,
 *                  any residual opens the other side
 *   margin         RiskLib: notional at the index price × bps / 10_000
 *
 * Funding owed since the last settlement is not included anywhere here; the
 * UI labels these figures as excluding it.
 */

export const E18 = 10n ** 18n;
export const RATE_DENOMINATOR = 1_000_000n;
export const BPS = 10_000n;

const abs = (x: bigint) => (x < 0n ? -x : x);

/** Truncating `a * b / d`, as KryonMath.mulDiv (Solidity division rounds toward zero). */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b) / d;
}

/** |size| × price / 1e18, truncated: the fill notional the gateway computes. */
export function notional(size: bigint, price: bigint): bigint {
  return mulDiv(abs(size), price, E18);
}

/**
 * Fee on a fill notional at a rate in millionths (FeeRouter.quote).
 * A positive rate rounds up; a negative rate is a rebate, rounded toward zero.
 */
export function feeFor(fillNotional: bigint, rateMillionths: bigint): bigint {
  if (fillNotional <= 0n || rateMillionths === 0n) return 0n;
  if (rateMillionths < 0n) return -mulDiv(fillNotional, -rateMillionths, RATE_DENOMINATOR);
  return (fillNotional * rateMillionths - 1n) / RATE_DENOMINATOR + 1n;
}

/** Average entry price, or 0n for a flat position. */
export function entryPrice(size: bigint, openNotional: bigint): bigint {
  if (size === 0n) return 0n;
  const e = mulDiv(abs(openNotional), E18, abs(size));
  return e > 0n ? e : 1n;
}

/** Unrealized PnL at `price`: size × price / 1e18 − openNotional. */
export function unrealizedPnl(size: bigint, openNotional: bigint, price: bigint): bigint {
  if (size === 0n) return 0n;
  const value = size < 0n ? -mulDiv(-size, price, E18) : mulDiv(size, price, E18);
  return value - openNotional;
}

/** Margin at `bps` of the position's notional at `price` (RiskLib). */
export function marginAt(size: bigint, price: bigint, bps: number): bigint {
  return mulDiv(notional(size, price), BigInt(bps), BPS);
}

export interface PositionState {
  /** Signed, 1e18 base units. */
  size: bigint;
  /** Signed, 1e18 USD: positive for a long's basis, negative for a short's. */
  openNotional: bigint;
}

export interface FillResult extends PositionState {
  /** PnL realized by the closing part, 1e18 USD. */
  realized: bigint;
  /** The fill opened or added exposure (the case reduce-only forbids). */
  increased: boolean;
}

/**
 * The position after a fill of signed `delta` at `price` (Engine._applyFill).
 * Pure: no funding, fees or limits, which the contract applies separately.
 */
export function applyFill(p: PositionState, delta: bigint, price: bigint): FillResult {
  if (delta === 0n) return { ...p, realized: 0n, increased: false };
  const fill = notional(delta, price);
  const s = p.size;
  if (s === 0n || s > 0n === delta > 0n) {
    return {
      size: s + delta,
      openNotional: p.openNotional + (delta > 0n ? fill : -fill),
      realized: 0n,
      increased: true,
    };
  }
  const absS = abs(s);
  const absD = abs(delta);
  const closeQty = absD < absS ? absD : absS;
  const residual = absD - closeQty;
  const closeNotional = residual === 0n ? fill : notional(closeQty, price);
  const removedBasis = closeQty === absS ? p.openNotional : mulDiv(p.openNotional, closeQty, absS);
  const realized = (s > 0n ? closeNotional : -closeNotional) - removedBasis;
  let size = s > 0n ? s - closeQty : s + closeQty;
  let openNotional = p.openNotional - removedBasis;
  if (residual > 0n) {
    const rest = fill - closeNotional;
    size += delta > 0n ? residual : -residual;
    openNotional += delta > 0n ? rest : -rest;
  }
  return { size, openNotional, realized, increased: residual > 0n };
}

export interface LiquidationInputs {
  /** The position in question, signed 1e18. */
  size: bigint;
  /** Account equity now, 1e18 USD (Engine.accountHealth.equity). */
  equity: bigint;
  /** The index price `equity` was computed at, 1e18. */
  price: bigint;
  /** This market's maintenance margin, in bps. */
  maintenanceMarginBps: number;
  /**
   * Maintenance required by the account's OTHER positions, 1e18 USD, held
   * constant. With one position this is 0.
   */
  otherMaintenance?: bigint;
}

/**
 * The index price at which the account reaches its maintenance requirement,
 * with every other position and the collateral held where they are.
 *
 * Equity moves by size × (P − price); maintenance at P is |size| × P × m.
 *   long:  P = (O + s·price − E) / (s · (1 − m))
 *   short: P = (E + a·price − O) / (a · (1 + m)),  a = |s|
 *
 * Returns null when no positive price qualifies (e.g. a long whose collateral
 * alone covers it all the way down). A result on the wrong side of `price`
 * means the account is already liquidatable.
 */
export function liquidationPrice(x: LiquidationInputs): bigint | null {
  const { size, equity, price, maintenanceMarginBps } = x;
  const other = x.otherMaintenance ?? 0n;
  if (size === 0n) return null;
  const m = BigInt(maintenanceMarginBps);
  const a = abs(size);
  const positionValue = mulDiv(a, price, E18);
  const numerator = size > 0n ? other + positionValue - equity : equity + positionValue - other;
  const denominator = a * (size > 0n ? BPS - m : BPS + m);
  if (numerator <= 0n || denominator <= 0n) return null;
  return (numerator * E18 * BPS) / denominator;
}
