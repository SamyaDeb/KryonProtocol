/**
 * Number formatting for Kryon on Arc: bigint in, string out.
 *
 * Scales, one per kind of number (lib/queries/json.ts, lib/chain/collateral.ts):
 *
 *   1e18  prices, sizes, notionals, the vault ledger, PnL, fees, funding
 *         amounts, and the funding rate per hour (a 1e18 fraction)
 *   1e6   wallet USDC, withdrawable balances, deposit caps, and every
 *         analytics column (leaderboard, portfolio, 30-day volume)
 *   1e6   fee rates, in millionths of notional (FeeRouter.RATE_DENOMINATOR)
 *
 * No amount passes through a float. A 1e18 value does not fit a double, and
 * the old 1e7 helpers did exactly that. `toChartNumber` is the one exit to
 * `number`, for chart libraries that need it; nothing signed or sent may use it.
 *
 * Rounding is explicit. The default, "nearest", suits prices and sizes. Pass
 * "down" for anything the user could act on as available (withdrawable
 * balance, free collateral). Pass "up" for anything they will pay (fees,
 * required margin). A display that rounds in the user's favour would promise
 * money the contracts will not give.
 */

import type { MarketDisplay } from "@/lib/markets";

export const E18 = 10n ** 18n;
export const E6 = 10n ** 6n;

/** Decimals of each scale above. */
export const DECIMALS = {
  price: 18,
  size: 18,
  ledger: 18,
  usdc: 6,
  analytics: 6,
  rate: 6,
  fundingRate: 18,
} as const;

export type Rounding = "nearest" | "down" | "up";

export interface FixedOptions {
  /** "nearest" rounds half away from zero; "down" toward zero; "up" away from zero. */
  rounding?: Rounding;
  /** Thousands separators. Off for values that feed an <input>. */
  grouping?: boolean;
  /** "always" prefixes "+" on positive values (PnL, changes). */
  sign?: "auto" | "always";
}

/** A market's display precision; `displayFor(symbol)` supplies it. */
export type Precision = Pick<MarketDisplay, "priceDecimals" | "sizeDecimals">;

const DASH = "—";

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * `value` at `decimals` rescaled to `dp` decimals, as an integer at the new
 * scale, rounded as asked. Exact: no intermediate float.
 */
export function rescale(value: bigint, decimals: number, dp: number, rounding: Rounding = "nearest"): bigint {
  if (dp >= decimals) return value * pow10(dp - decimals);
  const q = pow10(decimals - dp);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  let r = abs / q;
  const rem = abs % q;
  if (rem > 0n && (rounding === "up" || (rounding === "nearest" && rem * 2n >= q))) r += 1n;
  return neg ? -r : r;
}

/** `value` (at `decimals`) as a fixed-point string with exactly `dp` decimals. */
export function formatFixed(value: bigint, decimals: number, dp: number, opts: FixedOptions = {}): string {
  const { rounding = "nearest", grouping = true, sign = "auto" } = opts;
  const r = rescale(value, decimals, dp, rounding);
  const neg = r < 0n;
  const abs = neg ? -r : r;
  const unit = pow10(dp);
  const whole = (abs / unit).toString();
  const frac = dp > 0 ? `.${(abs % unit).toString().padStart(dp, "0")}` : "";
  // A value that rounds to zero carries no sign: "-0.00" reads as a loss.
  const prefix = neg ? "-" : sign === "always" && abs > 0n ? "+" : "";
  return `${prefix}${grouping ? group(whole) : whole}${frac}`;
}

/**
 * Parse what a user typed into an integer at `decimals`.
 *
 * Strict: digits with at most one ".", commas allowed only as thousands
 * separators, nothing negative. More fractional digits than the scale holds is
 * an error, not a silent rounding: the number signed must be the number typed.
 * Returns null for anything else, including "" and ".".
 */
