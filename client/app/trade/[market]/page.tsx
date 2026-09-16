import { ACTIVE_MARKETS, DEFAULT_MARKET_SYMBOL } from "@/config";
import { redirect } from "next/navigation";
import { MarketDataProvider } from "@/features/trade/components/MarketDataProvider";
import { SettlementModal } from "@/features/trade/components/SettlementModal";
import { TopNav } from "@/components/common/TopNav";
import { TradeTerminalGrid } from "@/features/trade/components/TradeTerminalGrid";

export default async function TradePage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  const marketConfig = ACTIVE_MARKETS[market.toUpperCase()];
  if (!marketConfig) redirect(`/trade/${DEFAULT_MARKET_SYMBOL}`);

  return (
    <MarketDataProvider market={marketConfig}>
      <SettlementModal />

      {/* Mobile/tablet: the page scrolls vertically (min-h-dvh). Desktop (lg+):
          a fixed-height terminal that never scrolls the page — only its panels. */}
      <div
        className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden"
        style={{ background: "#19191A", fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
      >
        <TopNav />
        <TradeTerminalGrid market={marketConfig} />
      </div>
    </MarketDataProvider>
  );
}
