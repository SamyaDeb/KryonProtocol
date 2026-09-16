import { MARKETS, type MarketConfig } from "@/config";
import { logoFor } from "@/components/common/AssetLogos";

/**
 * The market identity cell — asset mark + symbol — shared by every history and
 * positions table. Previously duplicated five times, each with its own
 * `baseSymbol === "XLM" ? <XlmLogo/> : null`, so no non-XLM market rendered a
 * mark anywhere.
 *
 * Takes a marketId (what the tables actually carry) and resolves it against
 * MARKETS — not ACTIVE_MARKETS, because historical rows can reference a market
 * that has since been de-listed and must still render legibly.
 */
export function MarketCell({
  marketId,
  size = 15,
  className = "",
}: {
  marketId: number;
  size?: number;
  className?: string;
}) {
  const market = marketById(marketId);
  const symbol = market?.symbol ?? `#${marketId}`;
  const base = market?.baseAsset ?? "?";

  return (
    <span className={`flex items-center gap-2 ${className}`}>
      {logoFor(base, size)}
      <span>{symbol}</span>
    </span>
  );
}

/** Full config for a market id, or undefined for an unknown/de-listed market. */
export function marketById(marketId: number): MarketConfig | undefined {
  return Object.values(MARKETS).find((m) => m.marketId === marketId);
}

/** Display symbol for a market id, falling back to "#<id>". */
export function marketSymbol(marketId: number): string {
  return marketById(marketId)?.symbol ?? `#${marketId}`;
}
