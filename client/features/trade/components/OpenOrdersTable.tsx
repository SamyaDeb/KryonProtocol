"use client";

import { useState } from "react";
import { toast } from "sonner";

import { MarketCell } from "@/components/common/MarketCell";
import { useOpenOrders, type AccountOrder } from "@/features/account/queries";
import { useTrading } from "@/features/account/useTrading";
import { useMarkets } from "@/features/markets/directory";
import { useWallet } from "@/features/wallet/useWallet";
import { formatPrice, formatSize } from "@/lib/format";
import { describeTxError } from "@/lib/market/errors";
import { displayFor } from "@/lib/markets";

/**
 * Working orders: what the matcher can still trade (`/api/orders/list`).
 * Filled and pending amounts come from the API, which owns the definition of
 * remaining size; nothing is recomputed here.
 *
 * Two ways to cancel, and the UI says which is which:
 *   - "Cancel" signs an off-chain cancel: free and instant, but it only stops
 *     the matcher. The signed order itself stays valid on chain.
 *   - "Cancel on chain" calls the gateway's `cancelUpTo`: one transaction, and
 *     every order listed is dead for good whatever happens off chain.
 */
export function OpenOrdersTable({
  marketFilter,
  sideFilter = "both",
}: {
  marketFilter: number | "all";
  sideFilter?: "both" | "long" | "short";
}) {
  const { address, connected, ready } = useWallet();
  const { data: orders = [], isError } = useOpenOrders(address);
  const trading = useTrading(address);
  const { byId } = useMarkets();
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  if (!connected || !address) return <Empty text="Connect a wallet to view open orders" />;
  if (isError && orders.length === 0) return <Empty text="Open orders are unavailable right now; retrying." />;

  const rows = orders.filter(
    (o) =>
      (marketFilter === "all" || o.marketId === marketFilter) &&
      (sideFilter === "both" || (sideFilter === "long") === o.isLong)
  );
  if (rows.length === 0) return <Empty text="No open orders" />;

  async function cancelOne(o: AccountOrder) {
    setBusy(o.orderHash);
    try {
      const r = await trading.cancel(o.nonce);
      if (r.ok) {
        setRequested((s) => new Set(s).add(o.orderHash));
        toast.success("Cancel requested. The matcher will no longer fill this order.");
      } else toast.error(r.message);
    } catch (e) {
      toast.error(describeTxError(e));
    } finally {
      setBusy(null);
    }
  }

  async function cancelAll() {
    setBusy("all");
    try {
      const r = await trading.cancelAll(marketFilter === "all" ? 0 : marketFilter);
      if (r.ok) {
        setRequested(new Set(rows.map((o) => o.orderHash)));
        toast.success(`Cancel requested for ${r.cancelled} order${r.cancelled === 1 ? "" : "s"}.`);
      } else toast.error(r.message);
    } catch (e) {
      toast.error(describeTxError(e));
    } finally {
      setBusy(null);
    }
  }

  async function cancelOnChain() {
    // One past the highest nonce shown kills every one of them, in every market.
    const top = orders.reduce((m, o) => (o.nonce > m ? o.nonce : m), 0n) + 1n;
    setBusy("chain");
    try {
      await trading.cancelOnChainUpTo(top);
      toast.success("Cancelled on chain: every order placed so far is now unfillable.");
    } catch (e) {
      toast.error(describeTxError(e));
    } finally {
      setBusy(null);
    }
  }

  const cols = ["Time", "Market", "Side", "Price", "Size", "Filled", "Expires", "Status", ""];

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-2">
        <button
          onClick={() => void cancelAll()}
          disabled={!ready || busy !== null}
          className="rounded-[6px] border border-[#334155] bg-[#212128] px-3 py-1 text-[11.5px] font-semibold text-[#f5f5f5] transition-colors hover:border-[#475569] disabled:opacity-40"
          title="Signed off-chain cancel: free and instant, stops the matcher"
        >
          {busy === "all" ? "Cancelling…" : marketFilter === "all" ? "Cancel all" : "Cancel all in market"}
        </button>
        <button
          onClick={() => void cancelOnChain()}
          disabled={!ready || busy !== null}
          className="rounded-[6px] border border-[#7c2d12] bg-[#2a1a12] px-3 py-1 text-[11.5px] font-semibold text-[#fdba74] transition-colors hover:brightness-110 disabled:opacity-40"
          title="OrderGateway.cancelUpTo: one transaction (USDC gas). Every order you have placed so far, in every market, becomes permanently unfillable."
        >
          {busy === "chain" ? "Confirm in wallet…" : "Cancel all on chain"}
        </button>
      </div>
      <div className="overflow-x-auto no-scrollbar">
        <table className="w-full min-w-[760px] text-[12px] tabular">
          <thead>
            <tr className="text-[10px] font-semibold uppercase tracking-wider text-[#737373]">
              {cols.map((h, i) => (
                <th
                  key={h || "action"}
                  className={`whitespace-nowrap py-[9px] ${i === 0 ? "pl-4 pr-2 text-left" : i === 1 ? "px-3 text-left" : i === cols.length - 1 ? "pl-2 pr-4 text-right" : "px-3 text-right"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const p = byId[o.marketId] ?? displayFor(`#${o.marketId}`);
              const isRequested = requested.has(o.orderHash);
              const status = o.nonceInvalidated
                ? "Cancelled on chain"
                : o.expired
                  ? "Expired"
                  : isRequested
                    ? "Cancel requested"
                    : o.pendingSize > 0n
                      ? "Settling"
                      : o.filledSize > 0n
                        ? "Partly filled"
                        : "Open";
              return (
                <tr key={o.orderHash} className="border-t border-[#2A2A31] transition-colors hover:bg-white/[0.02]">
                  <td className="py-[10px] pl-4 pr-2 text-left text-[#a3a3a3]">
                    {new Date(o.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </td>
                  <td className="px-3 py-[10px] text-left">
                    <MarketCell marketId={o.marketId} size={15} className="font-semibold text-[#f5f5f5]" />
                  </td>
                  <td className={`px-3 py-[10px] text-right font-medium ${o.isLong ? "text-[#1fae5b]" : "text-[#e34c4c]"}`}>
                    {o.isLong ? "Buy" : "Sell"}
                    {o.reduceOnly && <span className="ml-1 text-[10px] text-[#a3a3a3]">RO</span>}
                  </td>
                  <td className="px-3 py-[10px] text-right text-[#f5f5f5]">{formatPrice(p, o.limitPrice)}</td>
                  <td className="px-3 py-[10px] text-right text-[#f5f5f5]">{formatSize(p, o.size)}</td>
                  <td className="px-3 py-[10px] text-right text-[#a3a3a3]" title="Settled on chain, plus any fill still settling">
                    {formatSize(p, o.filledSize)}
                    {o.pendingSize > 0n && <span className="text-[#fbbf24]"> +{formatSize(p, o.pendingSize)}</span>}
                  </td>
                  <td className="px-3 py-[10px] text-right text-[#a3a3a3]">
                    {new Date(Number(o.expiry) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td className={`px-3 py-[10px] text-right ${isRequested || o.nonceInvalidated ? "text-[#fbbf24]" : "text-[#a3a3a3]"}`}>{status}</td>
                  <td className="py-[10px] pl-2 pr-4 text-right">
                    <button
                      onClick={() => void cancelOne(o)}
                      disabled={!ready || busy !== null || isRequested || o.nonceInvalidated}
                      className="rounded-[5px] border border-[#334155] px-2 py-[2px] text-[11px] font-semibold text-[#f5f5f5] transition-colors hover:border-[#e34c4c] hover:text-[#e34c4c] disabled:opacity-40"
                    >
                      {busy === o.orderHash ? "…" : "Cancel"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-[#a3a3a3]">
      <span className="text-[13px]">{text}</span>
    </div>
  );
}