export function parseAmount(input: string, decimals: number): bigint | null {
  const text = input.trim().replace(/,(?=\d{3}(?:\D|$))/g, "");
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return null;
  const [whole = "", frac = ""] = text.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * pow10(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

// ── Market-aware: prices and sizes at each market's display precision ───────

/** "76,996.5" for BTC, "0.24187" for TRX, from a 1e18 price. */
export function formatPrice(p: Precision, price: bigint, rounding: Rounding = "nearest"): string {
  return formatFixed(price, DECIMALS.price, p.priceDecimals, { rounding });
}

/** As `formatPrice` with "$"; a dash for a missing or non-positive price. */
export function formatUsdPrice(p: Precision, price: bigint | null | undefined): string {
  if (price === null || price === undefined || price <= 0n) return DASH;
  return `$${formatPrice(p, price)}`;
}

/** Base-asset size from 1e18, signed if the value is. */
export function formatSize(p: Precision, size: bigint, rounding: Rounding = "nearest"): string {
  return formatFixed(size, DECIMALS.size, p.sizeDecimals, { rounding });
}

/** A 1e18 price for an <input>: no separators. */
export function priceInput(p: Precision, price: bigint): string {
  return formatFixed(price, DECIMALS.price, p.priceDecimals, { grouping: false });
}

/** A 1e18 size for an <input>, rounded down so it never exceeds the source. */
export function sizeInput(p: Precision, size: bigint): string {
  return formatFixed(size, DECIMALS.size, p.sizeDecimals, { grouping: false, rounding: "down" });
}

// ── Money ────────────────────────────────────────────────────────────────────

function usd(value: bigint, decimals: number, dp: number, opts: FixedOptions): string {
  const s = formatFixed(value, decimals, dp, opts);
  // "-$12.50" and "+$12.50", not "$-12.50".
  return s.startsWith("-") || s.startsWith("+") ? `${s[0]}$${s.slice(1)}` : `$${s}`;
}

/** A 1e18 USD amount: ledger balance, equity, PnL, fee, notional. */
export function formatUsd(value: bigint, opts: FixedOptions & { dp?: number } = {}): string {
  return usd(value, DECIMALS.ledger, opts.dp ?? 2, opts);
}

/** A 1e6 USDC amount: wallet, withdrawable, caps, and the analytics tables. */
export function formatUsdc(value: bigint, opts: FixedOptions & { dp?: number } = {}): string {
  return usd(value, DECIMALS.usdc, opts.dp ?? 2, opts);
}

/**
 * "$1.23M" from a value at `decimals`, rounded to nearest at two decimals of
 * the unit. Units are tried largest first and the first that rounds to at
 * least 1.00 wins, so 999,999.99 reads "$1.00M", not "$1,000.00K".
 */
export function formatCompactUsd(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const sign = neg ? "-" : "";
  for (const [suffix, exp] of [["B", 9], ["M", 6], ["K", 3]] as const) {
    if (rescale(abs, decimals + exp, 2) >= 100n) return `${sign}$${formatFixed(abs, decimals + exp, 2)}${suffix}`;
  }
  return `${sign}$${formatFixed(abs, decimals, 2)}`;
}

// ── Rates ────────────────────────────────────────────────────────────────────

/** A fee rate in millionths as basis points: 350 → "3.5 bps", -50 → "-0.5 bps". */
export function formatRateBps(millionths: number | bigint): string {
  // 1 bp = 100 millionths; two decimals covers the finest rate step of 1.
  const s = formatFixed(BigInt(millionths), 2, 2, { grouping: false });
  return `${s.replace(/\.?0+$/, "")} bps`;
}

/** A fee rate in millionths as a percentage: 350 → "0.035%". */
export function formatRatePercent(millionths: number | bigint): string {
  // percent = millionths / 1e4; four decimals holds the finest step.
  const s = formatFixed(BigInt(millionths), 4, 4, { grouping: false });
  return `${s.replace(/\.?0+$/, "")}%`;
}

/** Funding rate per hour (1e18 fraction) as a signed percentage: "+0.0100%". */
export function formatFundingRate(ratePerHour: bigint, dp = 4): string {
  return `${formatFixed(ratePerHour * 100n, DECIMALS.fundingRate, dp, { sign: "always" })}%`;
}

/** Relative change from `from` to `to` as "+1.23%"; a dash when `from` is 0. */
export function formatChange(from: bigint, to: bigint, dp = 2): string {
  if (from === 0n) return DASH;
  // Percent with 6 decimals before rounding to `dp`: exact enough for display.
  const scaled = ((to - from) * 100_000_000n) / (from < 0n ? -from : from);
  return `${formatFixed(scaled, 6, dp, { sign: "always" })}%`;
}

// ── Misc ─────────────────────────────────────────────────────────────────────

/** "0x1234…abcd". Anything too short to shorten comes back unchanged. */
export function shortenAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * The value as a JS number, for chart libraries only. Lossy by design: a 1e18
 * value keeps about 15 significant digits. Never feed the result back into
 * anything that is signed, sent or compared against a limit.
 */
export function toChartNumber(value: bigint, decimals: number): number {
  return Number(formatFixed(value, decimals, Math.min(decimals, 12), { grouping: false }));
}
