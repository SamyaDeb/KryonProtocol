"use client";

import { logoFor } from "@/components/common/AssetLogos";
import { useMarketDirectory } from "@/features/markets/directory";

/**
 * The market identity cell — asset mark + symbol — shared by every history and
 * positions table.
 *
 * Takes a marketId (what the tables actually carry) and resolves it through the
 * on-chain market directory, including markets that have since been
 * deactivated: historical rows must still render legibly. Until the directory
 * loads, or for an id it does not know, the cell shows "#<id>".
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
  const market = useMarketDirectory()[marketId];
  const symbol = market?.symbol ?? `#${marketId}`;
  const base = market?.baseAsset ?? "?";

  return (
    <span className={`flex items-center gap-2 ${className}`}>
      {logoFor(base, size)}
      <span>{symbol}</span>
    </span>
  );
}

export { marketById, marketSymbol } from "@/features/markets/directory";
