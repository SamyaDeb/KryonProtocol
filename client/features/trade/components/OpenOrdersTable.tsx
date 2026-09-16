"use client";

import { useWalletStore } from "@/stores/wallet";
import { useLocalOrders } from "@/stores/orders";
import { cancelOrder as cancelOnChain } from "@/lib/stellar/contracts";
import { cancelOrderOnMatcher } from "@/lib/market/matcher";
import { priceToHuman, amountToHuman, formatMarketUsd, formatMarketSize } from "@/lib/format";

import { logoFor } from "@/components/common/AssetLogos";
import { marketById } from "@/components/common/MarketCell";
import { toast } from "sonner";
import { useState } from "react";

export function OpenOrdersTable({
  marketFilter,
  sideFilter,
}: {
  marketFilter: number | "all";
  sideFilter: "both" | "long" | "short";
}) {
  const { address, connected } = useWalletStore();
  const { orders, cancelOrder } = useLocalOrders();

  const visible = orders.filter(
    (o) =>
      o.status === "pending" &&
      o.owner === address &&
      (marketFilter === "all" || o.marketId === marketFilter) &&
      (sideFilter === "both" || (sideFilter === "long") === o.isLong)
  );

  if (!connected || !address) {
    return <Empty text="Connect a wallet to view open orders" />;
  }
  if (visible.length === 0) {
    return <Empty text="No open orders" />;
  }

  const cols = ["Market", "Type", "Side", "Size", "Price", "Reduce", "Status", ""];

  const makeCancel = (order: (typeof visible)[number]) => async () => {
    try {
      await cancelOnChain(address, order.nonce, order.expiryTs);
      await cancelOrderOnMatcher(address, order.nonce);
      cancelOrder(order.nonce, address);
      toast.success("Order cancelled");
    } catch (e) {
      toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <>
      {/* Desktop: dense table */}
      <table className="hidden w-full text-[12px] tabular lg:table">
        <thead>
          <tr className="text-[10px] text-[#737373] font-semibold uppercase tracking-wider">
            {cols.map((h, i) => (
              <th
                key={h || `act-${i}`}
                className={`py-[9px] whitespace-nowrap ${i === 0 ? "pl-4 pr-2 text-left" : i === cols.length - 1 ? "pr-4 pl-2 text-right" : "px-3 text-right"}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((order) => (
            <OrderRow key={String(order.nonce)} order={order} onCancel={makeCancel(order)} />
          ))}
        </tbody>
      </table>

      {/* Mobile: stacked cards */}
      <div className="flex flex-col gap-2 p-3 lg:hidden">
        {visible.map((order) => (
          <OrderCard key={String(order.nonce)} order={order} onCancel={makeCancel(order)} />
        ))}
      </div>
    </>
  );
}

type OrderType = ReturnType<typeof useLocalOrders.getState>["orders"][number];

function orderView(order: OrderType) {
  const market = marketById(order.marketId);
  const baseSymbol = market?.baseAsset ?? `#${order.marketId}`;
  const quoteAsset = market?.quoteAsset ?? "USDC";
  const isMarket = order.limitPrice === 0n;
  return {
    baseSymbol,
    quoteAsset,
    isMarket,
    priceDisplay: isMarket
      ? "Market"
      : market
      ? formatMarketUsd(market, order.limitPrice)
      : `$${priceToHuman(order.limitPrice).toFixed(4)}`,
    sizeDisplay: market
      ? formatMarketSize(market, order.size)
      : amountToHuman(order.size).toFixed(4),
    sideBadge: order.isLong
      ? "bg-[rgba(31,174,91,0.12)] text-[#1fae5b]"
      : "bg-[rgba(227,76,76,0.12)] text-[#e34c4c]",
  };
}

function OrderCard({ order, onCancel }: { order: OrderType; onCancel: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const v = orderView(order);
  return (
    <div className="rounded-[10px] border border-[#2A2A31] bg-[#212128] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {logoFor(v.baseSymbol, 16)}
          <span className="font-semibold text-[#f5f5f5]">
            {v.baseSymbol}
            <span className="text-[#737373] font-normal">/{v.quoteAsset}</span>
          </span>
          <span className={`rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${v.sideBadge}`}>
            {order.isLong ? "LONG" : "SHORT"}
          </span>
        </div>
        <button
          className="shrink-0 rounded-[6px] border border-[#334155] px-3 py-1.5 text-[12px] font-semibold text-[#a3a3a3] transition-colors hover:border-[#e34c4c]/40 hover:bg-[#e34c4c]/10 hover:text-[#e34c4c] disabled:opacity-50"
          disabled={cancelling}
          onClick={async () => {
            setCancelling(true);
            await onCancel();
            setCancelling(false);
          }}
        >
          {cancelling ? "…" : "Cancel"}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[12.5px] tabular">
        <CardField label="Type">{v.isMarket ? "Market" : "Limit"}</CardField>
        <CardField label="Status" align="right">
          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400 border border-amber-500/20">
            Pending
          </span>
        </CardField>
        <CardField label="Size"><span className="text-[#f5f5f5]">{v.sizeDisplay}</span></CardField>
        <CardField label="Price" align="right"><span className="text-[#f5f5f5]">{v.priceDisplay}</span></CardField>
        {order.reduceOnly && (
          <CardField label="Reduce">
            <span className="rounded border border-[#334155] px-1.5 py-0.5 text-[10px] text-[#a3a3a3]">Reduce Only</span>
          </CardField>
        )}
      </div>
    </div>
  );
}

function CardField({
  label,
  children,
  align = "left",
}: {
  label: string;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div className={`flex flex-col gap-0.5 ${align === "right" ? "items-end text-right" : "items-start"}`}>
      <span className="text-[10px] uppercase tracking-wider text-[#737373]">{label}</span>
      <span className="font-medium text-[#a3a3a3]">{children}</span>
    </div>
  );
}

function OrderRow({
  order,
  onCancel,
}: {
  order: ReturnType<typeof useLocalOrders.getState>["orders"][number];
  onCancel: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);

  const v = orderView(order);
  const { baseSymbol, isMarket, priceDisplay, sizeDisplay } = v;

  const sideBadge = v.sideBadge;

  return (
    <tr className="border-t border-[#2A2A31] hover:bg-white/[0.02] transition-colors">
      <td className="pl-4 pr-2 py-[10px] text-left">
        <div className="flex items-center gap-2">
          {logoFor(baseSymbol, 16)}
          <span className="font-semibold text-[#f5f5f5]">
            {baseSymbol}
            <span className="text-[#737373] font-normal">/{v.quoteAsset}</span>
          </span>
        </div>
      </td>
      <td className="px-3 py-[10px] text-right text-[#a3a3a3]">{isMarket ? "Market" : "Limit"}</td>
      <td className="px-3 py-[10px] text-right">
        <span className={`rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${sideBadge}`}>
          {order.isLong ? "LONG" : "SHORT"}
        </span>
      </td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">{sizeDisplay}</td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">{priceDisplay}</td>
      <td className="px-3 py-[10px] text-right">
        {order.reduceOnly ? (
          <span className="text-[10px] border border-[#334155] text-[#a3a3a3] px-1.5 py-0.5 rounded">Reduce</span>
        ) : (
          <span className="text-[#737373]">—</span>
        )}
      </td>
      <td className="px-3 py-[10px] text-right">
        <span className="text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded font-medium">
          Pending
        </span>
      </td>
      <td className="pr-4 pl-2 py-[10px] text-right">
        <button
          className="px-3 py-1.5 text-[12px] font-semibold rounded-[6px] border border-[#334155] text-[#a3a3a3] hover:text-[#e34c4c] hover:border-[#e34c4c]/40 hover:bg-[#e34c4c]/10 disabled:opacity-50 transition-colors"
          disabled={cancelling}
          onClick={async () => {
            setCancelling(true);
            await onCancel();
            setCancelling(false);
          }}
        >
          {cancelling ? "…" : "Cancel"}
        </button>
      </td>
    </tr>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-[#a3a3a3]">
      <span className="text-[13px] text-[#a3a3a3]">{text}</span>
    </div>
  );
}
