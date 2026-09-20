"use client";

import { Shuffle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { UsdcLogo, logoFor } from "@/components/common/AssetLogos";
import { useAccountRates } from "@/features/account/chain";
import { useCollateralDialog } from "@/features/account/collateral";
import { usePositions } from "@/features/account/queries";
import { useTrading } from "@/features/account/useTrading";
import { maxLeverage, type ArcMarket } from "@/features/markets/directory";
import { useWallet } from "@/features/wallet/useWallet";
import { E18, formatFixed, formatRateBps, formatSize, formatUsd, formatUsdPrice, parseAmount, priceInput } from "@/lib/format";
import { evaluateTicket, maxOrderSize, TICKET_ERROR_TEXT, type OrderKind, type Side } from "@/lib/market/order-ticket";
import { useMarketStore } from "@/stores/market";

const EXPIRIES = [
  { label: "1 hour", seconds: 3_600n },
  { label: "1 day", seconds: 86_400n },
  { label: "7 days", seconds: 604_800n },
] as const;

/**
 * Default maximum slippage for market orders, in bps. The real ceiling is the
 * market's execution band: `Engine.applyFill` reverts past it, so slippage
 * beyond it cannot buy a fill, and the ticket cuts it back either way.
 */
const DEFAULT_SLIPPAGE_BPS = 100;

const CheckIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M2 6.5 5 9.5 10 3.5" />
  </svg>
);

/**
 * The order ticket. Every order is an EIP-712 `Order` the wallet signs and the
 * API queues for the matcher; nothing touches the chain until a fill settles.
 *
 * Market orders are aggressive limits: the best opposite price plus a
 * slippage cap, so a thin book can never fill them arbitrarily far away.
 * The margin, minimum-size and reduce-only checks mirror what settlement
 * enforces (lib/market/order-ticket.ts), so an order the contracts would
 * reject is caught here with a reason instead of failing after the match.
 */
