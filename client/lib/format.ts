import { MARKETS, PRICE_PRECISION, AMOUNT_PRECISION, type MarketConfig } from "@/config";

export function priceToHuman(raw: bigint): number {
  return Number(raw * 10000n / PRICE_PRECISION) / 10000;
}

export function amountToHuman(raw: bigint): number {
  return Number(raw) / Number(AMOUNT_PRECISION);
}

export function humanToAmount(val: number): bigint {
  return BigInt(Math.round(val * Number(AMOUNT_PRECISION)));
}

// ── Market-aware formatting ──────────────────────────────────────────────────
// Precision is a property of the ASSET, not a constant. A hardcoded 4dp is
// right for a $0.20 asset and wrong by four orders of magnitude for BTC
// ("76996.5000"); 4dp also silently truncates TRX's finest 0.00001 tick.
// Everything user-facing should go through these, driven by MarketConfig's
// priceDecimals / sizeDecimals.

/** Human-readable price for a market. Accepts a 1e18 bigint or a plain number. */
export function formatMarketPrice(market: MarketConfig, value: bigint | number): string {
  const n = typeof value === "bigint" ? priceToHuman(value) : value;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: market.priceDecimals,
    maximumFractionDigits: market.priceDecimals,
  });
}

/** As formatMarketPrice, prefixed with "$". Renders "—" for null/undefined. */
export function formatMarketUsd(
  market: MarketConfig,
  value: bigint | number | null | undefined
): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "bigint" && value <= 0n) return "—";
  return "$" + formatMarketPrice(market, value);
}

/** Base-asset size for a market. Accepts a 1e7 bigint or a plain number. */
export function formatMarketSize(market: MarketConfig, value: bigint | number): string {
  const n = typeof value === "bigint" ? amountToHuman(value) : value;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: market.sizeDecimals,
    maximumFractionDigits: market.sizeDecimals,
  });
}

// ── By market id ─────────────────────────────────────────────────────────────
// History tables carry a bare marketId, not a MarketConfig, and can reference
// a market that has since been de-listed — hence MARKETS, not ACTIVE_MARKETS,
// and a 4dp fallback for an id we no longer recognise.

function configFor(marketId: number): MarketConfig | undefined {
  return Object.values(MARKETS).find((m) => m.marketId === marketId);
}

/** "$76,996.5" at the market's precision, from a 1e18 bigint or a number. */
export function priceFor(marketId: number, value: bigint | number): string {
  const m = configFor(marketId);
  if (m) return formatMarketUsd(m, value);
  const n = typeof value === "bigint" ? priceToHuman(value) : value;
  return "$" + n.toFixed(4);
}

/** Base-asset size at the market's precision, from a 1e7 bigint or a number. */
export function sizeFor(marketId: number, value: bigint | number): string {
  const m = configFor(marketId);
  if (m) return formatMarketSize(m, value);
  const n = typeof value === "bigint" ? amountToHuman(value) : value;
  return n.toFixed(4);
}

/** Round a typed/derived price to the market's display precision. */
export function toPriceInput(market: MarketConfig, value: number): string {
  return value.toFixed(market.priceDecimals);
}

export function formatAmount(raw: bigint, decimals = 4): string {
  return amountToHuman(raw).toFixed(decimals);
}

export function shortenAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function formatVolume(raw: bigint): string {
  const val = amountToHuman(raw);
  if (val >= 1_000_000_000) return `$${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(2)}K`;
  return `$${val.toFixed(2)}`;
}

export function formatChangePercent(pct: number, decimals = 2): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(decimals)}%`;
}
