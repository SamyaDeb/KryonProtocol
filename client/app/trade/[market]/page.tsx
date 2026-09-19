import { redirect } from "next/navigation";

import { TopNav } from "@/components/common/TopNav";
import { MarketDataProvider } from "@/features/trade/components/MarketDataProvider";
import { TradeTerminalGrid } from "@/features/trade/components/TradeTerminalGrid";
import { db } from "@/lib/db";
import { canonicalSymbol } from "@/lib/markets";
import { networkFromCookies } from "@/lib/network-server";
import { listMarkets } from "@/lib/queries/markets";

// Listings are chain state read per request; nothing here can be prerendered.
export const dynamic = "force-dynamic";

type Resolved = { kind: "market"; marketId: number; symbol: string } | { kind: "redirect"; to: string } | { kind: "none" } | { kind: "down" };

/**
 * Resolve the URL's symbol against what RiskParams has listed on the caller's
 * network. An unlisted symbol goes to the first active market; with nothing
 * listed, or the database unreachable, the page says so instead of rendering a
 * terminal for a market that does not exist.
 */
async function resolveMarket(symbol: string): Promise<Resolved> {
  const network = await networkFromCookies();
  try {
    const markets = await listMarkets(db(network), network);
    const want = canonicalSymbol(symbol);
    const hit = markets.find((m) => canonicalSymbol(m.symbol) === want);
    if (hit) return { kind: "market", marketId: hit.marketId, symbol: want };
    const fallback = markets.find((m) => m.active) ?? markets[0];
    return fallback ? { kind: "redirect", to: `/trade/${canonicalSymbol(fallback.symbol)}` } : { kind: "none" };
  } catch (e) {
    console.error("trade page: market lookup failed:", e);
    return { kind: "down" };
  }
}

export default async function TradePage({ params }: { params: Promise<{ market: string }> }) {
  const { market } = await params;
  const resolved = await resolveMarket(decodeURIComponent(market));
  if (resolved.kind === "redirect") redirect(resolved.to);

  const shell = (children: React.ReactNode) => (
    // Mobile/tablet: the page scrolls vertically (min-h-dvh). Desktop (lg+):
    // a fixed-height terminal that never scrolls the page — only its panels.
    <div
      className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden"
      style={{ background: "#19191A", fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
    >
      <TopNav />
      {children}
    </div>
  );

  if (resolved.kind !== "market") {
    return shell(
      <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-[#a3a3a3]">
        {resolved.kind === "down"
          ? "Market data is unavailable right now. The indexer or database may be down; try again shortly."
          : "No markets are listed on this network yet."}
      </div>
    );
  }

  return (
    <MarketDataProvider marketId={resolved.marketId}>
      {shell(<TradeTerminalGrid marketId={resolved.marketId} />)}
    </MarketDataProvider>
  );
}
