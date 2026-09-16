"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "@/stores/wallet";
import { useLocalOrders } from "@/stores/orders";
import { getPositions } from "@/lib/stellar/contracts";
import { ACTIVE_MARKETS } from "@/config";
import { useOrderReconciliation } from "@/features/trade/hooks/useOrderReconciliation";
import { PositionsTable } from "./PositionsTable";
import { OpenOrdersTable } from "./OpenOrdersTable";
import { OrderHistoryTable } from "./OrderHistoryTable";
import { TradeHistoryTable } from "./TradeHistoryTable";
import { FundingHistoryTable } from "./FundingHistoryTable";

const CaretIcon = () => (
  <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 4.5 L6 7.5 L9 4.5" />
  </svg>
);
const LinesIcon = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M4 6h12M4 12h16M4 18h8" />
  </svg>
);
type TabKey = "Positions" | "Open Orders" | "Trade History" | "Order History" | "Funding History";

export function BottomPanel({ marketId }: { marketId: number }) {
  useOrderReconciliation();
  const [activeTab, setActiveTab] = useState<TabKey>("Positions");
  const [marketFilter, setMarketFilter] = useState<number | "all">(marketId);
  const [sideFilter, setSideFilter] = useState<"both" | "long" | "short">("both");
  const [marketMenu, setMarketMenu] = useState(false);
  const [sideMenu, setSideMenu] = useState(false);
  const { address, connected } = useWalletStore();
  const allOrders = useLocalOrders((s) => s.orders);

  // Shared positions query (same key as PositionsTable — cache hit, no double-fetch)
  const { data: allPositions = [] } = useQuery({
    queryKey: ["positions", address],
    queryFn: () => getPositions(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  const matchMarket = (mId: number) => marketFilter === "all" || mId === marketFilter;
  const matchSide = (isLong: boolean) => sideFilter === "both" || (sideFilter === "long") === isLong;

  const positionCount = allPositions.filter((p) => matchMarket(p.marketId) && matchSide(p.isLong)).length;
  const orderCount = allOrders.filter((o) => o.status === "pending" && matchMarket(o.marketId) && matchSide(o.isLong)).length;
  const orderHistoryCount = allOrders.filter((o) => matchMarket(o.marketId) && matchSide(o.isLong)).length;

  const marketLabel =
    marketFilter === "all" ? "All" : Object.values(ACTIVE_MARKETS).find((m) => m.marketId === marketFilter)?.symbol ?? "All";
  const sideLabel = sideFilter === "both" ? "Both" : sideFilter === "long" ? "Long" : "Short";

  const TABS: { key: TabKey; count: number | null }[] = [
    { key: "Positions", count: positionCount },
    { key: "Open Orders", count: orderCount },
    { key: "Trade History", count: null },
    { key: "Order History", count: orderHistoryCount },
    { key: "Funding History", count: null },
  ];

  const tabCls = (active: boolean) =>
    `whitespace-nowrap shrink-0 px-4 py-[11px] text-[12.5px] font-medium relative transition-colors ${
      active
        ? "text-[#f5f5f5] after:content-[''] after:absolute after:left-[14px] after:right-[14px] after:bottom-[-1px] after:h-[2px] after:bg-[#f5f5f5] after:rounded-[2px]"
        : "text-[#a3a3a3] hover:text-[#f5f5f5]"
    }`;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-none border border-[#2A2A31] bg-[#19191A]">
      {/* Tab bar */}
      <div className="flex flex-col border-b border-[#2A2A31] lg:flex-row lg:items-center lg:justify-between">
        <div className="flex overflow-x-auto no-scrollbar">
          {TABS.map(({ key, count }) => (
            <button key={key} className={tabCls(activeTab === key)} onClick={() => setActiveTab(key)}>
              {key}
              {count !== null && (
                <span className={`font-normal ml-1 ${count > 0 ? "text-[#f5f5f5]" : "text-[#737373]"}`}>
                  ({count})
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-[8px] overflow-x-auto no-scrollbar border-t border-[#2A2A31] px-3 py-1.5 lg:border-t-0 lg:pl-0 lg:pr-3">
          {/* Market filter */}
          <div className="relative">
            <button
              onClick={() => { setMarketMenu((v) => !v); setSideMenu(false); }}
              className="flex items-center gap-2 px-3 py-[5px] rounded-[7px] bg-[#212128] border border-[#334155] text-[12px] text-[#a3a3a3] hover:border-[#475569] hover:text-[#f5f5f5] transition-colors"
            >
              Market <span className="text-[#f5f5f5] font-medium">{marketLabel}</span>
              <CaretIcon />
            </button>
            {marketMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMarketMenu(false)} />
                {/* max-h + scroll: the list is eight entries long now. */}
                <div className="absolute right-0 top-full mt-1 z-50 max-h-[280px] w-[160px] overflow-y-auto rounded-[8px] border border-[#334155] bg-[#212128] p-1 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
                  <MenuItem active={marketFilter === "all"} onClick={() => { setMarketFilter("all"); setMarketMenu(false); }}>All markets</MenuItem>
                  {Object.values(ACTIVE_MARKETS).map((m) => (
                    <MenuItem key={m.marketId} active={marketFilter === m.marketId} onClick={() => { setMarketFilter(m.marketId); setMarketMenu(false); }}>
                      {m.symbol}
                    </MenuItem>
                  ))}
                </div>
              </>
            )}
          </div>
          {/* Side filter */}
          <div className="relative">
            <button
              onClick={() => { setSideMenu((v) => !v); setMarketMenu(false); }}
              className="flex items-center gap-2 px-3 py-[5px] rounded-[7px] bg-[#212128] border border-[#334155] text-[12px] text-[#a3a3a3] hover:border-[#475569] hover:text-[#f5f5f5] transition-colors"
            >
              <LinesIcon />
              <span className="text-[#f5f5f5] font-medium">{sideLabel}</span>
              <CaretIcon />
            </button>
            {sideMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSideMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-[120px] rounded-[8px] border border-[#334155] bg-[#212128] p-1 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
                  {(["both", "long", "short"] as const).map((s) => (
                    <MenuItem key={s} active={sideFilter === s} onClick={() => { setSideFilter(s); setSideMenu(false); }}>
                      {s === "both" ? "Both" : s === "long" ? "Long" : "Short"}
                    </MenuItem>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Content — taller on mobile (own tab) than in the desktop grid row */}
      <div className="flex-1 overflow-y-auto max-h-[calc(100dvh-260px)] lg:max-h-[160px]">
        {activeTab === "Positions" && <PositionsTable marketFilter={marketFilter} sideFilter={sideFilter} />}
        {activeTab === "Open Orders" && <OpenOrdersTable marketFilter={marketFilter} sideFilter={sideFilter} />}
        {activeTab === "Trade History" && <TradeHistoryTable marketFilter={marketFilter} />}
        {activeTab === "Order History" && <OrderHistoryTable marketFilter={marketFilter} sideFilter={sideFilter} />}
        {activeTab === "Funding History" && <FundingHistoryTable marketFilter={marketFilter} />}
      </div>
    </div>
  );
}

function MenuItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full text-left px-3 py-[6px] rounded-[5px] text-[12.5px] transition-colors ${
        active ? "text-[#f5f5f5] bg-[#212128]" : "text-[#a3a3a3] hover:text-[#f5f5f5] hover:bg-[#212128]"
      }`}
    >
      {children}
    </button>
  );
}