export function OrderEntry({
  market,
  side: sideProp,
  setSide: setSideProp,
}: {
  market: ArcMarket;
  /** Optional controlled side, so the mobile bar can preset long/short. */
  side?: Side;
  setSide?: (v: Side) => void;
}) {
  const wallet = useWallet();
  const { address } = wallet;
  const trading = useTrading(address);
  const a = trading.account.data;
  const { data: rates } = useAccountRates(address);
  const { data: positions = [] } = usePositions(address);
  const showDeposit = useCollateralDialog((s) => s.show);

  const book = useMarketStore((s) => s.orderBooks[market.marketId]);
  const ticker = useMarketStore((s) => s.tickers[market.marketId]);
  const selectedPrice = useMarketStore((s) => s.selectedPrice[market.marketId]);

  const [sideState, setSideState] = useState<Side>("buy");
  const side = sideProp ?? sideState;
  const setSide = setSideProp ?? setSideState;
  const [kind, setKind] = useState<OrderKind>("market");
  const [sizeText, setSizeText] = useState("");
  const [sizeInQuote, setSizeInQuote] = useState(false);
  const [priceText, setPriceText] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [expiryIdx, setExpiryIdx] = useState(1);
  const [slippageText, setSlippageText] = useState(String(DEFAULT_SLIPPAGE_BPS / 100));
  const [placing, setPlacing] = useState(false);

  const indexPrice = ticker?.indexPrice ?? market.indexPrice;
  const bestBid = book?.bids[0]?.price ?? null;
  const bestAsk = book?.asks[0]?.price ?? null;
  const reference = (side === "buy" ? bestAsk : bestBid) ?? (indexPrice > 0n ? indexPrice : null);
  const found = positions.find((p) => p.marketId === market.marketId);
  const position = useMemo(
    () => ({ size: found?.size ?? 0n, openNotional: found?.openNotional ?? 0n }),
    [found?.size, found?.openNotional]
  );
  const accountRates = rates?.[market.marketId] ?? { makerRate: market.makerRate, takerRate: market.takerRate };

  // A price picked in the book or tape becomes a limit price.
  useEffect(() => {
    if (selectedPrice != null && selectedPrice > 0n) {
      queueMicrotask(() => {
        setKind("limit");
        setPriceText(priceInput(market, selectedPrice));
      });
    }
  }, [selectedPrice, market]);

  const limitPrice = kind === "limit" ? parseAmount(priceText, 18) : null;
  const sizePriceBasis = kind === "limit" ? limitPrice : reference;
  const typed = parseAmount(sizeText, 18);
  const size =
    typed === null
      ? null
      : sizeInQuote
        ? sizePriceBasis && sizePriceBasis > 0n
          ? (typed * E18) / sizePriceBasis
          : null
        : typed;
  const maxSlippageBps = market.maxExecutionDeviationBps;
  const slippageBps = Math.min(maxSlippageBps, Math.max(0, Math.round((Number(slippageText) || 0) * 100)));

  const ticket = useMemo(
    () =>
      evaluateTicket({
        market,
        side,
        kind,
        size,
        limitPrice,
        slippageBps,
        reduceOnly,
        postOnly: kind === "limit" && postOnly,
        bestBid,
        bestAsk,
        indexPrice,
        position,
        health: a ?? null,
        makerRate: accountRates.makerRate,
        takerRate: accountRates.takerRate,
      }),
    [market, side, kind, size, limitPrice, slippageBps, reduceOnly, postOnly, bestBid, bestAsk, indexPrice, position, a, accountRates.makerRate, accountRates.takerRate]
  );

  const sizeStep = 10n ** BigInt(18 - market.sizeDecimals);
  const headroom = a ? a.equity - a.initialMarginRequired : 0n;
  const maxSize =
    reference && a ? maxOrderSize({ headroom, price: reference, initialMarginBps: market.initialMarginBps, takerRate: accountRates.takerRate, step: sizeStep }) : 0n;

  const setSizeFraction = (pct: bigint) => {
    const base = reduceOnly && position.size !== 0n ? (position.size < 0n ? -position.size : position.size) : maxSize;
    const s = ((base * pct) / 100n / sizeStep) * sizeStep;
    if (s <= 0n) return;
    if (sizeInQuote && sizePriceBasis) setSizeText(formatFixed((s * sizePriceBasis) / E18, 18, 2, { grouping: false, rounding: "down" }));
    else setSizeText(formatFixed(s, 18, market.sizeDecimals, { grouping: false, rounding: "down" }));
  };

  const hasCollateral = !!a && (a.ledger > 0n || a.equity > 0n);
  const blocking = ticket.errors.filter((e) => !(e === "no_size" && sizeText === ""));

  async function submit() {
    if (!wallet.ready || ticket.errors.length > 0 || size === null || ticket.limitPrice === null) return;
    setPlacing(true);
    try {
      const r = await trading.submit({
        marketId: market.marketId,
        isLong: side === "buy",
        size,
        limitPrice: ticket.limitPrice,
        reduceOnly,
        ttlSeconds: EXPIRIES[expiryIdx].seconds,
      });
      if (r.ok) {
        toast.success(
          `${side === "buy" ? "Buy" : "Sell"} ${formatSize(market, size)} ${market.baseAsset} ${
            ticket.crosses ? "sent to match" : "resting"
          }${r.duplicate ? " (already placed)" : ""}`
        );
        setSizeText("");
      } else {
        toast.error(r.message);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(/reject|denied/i.test(msg) ? "You rejected the signature in your wallet." : msg);
    } finally {
      setPlacing(false);
    }
  }

  const rowCls = "flex justify-between items-center text-[12px] text-[#a3a3a3]";
  const posText =
    position.size === 0n ? "—" : `${position.size > 0n ? "Long" : "Short"} ${formatSize(market, position.size < 0n ? -position.size : position.size)} ${market.baseAsset}`;

  let action: { label: string; onClick: () => void; tone: "neutral" | "side"; disabled?: boolean };
  if (!wallet.connected) action = { label: wallet.connecting ? "Connecting…" : "Connect Wallet", onClick: wallet.connect, tone: "neutral", disabled: wallet.connecting };
  else if (wallet.wrongNetwork)
    action = { label: wallet.switching ? "Switching…" : "Switch Network", onClick: () => void wallet.switchToExpected(), tone: "neutral", disabled: wallet.switching };
  else if (a && !hasCollateral) action = { label: "Deposit USDC to Trade", onClick: () => showDeposit("deposit"), tone: "neutral" };
  else
    action = {
      label: placing
        ? "Sign in your wallet…"
        : `${side === "buy" ? "Buy / Long" : "Sell / Short"} ${kind === "market" ? "Market" : "Limit"}`,
      onClick: () => void submit(),
      tone: "side",
      disabled: placing || ticket.errors.length > 0 || !trading.ready,
    };

  return (
    <div className="relative flex flex-col">
      <div className="flex flex-col gap-[10px] p-3">
        {/* Long / Short */}
        <div className="grid grid-cols-2 overflow-hidden rounded-[9px] border border-[#334155] bg-[#212128]">
          {(["buy", "sell"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              aria-pressed={side === s}
              className={`py-[9px] text-center text-[12.5px] font-semibold transition-colors ${
                side === s ? (s === "buy" ? "bg-[#1fae5b] text-white" : "bg-[#e8716f] text-white") : "text-[#a3a3a3] hover:text-[#f5f5f5]"
              }`}
            >
              {s === "buy" ? "Long/Buy" : "Short/Sell"}
            </button>
          ))}
        </div>

        {/* Order type + limit price */}
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(116px,1fr)] gap-2">
          <div className="grid h-[36px] grid-cols-2 rounded-[8px] bg-[#212128] p-[2px]">
            {(["market", "limit"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                className={`rounded-[6px] text-[11.5px] font-bold capitalize transition-colors ${
                  kind === k ? "border border-[#46d985] bg-[#24332c] text-[#46d985]" : "text-[#8f98aa] hover:text-[#f5f5f5]"
                }`}
                onClick={() => {
                  setKind(k);
                  if (k === "market") setPostOnly(false);
                  if (k === "limit" && !priceText && reference) setPriceText(priceInput(market, reference));
                }}
              >
                {k}
              </button>
            ))}
          </div>
          {kind === "limit" ? (
            <label className="flex h-[36px] min-w-0 items-center justify-end gap-2 rounded-[8px] bg-[#212128] px-3">
              <span className="font-mono text-[12.5px] font-medium text-[#8f98aa]">$</span>
              <input
                aria-label="Limit price"
                inputMode="decimal"
                className="min-w-0 flex-1 bg-transparent text-right font-mono text-[12.5px] font-medium text-[#f5f5f5] outline-none placeholder:text-[#737373]"
                placeholder={reference ? priceInput(market, reference) : "0"}
                value={priceText}
                onChange={(e) => setPriceText(e.target.value.replace(/[^0-9.]/g, ""))}
              />
            </label>
          ) : (
            <label
              className="flex h-[36px] items-center justify-end gap-1 rounded-[8px] bg-[#212128] px-3 text-[11.5px] text-[#8f98aa]"
              title={`Maximum distance past the best price a market order may fill. This market settles nothing more than ${maxSlippageBps / 100}% from the index, so that is the most it can use.`}
            >
              Slippage
              <input
                aria-label="Maximum slippage percent"
                inputMode="decimal"
                className="w-[38px] bg-transparent text-right font-mono text-[12.5px] text-[#f5f5f5] outline-none"
                value={slippageText}
                onChange={(e) => setSlippageText(e.target.value.replace(/[^0-9.]/g, ""))}
              />
              %
            </label>
          )}
        </div>

        <div className={rowCls}>
          <span>Available to Trade</span>
          <span className="font-mono text-[#f5f5f5]">{a ? formatUsd(headroom > 0n ? headroom : 0n, { rounding: "down" }) : "—"}</span>
        </div>
        <div className={rowCls}>
          <span>Position</span>
          <span className={`font-mono ${position.size > 0n ? "text-[#1fae5b]" : position.size < 0n ? "text-[#e8716f]" : "text-[#737373]"}`}>{posText}</span>
        </div>

        {/* Size */}
        <div className="flex flex-col gap-1 rounded-[9px] border border-[#334155] bg-[#212128] p-2">
          <label htmlFor="order-size" className="text-[12px] text-[#a3a3a3]">
            Order Size
          </label>
          <input
            id="order-size"
            inputMode="decimal"
            className="w-full flex-1 border-0 bg-transparent text-right font-mono text-[17px] font-medium text-[#f5f5f5] outline-none"
            placeholder="0"
            value={sizeText}
            onChange={(e) => setSizeText(e.target.value.replace(/[^0-9.]/g, ""))}
          />
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                setSizeInQuote((v) => !v);
                setSizeText("");
              }}
              className="flex items-center gap-1.5 rounded-[6px] border border-[#334155] bg-[#212128] px-2 py-[3px] text-[12px] font-medium text-[#f5f5f5] transition-colors hover:border-[#475569]"
              title="Enter the size in the base asset or in USDC"
            >
              {sizeInQuote ? <UsdcLogo size={15} /> : logoFor(market.baseAsset, 15)}
              {sizeInQuote ? market.quoteAsset : market.baseAsset}
              <Shuffle size={13} className="text-[#a3a3a3]" />
            </button>
            <span className="font-mono text-[11px] text-[#737373]">
              {sizeInQuote ? (size ? `${formatSize(market, size)} ${market.baseAsset}` : "") : ticket.notional > 0n ? formatUsd(ticket.notional) : ""}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1 pt-1">
            {([25n, 50n, 75n, 100n] as const).map((p) => (
              <button
                key={String(p)}
                type="button"
                disabled={!a || (reduceOnly ? position.size === 0n : maxSize === 0n)}
                onClick={() => setSizeFraction(p)}
                className="rounded-[5px] bg-[#2a2a31] py-[3px] text-[10.5px] font-semibold text-[#a3a3a3] transition-colors hover:text-[#f5f5f5] disabled:opacity-40"
              >
                {p === 100n ? "Max" : `${p}%`}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-[2px]">
          <CheckBox checked={reduceOnly} onChange={setReduceOnly} label="Reduce Only" />
          <CheckBox
            checked={postOnly && kind === "limit"}
            onChange={(v) => {
              if (v && kind !== "limit") {
                toast.message("Post-only applies to limit orders.");
                return;
              }
              setPostOnly(v);
            }}
            label="Post Only"
          />
          <label className="flex items-center gap-1 text-[12px] text-[#a3a3a3]">
            Expires
            <select
              value={expiryIdx}
              onChange={(e) => setExpiryIdx(Number(e.target.value))}
              className="rounded-[5px] border border-[#334155] bg-[#212128] px-1 py-[2px] text-[11.5px] text-[#f5f5f5] outline-none"
            >
              {EXPIRIES.map((x, i) => (
                <option key={x.label} value={i}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {blocking.length > 0 && (
          <p role="alert" className="text-[12px] leading-5 text-[#ff9b9b]">
            {TICKET_ERROR_TEXT[blocking[0]]}
            {blocking[0] === "below_min_notional" && ` Minimum ${formatUsd(market.minFillNotional)}.`}
          </p>
        )}

        {blocking.length === 0 && ticket.slippageClamped && (
          <p className="text-[12px] leading-5 text-[#8f98aa]">
            Capped at {maxSlippageBps / 100}%: this market settles no fill further than that from the index price, so
            a wider limit would only rest unfilled.
          </p>
        )}

        <button
          onClick={action.onClick}
          disabled={action.disabled}
          className={`w-full rounded-[9px] py-[13px] text-[13.5px] font-semibold transition disabled:opacity-50 ${
            action.tone === "neutral"
              ? "bg-[#f5f5f5] text-[#19191A] hover:bg-[#e5e7eb]"
              : side === "buy"
                ? "bg-[#1fae5b] text-white hover:brightness-110"
                : "bg-[#e8716f] text-white hover:brightness-110"
          }`}
        >
          {action.label}
        </button>

        {/* Preview */}
        <div className="flex flex-col gap-1.5 rounded-[9px] bg-[#212128] p-3">
          <div className={rowCls}>
            <span>{ticket.crosses ? "Expected Fill" : kind === "market" ? "Price Limit" : "Limit Price"}</span>
            <span className="font-mono text-[#f5f5f5]">{formatUsdPrice(market, ticket.execPrice)}</span>
          </div>
          {kind === "market" && ticket.limitPrice !== null && (
            <div className={rowCls}>
              <span>Worst Price ({(slippageBps / 100).toFixed(2)}%)</span>
              <span className="font-mono text-[#f5f5f5]">{formatUsdPrice(market, ticket.limitPrice)}</span>
            </div>
          )}
          <div className={rowCls}>
            <span>Order Value</span>
            <span className="font-mono text-[#f5f5f5]">{formatUsd(ticket.notional)}</span>
          </div>
          <div className={rowCls}>
            <span title={`Initial margin: ${market.initialMarginBps / 100}% of notional (up to ${maxLeverage(market)}x)`}>Margin Required</span>
            <span className="font-mono text-[#f5f5f5]">{formatUsd(ticket.orderMargin, { rounding: "up" })}</span>
          </div>
          <div className={rowCls}>
            <span>Est. Liquidation Price</span>
            <span className={`font-mono ${ticket.liquidationPrice ? "text-amber-400" : "text-[#f5f5f5]"}`}>
              {ticket.liquidationPrice ? formatUsdPrice(market, ticket.liquidationPrice) : "—"}
            </span>
          </div>
          <div className={rowCls}>
            <span title={`${ticket.crosses ? "Taker" : "Maker"} rate for your account`}>
              Fee ({formatRateBps(ticket.crosses ? accountRates.takerRate : accountRates.makerRate)})
            </span>
            <span className="font-mono text-[#f5f5f5]">{formatUsd(ticket.fee, { dp: 4 })}</span>
          </div>
          <p className="pt-1 text-[10.5px] leading-4 text-[#737373]">
            Estimates at the current index price, excluding funding. Settlement on chain is final.
          </p>
        </div>
      </div>
    </div>
  );
}

function CheckBox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="checkbox"
      aria-checked={checked}
      className={`flex items-center gap-2 text-[12.5px] transition-colors ${checked ? "text-[#f5f5f5]" : "text-[#a3a3a3]"}`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`grid h-[14px] w-[14px] place-items-center rounded-[3px] border transition-colors ${
          checked ? "border-[#f5f5f5] bg-[#f5f5f5] text-[#19191A]" : "border-[#475569] bg-[#212128]"
        }`}
      >
        {checked && <CheckIcon />}
      </span>
      {label}
    </button>
  );
}
