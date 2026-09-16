"use client";

import { useState, useEffect } from "react";
import { useWalletStore } from "@/stores/wallet";
import { useMarketStore } from "@/stores/market";
import { MarketConfig, AMOUNT_PRECISION, PRICE_PRECISION, ASSETS, NETWORK_LABEL } from "@/config";
import { buildOrderIntent } from "@/lib/market/order-intent";
import { submitOrder } from "@/lib/market/matcher";
import { useLocalOrders } from "@/stores/orders";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getBalance, getAccountHealth } from "@/lib/stellar/contracts";
import { amountToHuman, formatMarketPrice, formatMarketUsd, priceToHuman, toPriceInput } from "@/lib/format";
import { freighterConnect, freighterIsInstalled, isOnExpectedNetwork } from "@/lib/stellar/freighter";
import { calcLiqPrice } from "@/lib/math";
import { UsdcLogo, logoFor } from "@/components/common/AssetLogos";
import { useTradeSettings } from "@/stores/settings";
import { Shuffle, X } from "lucide-react";

/* ── Icons ── */
const SwapIcon = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M7 7h13l-3-3M17 17H4l3 3" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M2 6.5 5 9.5 10 3.5" />
  </svg>
);
const EditIcon = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);

/* ── Main OrderEntry ── */
export function OrderEntry({
  market,
  side: sideProp,
  setSide: setSideProp,
}: {
  market: MarketConfig;
  /** Optional controlled side — lets the mobile bottom bar preset long/short. */
  side?: "buy" | "sell";
  setSide?: (v: "buy" | "sell") => void;
}) {
  const { address, connected, connecting, setAddress, setConnected, setConnecting, setWrongNetwork } =
    useWalletStore();
  const queryClient = useQueryClient();
  const addOrder = useLocalOrders((s) => s.addOrder);
  const localOrders = useLocalOrders((s) => s.orders);
  const rawMarkPrice = useMarketStore((s) => s.markPrices[market.marketId]);
  const book = useMarketStore((s) => s.orderBooks[market.marketId]);
  const selectedPrice = useMarketStore((s) => s.selectedPrice[market.marketId]);
  const degenMode = useTradeSettings((s) => s.degenMode);
  const setDegenMode = useTradeSettings((s) => s.setDegenMode);

  const [sideState, setSideState] = useState<"buy" | "sell">("buy");
  const side = sideProp ?? sideState;
  const setSide = setSideProp ?? setSideState;
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [size, setSize] = useState("");
  const [sizeInQuote, setSizeInQuote] = useState(false);
  const [limitPrice, setLimitPrice] = useState("");
  const [tpPrice, setTpPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [tpGain, setTpGain] = useState("");
  const [slLoss, setSlLoss] = useState("");
  const [tpGainUnit, setTpGainUnit] = useState<"percent" | "quote">("percent");
  const [slLossUnit, setSlLossUnit] = useState<"percent" | "quote">("percent");
  const [degenPromptOpen, setDegenPromptOpen] = useState(false);

  const sanitizeNumericInput = (val: string): string => {
    // Allow only digits and a single decimal point; strip leading zeros
    const cleaned = val.replace(/[^0-9.]/g, "").replace(/^0+(\d)/, "$1");
    const parts = cleaned.split(".");
    return parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : cleaned;
  };
  const [leverage, setLeverage] = useState(15);
  const [reduce, setReduce] = useState(false);
  const [post, setPost] = useState(false);
  const [tpsl, setTpsl] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fastPoll, setFastPoll] = useState(false);

  // Leverage cap always follows the market config (which mirrors the on-chain
  // engine limits) — degen mode must not advertise leverage the chain rejects.
  const maxLev = Math.round(market.maxLeverageBps / 10000);
  const effectiveLeverage = Math.min(leverage, maxLev);
  const levMarks = [1, 2, 5, 10, 25, 50, maxLev].filter(
    (v, i, arr) => v >= 1 && v <= maxLev && arr.indexOf(v) === i
  );

  // Picking a price in the order book / trades feed loads it as a limit price.
  useEffect(() => {
    if (selectedPrice != null && selectedPrice > 0) {
      queueMicrotask(() => {
        setOrderType("limit");
        setLimitPrice(toPriceInput(market, selectedPrice));
      });
    }
  }, [selectedPrice, market]);

  const { data: balance } = useQuery({
    queryKey: ["balance", address],
    queryFn: () => getBalance(address!, ASSETS.usdc),
    enabled: !!address && connected,
    refetchInterval: fastPoll ? 2_000 : 10_000,
  });

  const { data: health } = useQuery({
    queryKey: ["health", address],
    queryFn: () => getAccountHealth(address!, ASSETS.usdc),
    enabled: !!address && connected,
    refetchInterval: fastPoll ? 2_000 : 10_000,
  });

  // Available to trade = free collateral (balance minus locked margin).
  // Falls back to raw vault balance when no positions exist yet.
  const availableToTrade: bigint = health?.freeCollateral ?? balance ?? 0n;

  // ── Live mid price: oracle mark → orderbook mid → fallback 0 ───────────────
  const midPriceHuman: number | null = (() => {
    if (rawMarkPrice && rawMarkPrice > 0n) return priceToHuman(rawMarkPrice);
    if (book?.asks[0] && book?.bids[0]) {
      return (parseFloat(book.asks[0].price) + parseFloat(book.bids[0].price)) / 2;
    }
    return null;
  })();

  const sizeNum = parseFloat(size) || 0;
  const limitPriceNum = parseFloat(limitPrice) || 0;
  const baseSymbol = market.baseAsset;
  const sizeUnit = sizeInQuote ? market.quoteAsset : baseSymbol;
  const midDisplay = midPriceHuman !== null ? formatMarketPrice(market, midPriceHuman) : "—";

  const execPrice = orderType === "market" ? midPriceHuman ?? 0 : limitPriceNum;
  const bestAsk = book?.asks[0] ? parseFloat(book.asks[0].price) : null;
  const bestBid = book?.bids[0] ? parseFloat(book.bids[0].price) : null;
  const baseSizeNum = sizeInQuote && execPrice > 0 ? sizeNum / execPrice : sizeNum;

  const orderValue = baseSizeNum > 0 && execPrice > 0
    ? (baseSizeNum * execPrice).toFixed(2)
    : "0.00";
  const marginRequired = baseSizeNum > 0 && execPrice > 0
    ? (baseSizeNum * execPrice / effectiveLeverage).toFixed(2)
    : "0.00";

  // Estimated liquidation price
  const liqPriceDisplay = (() => {
    if (baseSizeNum <= 0 || execPrice <= 0) return "—";
    const entryRaw = BigInt(Math.round(execPrice * Number(PRICE_PRECISION)));
    const liq = calcLiqPrice(
      side === "buy",
      entryRaw,
      effectiveLeverage,
      market.maintenanceMarginBps
    );
    if (liq <= 0n) return "—";
    return formatMarketUsd(market, liq);
  })();

  async function handleConnect() {
    const installed = await freighterIsInstalled();
    if (!installed) {
      toast.error("Freighter not found — install from freighter.app then refresh.");
      return;
    }
    setConnecting(true);
    try {
      const addr = await freighterConnect();
      setAddress(addr);
      setConnected(true);
      const ok = await isOnExpectedNetwork();
      setWrongNetwork(!ok);
      if (!ok) toast.warning("Switch Freighter to the configured Stellar network.");
      else toast.success("Wallet connected");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setConnecting(false);
    }
  }

  async function handleSubmit() {
    if (!address || !connected) { toast.error("Connect your wallet first"); return; }
    // Re-check live in case user switched networks in Freighter after connecting
    const onCorrectNetwork = await isOnExpectedNetwork();
    if (!onCorrectNetwork) {
      setWrongNetwork(true);
      toast.error(`Freighter is on the wrong network — switch to ${NETWORK_LABEL} and try again.`);
      return;
    }
    setWrongNetwork(false);
    if (!size || sizeNum <= 0) { toast.error("Enter a valid size"); return; }
    if (execPrice <= 0) {
      toast.error(orderType === "market" ? "Waiting for a market price" : "Enter a limit price"); return;
    }
    if (sizeInQuote && baseSizeNum <= 0) {
      toast.error("Waiting for a price to convert the order size");
      return;
    }
    if (post && orderType !== "limit") {
      toast.error("Post Only is only available for limit orders");
      return;
    }
    if (post && orderType === "limit") {
      const wouldCross = side === "buy"
        ? bestAsk !== null && limitPriceNum >= bestAsk
        : bestBid !== null && limitPriceNum <= bestBid;
      if (wouldCross) {
        toast.error("Post Only order would execute immediately");
        return;
      }
    }
    if (showTpSl && tpsl && !tpPrice && !slPrice && !tpGain && !slLoss) {
      toast.error("Enter a take-profit or stop-loss value");
      return;
    }

    // Self-trade heads-up: the matcher never matches two orders from the same
    // wallet, so an order that only crosses the user's own resting order will
    // sit unfilled until a different wallet takes the other side.
    const wouldSelfCross = localOrders.some((o) => {
      if (o.status !== "pending" || o.owner !== address || o.marketId !== market.marketId) return false;
      if (o.isLong === (side === "buy")) return false;
      if (orderType === "market") return true; // market orders cross any resting price
      const restingPrice = priceToHuman(o.limitPrice);
      return side === "buy" ? limitPriceNum >= restingPrice : limitPriceNum <= restingPrice;
    });
    if (wouldSelfCross) {
      toast.warning(
        "This order crosses your own resting order. Self-matches are skipped — it will only fill against another wallet."
      );
    }

    // Client-side margin check — prevents orders that would fail on-chain settlement
    const marginRequiredNum = parseFloat(marginRequired);
    if (marginRequiredNum > 0 && availableToTrade !== undefined) {
      const availableHuman = amountToHuman(availableToTrade);
      if (marginRequiredNum > availableHuman) {
        toast.error(
          `Insufficient balance — $${marginRequiredNum.toFixed(2)} required, $${availableHuman.toFixed(2)} available. Deposit more collateral or reduce size.`
        );
        return;
      }
    }

    setLoading(true);
    try {
      const rawSize = BigInt(Math.round(baseSizeNum * Number(AMOUNT_PRECISION)));
      // Market orders use an aggressive limit price so the on-chain validate_order
      // (which requires limit_price > 0) accepts the settlement.
      // Buys use 2× mark price; sells use 0.5× — both cross any resting order immediately.
      const rawPrice = orderType === "market"
        ? (() => {
            const mark = rawMarkPrice && rawMarkPrice > 0n
              ? rawMarkPrice
              : BigInt(Math.round(execPrice * Number(PRICE_PRECISION)));
            return side === "buy" ? mark * 2n : mark / 2n || 1n;
          })()
        : BigInt(Math.round(limitPriceNum * Number(PRICE_PRECISION)));

      const intent = buildOrderIntent({
        owner: address,
        marketId: market.marketId,
        isLong: side === "buy",
        size: rawSize,
        limitPrice: rawPrice,
        reduceOnly: reduce,
        ttlSeconds: 3600,
      });
      const result = await submitOrder(intent);
      if (result.ok) {
        addOrder(intent);
        toast.success(
          `${orderType === "market" ? "Market" : "Limit"} ${side} order submitted` +
          (post ? " as post-only" : "") +
          (reduce ? " reduce-only" : "")
        );
        if (showTpSl && tpsl) toast.message("TP/SL values are staged in the ticket; trigger order submission is not yet supported by the matcher.");
        // Immediately refetch all user-facing data and poll fast for 30s to catch on-chain settlement
        queryClient.invalidateQueries({ queryKey: ["balance", address] });
        queryClient.invalidateQueries({ queryKey: ["health", address] });
        queryClient.invalidateQueries({ queryKey: ["fills", address] });
        queryClient.invalidateQueries({ queryKey: ["positions", address] });
        setFastPoll(true);
        setTimeout(() => setFastPoll(false), 30_000);
      } else {
        toast.error(result.error ?? "Order rejected");
      }
      setSize("");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  const rowCls = "flex justify-between items-center text-[12px] text-[#a3a3a3]";
  const valCls = "text-[#737373] font-mono";
  const showTpSl = false;
  // Degen mode: kept in code but hidden for v1 — its old 500x cap exceeded the
  // on-chain max leverage, so the toggle only misled users.
  const showDegenMode = false;

  return (
    <div className="relative flex flex-col">
      <div className="flex flex-col gap-[10px] p-3">
        {/* Long / Short */}
        <div className="grid grid-cols-2 rounded-[9px] overflow-hidden bg-[#212128] border border-[#334155]">
          <button
            onClick={() => setSide("buy")}
            className={`py-[9px] text-center text-[12.5px] font-semibold transition-colors ${
              side === "buy" ? "bg-[#1fae5b] text-white" : "text-[#a3a3a3] hover:text-[#f5f5f5]"
            }`}
          >
            Long/Buy
          </button>
          <button
            onClick={() => setSide("sell")}
            className={`py-[9px] text-center text-[12.5px] font-semibold transition-colors ${
              side === "sell" ? "bg-[#e8716f] text-white" : "text-[#a3a3a3] hover:text-[#f5f5f5]"
            }`}
          >
            Short/Sell
          </button>
        </div>

        {/* Order type + price display */}
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(116px,1fr)] gap-2">
          <div className="grid h-[36px] grid-cols-2 rounded-[8px] bg-[#212128] p-[2px]">
            <button
              type="button"
              className={`rounded-[6px] text-[11.5px] font-bold transition-colors ${
                orderType === "market"
                  ? "border border-[#46d985] bg-[#24332c] text-[#46d985]"
                  : "text-[#8f98aa] hover:text-[#f5f5f5]"
              }`}
              onClick={() => {
                setOrderType("market");
                setPost(false);
                if (midPriceHuman && !limitPrice) setLimitPrice(toPriceInput(market, midPriceHuman));
              }}
            >
              Market
            </button>
            <button
              type="button"
              className={`rounded-[6px] text-[11.5px] font-bold transition-colors ${
                orderType === "limit"
                  ? "border border-[#46d985] bg-[#24332c] text-[#46d985]"
                  : "text-[#8f98aa] hover:text-[#f5f5f5]"
              }`}
              onClick={() => {
                setOrderType("limit");
                if (midPriceHuman && !limitPrice) setLimitPrice(toPriceInput(market, midPriceHuman));
              }}
            >
              Limit
            </button>
          </div>
          {orderType === "limit" ? (
            <div className="flex h-[36px] min-w-0 items-center justify-end gap-2 rounded-[8px] bg-[#212128] px-3">
              <span className="font-mono text-[12.5px] font-medium text-[#8f98aa]">$</span>
              <input
                className="min-w-0 flex-1 bg-transparent text-right font-mono text-[12.5px] font-medium text-[#f5f5f5] outline-none placeholder:text-[#737373]"
                placeholder={midDisplay === "—" ? "0.0000" : midDisplay}
                value={limitPrice}
                onChange={(e) => setLimitPrice(sanitizeNumericInput(e.target.value))}
              />
              <span className="rounded-[5px] bg-[#2a2a31] px-2 py-[4px] text-[10.5px] font-semibold text-[#737373]">
                LIMIT
              </span>
            </div>
          ) : (
            <div className="h-[36px]" aria-hidden="true" />
          )}
        </div>

        {/* Account info */}
        <div className={rowCls}>
          <span>Available to Trade</span>
          <span className={valCls}>
            {connected && (balance !== undefined || health !== undefined)
              ? `$${amountToHuman(availableToTrade).toFixed(2)}`
              : "—"}
          </span>
        </div>
        <div className={rowCls}>
          <span>Position</span>
          <span className={valCls}>—</span>
        </div>

        {/* Order size field */}
        <div className="bg-[#212128] border border-[#334155] rounded-[9px] p-2 flex flex-col gap-1">
          <div className="flex items-center justify-between text-[12px] text-[#a3a3a3]">
            <div className="flex items-center gap-[5px]">
              <span>Order Size</span>
    
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <input
              className="flex-1 bg-transparent border-0 outline-none text-[#f5f5f5] font-mono text-[17px] font-medium text-right w-full"
              placeholder="0"
              value={size}
              onChange={(e) => setSize(sanitizeNumericInput(e.target.value))}
            />
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setSizeInQuote((v) => !v)}
              className="flex items-center gap-1.5 px-2 py-[3px] bg-[#212128] border border-[#334155] rounded-[6px] text-[#f5f5f5] text-[12px] font-medium transition-colors hover:border-[#475569]"
              title="Toggle order size denomination"
            >
              {sizeInQuote ? <UsdcLogo size={15} /> : logoFor(baseSymbol, 15)}
              {sizeUnit}
              <Shuffle size={13} className="text-[#a3a3a3]" />
            </button>
            <span className="font-mono text-[11px] text-[#737373]">
              ${sizeNum > 0 && execPrice > 0 ? (baseSizeNum * execPrice).toFixed(2) : "0.00"}
            </span>
          </div>
        </div>

        {/* Degen mode */}
        {showDegenMode && (
        <div className="flex items-center justify-between px-1">
          <span className="text-[12px] font-semibold text-[#f5f5f5]">Degen Mode</span>
          <button
            type="button"
            aria-pressed={degenMode}
            onClick={() => {
              if (degenMode) {
                setDegenMode(false);
                setLeverage((v) => Math.min(v, Math.round(market.maxLeverageBps / 10000)));
                return;
              }
              setDegenPromptOpen(true);
            }}
            className={`relative h-[24px] w-[44px] rounded-full border transition-colors ${
              degenMode ? "border-[#e2a9f1] bg-[#e2a9f1]/20" : "border-[#334155] bg-[#212128]"
            }`}
          >
            <span
              className={`absolute left-0 top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full transition-transform ${
                degenMode ? "translate-x-[21px] bg-[#e2a9f1]" : "translate-x-[3px] bg-[#a3a3a3]"
              }`}
            />
          </button>
        </div>
        )}

        {/* Order leverage — inline slider */}
        <div className="px-[2px] py-[2px]">
          <div className="flex items-center justify-between mb-[7px]">
            <span className="flex items-center gap-[6px] text-[12px] text-[#a3a3a3]">
              Order Leverage
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 7h8M8 12h2M12 12h2M16 12h.01M8 16h2M12 16h2M16 16h.01" />
              </svg>
            </span>
            <span className="font-mono text-[14px] font-medium text-[#f5f5f5]">{effectiveLeverage}x</span>
          </div>
          <input
            type="range"
            min={1}
            max={maxLev}
            step={1}
            value={effectiveLeverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
            className="w-full h-[4px] cursor-pointer accent-[#f5f5f5]"
            aria-label="Order leverage"
          />
          <div className="flex justify-between font-mono text-[10.5px] text-[#737373] mt-[6px]">
            {levMarks.map((m) => (
              <span
                key={m}
                className={effectiveLeverage === m ? "text-[#f5f5f5]" : ""}
              >
                {m}x
              </span>
            ))}
          </div>
        </div>

        {/* Checkboxes */}
        <div className="flex justify-between pt-[2px]">
          <CheckBox checked={reduce} onChange={setReduce} label="Reduce Only" />
          <CheckBox
            checked={post}
            onChange={(v) => {
              if (v && orderType !== "limit") {
                toast.error("Post Only is only available for limit orders");
                return;
              }
              setPost(v);
            }}
            label="Post Only"
          />
        </div>
        {showTpSl && <CheckBox checked={tpsl} onChange={setTpsl} label="Take Profit / Stop Loss" />}
        {showTpSl && tpsl && (
          <div className="grid grid-cols-2 gap-2">
            <TpSlBox label="TP Price" prefix="$" value={tpPrice} onChange={setTpPrice} placeholder="0" />
            <TpSlBox
              label="Gain"
              suffix={tpGainUnit === "percent" ? "%" : " USDC"}
              value={tpGain}
              onChange={setTpGain}
              onToggleUnit={() => setTpGainUnit((u) => (u === "percent" ? "quote" : "percent"))}
            />
            <TpSlBox label="SL Price" prefix="$" value={slPrice} onChange={setSlPrice} placeholder="0" />
            <TpSlBox
              label="Loss"
              suffix={slLossUnit === "percent" ? "%" : " USDC"}
              value={slLoss}
              onChange={setSlLoss}
              onToggleUnit={() => setSlLossUnit((u) => (u === "percent" ? "quote" : "percent"))}
            />
          </div>
        )}

        {/* Place order button */}
        {!connected ? (
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="w-full py-[13px] rounded-[9px] text-[13.5px] font-semibold text-[#19191A] transition-colors disabled:opacity-50"
            style={{ background: "#f5f5f5", letterSpacing: ".01em" }}
            onMouseOver={(e) => (e.currentTarget.style.background = "#e5e7eb")}
            onMouseOut={(e) => (e.currentTarget.style.background = "#f5f5f5")}
          >
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={loading || (parseFloat(marginRequired) > 0 && parseFloat(marginRequired) > amountToHuman(availableToTrade))}
            className={`w-full py-[13px] rounded-[9px] text-[13.5px] font-semibold text-white transition-colors disabled:opacity-50 ${
              side === "buy"
                ? "bg-[#1fae5b] hover:brightness-110"
                : "bg-[#e8716f] hover:brightness-110"
            }`}
          >
            {loading
              ? "Placing…"
              : parseFloat(marginRequired) > 0 && parseFloat(marginRequired) > amountToHuman(availableToTrade)
              ? "Insufficient Balance"
              : `Place ${side === "buy" ? "Long" : "Short"} ${orderType === "market" ? "Market" : "Limit"} Order`}
          </button>
        )}

        {/* Order summary */}
        <div className="flex flex-col gap-1.5 rounded-[9px] bg-[#212128] p-3">
          <div className={rowCls}>
            <span>{orderType === "market" ? "Expected Price" : "Limit Price"}</span>
            <span className="font-mono text-[#f5f5f5]">
              {execPrice > 0 ? formatMarketUsd(market, execPrice) : "—"}
            </span>
          </div>
          <div className={rowCls}>
            <span>Est. Liquidation Price</span>
            <span className={`font-mono ${liqPriceDisplay !== "—" ? "text-amber-400" : "text-[#f5f5f5]"}`}>
              {liqPriceDisplay}
            </span>
          </div>
          <div className={rowCls}>
            <span>Order Value</span>
            <span className="font-mono text-[#f5f5f5]">${orderValue}</span>
          </div>
          <div className={rowCls}>
            <span>Margin Required</span>
            <span className="font-mono text-[#f5f5f5]">${marginRequired}</span>
          </div>
          {orderType === "market" && (
            <div className={rowCls}>
              <span>Slippage</span>
              <span className="flex items-center gap-2 font-mono text-[#f5f5f5]">
                Est: - / Max: 1%
                <span className="text-[#ff9440]"><EditIcon /></span>
              </span>
            </div>
          )}
          <div className={rowCls}>
            <span className="flex items-center gap-[5px]">
              Fees
              {orderType === "limit" && (
                <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 11v5M12 8h.01" />
                </svg>
              )}
            </span>
            <span className="font-mono text-[#f5f5f5]">
              {orderType === "market" ? "0.035%" : "0.035% | 0.005%"}
            </span>
          </div>
        </div>
      </div>

      {degenPromptOpen && (
        <DegenModeModal
          onCancel={() => setDegenPromptOpen(false)}
          onAccept={() => {
            setDegenMode(true);
            setDegenPromptOpen(false);
          }}
        />
      )}
    </div>
  );
}

function DegenModeModal({
  onCancel,
  onAccept,
}: {
  onCancel: () => void;
  onAccept: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onMouseDown={onCancel} />
      <div
        className="relative max-h-[92dvh] w-full max-w-full overflow-y-auto rounded-t-2xl border border-[#334155] bg-[#19191A] p-5 pb-[max(20px,env(safe-area-inset-bottom))] text-[#f5f5f5] shadow-[0_20px_60px_rgba(0,0,0,.6)] sm:w-[420px] sm:rounded-xl sm:pb-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[17px] font-bold text-[#f5f5f5]">Degen Mode</div>
            <div className="mt-1 text-[12px] text-[#a3a3a3]">Confirm elevated leverage risk</div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="w-7 h-7 grid place-items-center rounded-[6px] text-[#a3a3a3] hover:text-[#f5f5f5] hover:bg-[#212128] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-4 rounded-[12px] border border-[#334155] bg-[#212128] p-4">
          <div className="text-center">
            <div className="text-[12px] font-semibold uppercase tracking-[.16em] text-[#a3a3a3]">Are you</div>
            <div className="mt-1 text-[20px] font-black uppercase tracking-[.08em] text-[#f5f5f5]">
              Degen Enough?
            </div>
          </div>
          <div className="my-4 h-px bg-[#2A2A31]" />
          <ul className="space-y-3 text-[13px] leading-5 text-[#d4d4d8]">
            <li className="flex gap-3">
              <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#a3a3a3]" />
              <span>Degen positions can be liquidated extremely quickly during rapid price moves.</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#a3a3a3]" />
              <span>At 500x, every tick matters and small execution delays can materially change risk.</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#a3a3a3]" />
              <span>You are trading at your own risk. Use this mode only when you understand liquidation risk.</span>
            </li>
          </ul>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="h-12 rounded-[10px] border border-[#334155] bg-[#212128] text-[14px] font-semibold text-[#a3a3a3] hover:text-[#f5f5f5] hover:border-[#475569] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="h-12 rounded-[10px] text-[14px] font-bold text-[#19191A] bg-[#e2a9f1] hover:brightness-110 transition"
          >
            Accept & Continue
          </button>
        </div>
        <p className="mt-3 text-center text-[11px] text-[#737373]">
          This only changes the order ticket leverage cap.
        </p>
      </div>
    </div>
  );
}

function TpSlBox({
  label,
  value,
  onChange,
  prefix = "",
  suffix = "",
  placeholder = "0",
  onToggleUnit,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  onToggleUnit?: () => void;
}) {
  const sanitize = (val: string): string => {
    const cleaned = val.replace(/[^0-9.]/g, "").replace(/^0+(\d)/, "$1");
    const parts = cleaned.split(".");
    return parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : cleaned;
  };

  return (
    <div className="flex h-[36px] items-center justify-between gap-2 rounded-[8px] bg-[#212128] px-2.5 text-[11.5px]">
      <span className="text-[#9fb0c9]">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[#9fb0c9]">
        {prefix && <span>{prefix}</span>}
        <input
          className="min-w-0 max-w-[62px] bg-transparent text-right font-mono text-[#f5f5f5] outline-none placeholder:text-[#737373]"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(sanitize(e.target.value))}
        />
        {suffix && <span>{suffix}</span>}
        {onToggleUnit && (
          <button
            type="button"
            onClick={onToggleUnit}
            className="grid h-5 w-5 place-items-center rounded-[5px] bg-[#34343d] text-[#f5f5f5] transition-colors hover:bg-[#3d3d47]"
            aria-label={`Toggle ${label} unit`}
          >
            <SwapIcon />
          </button>
        )}
      </span>
    </div>
  );
}

function CheckBox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      className={`flex items-center gap-2 text-[12.5px] transition-colors ${checked ? "text-[#f5f5f5]" : "text-[#a3a3a3]"}`}
      onClick={() => onChange(!checked)}
    >
      <div
        className={`w-[14px] h-[14px] rounded-[3px] border grid place-items-center transition-colors ${
          checked ? "bg-[#f5f5f5] border-[#f5f5f5] text-[#19191A]" : "bg-[#212128] border-[#475569]"
        }`}
      >
        {checked && <CheckIcon />}
      </div>
      {label}
    </button>
  );
}
