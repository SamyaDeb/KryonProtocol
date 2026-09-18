/**
 * Value conversions shared by the query helpers and the routes that call them.
 *
 * The Arc schema stores every on-chain integer as `Decimal(78, 0)`, which `pg`
 * returns as a string, and every address and hash as lowercase hex (CHECKed).
 * These helpers are the one place those two conventions are applied, so a
 * route cannot parse a 1e18 balance through `Number` or compare a checksummed
 * address against a lowercase column and silently match nothing.
 *
 * Safe to import from server code only by convention; nothing here is secret.
 */

import { formatUnits, isAddress } from "viem";

/** Parse a Decimal(78,0) column. Null/empty is 0, never NaN. */
export function big(value: unknown): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  return BigInt(String(value));
}

/**
 * A caller-supplied address in the form the database stores: lowercase
 * `0x` + 40 hex. Mixed-case input is accepted only when its EIP-55 checksum is
 * valid, so a typo in a checksummed address is an error rather than a lookup of
 * somebody else's account.
 */
export function parseAddress(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length !== 42) return null;
  return isAddress(raw, { strict: true }) ? raw.toLowerCase() : null;
}

/**
 * A fixed-point integer as a display decimal with `dp` places, e.g.
 * `formatFixed(1_500_000_000_000_000_000n)` → `"1.5000"`.
 *
 * Kept exact up to the rounding digit: `formatUnits` is string arithmetic, and
 * only the final truncation to `dp` places goes through `Number`, which every
 * value a price or size display needs survives.
 */
export function formatFixed(value: bigint, decimals = 18, dp = 4): string {
  return Number(formatUnits(value, decimals)).toFixed(dp);
}

/** `formatFixed` as a number, for the chart and analytics shapes that want one. */
export function toFloat(value: bigint, decimals = 18): number {
  return Number(formatUnits(value, decimals));
}

/**
 * A positive integer query parameter, clamped to `max`. `null` when the value
 * is present but not a positive integer, so the route can answer 400 instead of
 * passing NaN into a LIMIT.
 */
export function parseLimit(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, max);
}

/** An on-chain `uint32` market id from a path or query segment. */
export function parseMarketId(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || !/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 0xffffffff ? n : null;
}
