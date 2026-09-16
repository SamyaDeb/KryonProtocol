// Asset marks. Every market's base asset needs one, plus USDC as the
// settlement asset. Prefer <AssetLogo symbol={…} /> or logoFor() over
// importing an individual mark — eight call sites used to read
// `baseSymbol === "XLM" ? <XlmLogo/> : null`, which rendered no mark at all
// for every market that was not XLM.

import type { ReactNode } from "react";

export function Usdt0Logo({ size = 16 }: { size?: number }) {
  // Tether green with the USD₮ tie, plus a ring to read as the omnichain
  // (LayerZero OFT) variant rather than native USDT.
  return (
    <svg width={size} height={size} viewBox="0 0 2000 2000" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="1000" cy="1000" r="1000" fill="#009393" />
      <circle cx="1000" cy="1000" r="880" fill="none" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="55" />
      <path
        fill="#ffffff"
        d="M1128 872v-138h318V522H556v212h318v138c-258 12-452 63-452 124s194 112 452 124v442h254v-442c258-12 452-63 452-124s-194-112-452-124zm0 407v-1c-6 0-39 2-127 2-70 0-119-2-137-2v1c-274-12-478-60-478-117s204-105 478-117v186c18 1 69 4 138 4 84 0 119-3 126-4v-186c273 12 477 60 477 117s-204 105-477 117z"
      />
    </svg>
  );
}

export function UsdcLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 2000 2000" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="1000" cy="1000" r="1000" fill="#2775CA" />
      <path
        fill="#ffffff"
        d="M1275 1158.3c0-141.7-85-190-255-210.4-121.7-16.7-145.8-50-145.8-108.3s41.7-95.8 125-95.8c75 0 116.7 25 137.5 87.5 4.2 12.5 16.7 20.8 29.2 20.8h66.6c16.7 0 29.2-12.5 29.2-29.2v-4.2c-16.7-91.7-91.7-162.5-187.5-170.8v-100c0-16.7-12.5-29.2-33.3-33.3h-62.5c-16.7 0-29.2 12.5-33.3 33.3v95.8c-121.7 16.7-198.3 97.9-198.3 200 0 133.3 81.2 185.4 251.2 205.8 112.5 20.8 148 45.8 148 112.5 0 66.6-58.4 112.5-137.5 112.5-108.3 0-145.8-45.8-158.3-108.3-4.2-16.7-16.7-25-29.2-25h-70.8c-16.7 0-29.2 12.5-29.2 29.2v4.2c16.7 104.2 83.3 179.2 216.6 200v100c0 16.7 12.5 29.2 33.3 33.3h62.5c16.7 0 29.2-12.5 33.3-33.3v-100c121.7-20.8 202.9-108.3 202.9-216.7z"
      />
      <path
        fill="#ffffff"
        d="M787.5 1595.8c-316.6-116.6-479.2-470.8-358.3-783.3 62.5-175 200-308.3 358.3-370.8 16.7-8.3 25-20.8 25-41.7v-58.3c0-16.7-8.3-29.2-25-33.3-4.2 0-12.5 0-16.7 4.2-383.3 121.7-591.6 529.2-470 912.5 70.8 220.8 241.7 391.7 462.5 462.5 16.7 8.3 33.3 0 37.5-16.7 4.2-4.2 4.2-8.3 4.2-16.7v-58.3c0-12.5-12.5-25-17.5-29.2zm462.5-1283.3c-16.7-8.3-33.3 0-37.5 16.7-4.2 4.2-4.2 8.3-4.2 16.7v58.3c0 16.7 12.5 29.2 25 37.5 316.6 116.7 479.1 470.8 358.3 783.3-62.5 175-200 308.3-358.3 370.8-16.7 8.3-25 20.8-25 41.7v58.3c0 16.7 8.3 29.2 25 33.3 4.2 0 12.5 0 16.7-4.2 383.3-121.6 591.6-529.2 470-912.5-70.9-225-245.9-395.8-470-466.7z"
      />
    </svg>
  );
}

export function XlmLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#101010" />
      <path
        d="M24.7 9.3l-2.4 1.2-13 6.6a7.3 7.3 0 0 1-.1-1 7.4 7.4 0 0 1 11.2-6.4l1.4-.7.2-.1A9 9 0 0 0 7.6 17.3l-.9.5-2 1v1.8l2.9-1.4 1-.5 1.4-.7L23 11.2l1.4-.7 2.6-1.3v-1.8l-2.3 1.2z"
        fill="#ffffff"
      />
      <path
        d="M26.9 11.2L9.7 19.9l-1.4.7L5.7 22v1.8L8 22.6l2.4-1.2 13-6.6a7.3 7.3 0 0 1 .1 1 7.4 7.4 0 0 1-11.2 6.4l-.1.1-1.5.7A9 9 0 0 0 24.4 14.7l.9-.5 2-1v-1.8z"
        fill="#ffffff"
      />
    </svg>
  );
}


export function BtcLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#F7931A" />
      <path
        fill="#ffffff"
        d="M22.5 14.2c.3-2-1.2-3-3.3-3.8l.7-2.7-1.7-.4-.7 2.6-1.3-.3.7-2.6-1.6-.4-.7 2.7-1-.3-2.3-.6-.4 1.8s1.2.3 1.2.3c.7.2.8.6.8 1l-.8 3.1v.1l-1.1 4.4c-.1.2-.3.5-.8.4 0 0-1.2-.3-1.2-.3l-.9 1.9 2.2.5 1.2.3-.7 2.7 1.6.4.7-2.7 1.3.3-.7 2.7 1.7.4.7-2.7c2.8.5 4.9.3 5.8-2.2.7-2-.1-3.2-1.5-4 1.1-.2 1.9-.9 2.1-2.4zm-3.7 5.3c-.5 2-3.9.9-5 .7l.9-3.6c1.1.3 4.6.8 4.1 2.9zm.5-5.4c-.5 1.9-3.3.9-4.2.7l.8-3.3c.9.2 3.9.6 3.4 2.6z"
      />
    </svg>
  );
}

export function EthLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#ffffff" fillRule="nonzero">
        <path fillOpacity=".6" d="M16.5 4v8.9l7.5 3.3z" />
        <path d="M16.5 4L9 16.2l7.5-3.3z" />
        <path fillOpacity=".6" d="M16.5 21.9v6.1L24 17.6z" />
        <path d="M16.5 28v-6.1L9 17.6z" />
        <path fillOpacity=".2" d="M16.5 20.5l7.5-4.3-7.5-3.3z" />
        <path fillOpacity=".6" d="M9 16.2l7.5 4.3v-7.6z" />
      </g>
    </svg>
  );
}

export function SolLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#000000" />
      <defs>
        <linearGradient id="kryon-sol-g" x1="4" y1="24" x2="28" y2="8" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="1" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <g fill="url(#kryon-sol-g)">
        <path d="M9.6 20.4c.15-.15.35-.24.56-.24h14.1c.36 0 .53.43.28.68l-2.74 2.74a.8.8 0 0 1-.56.23H7.14c-.35 0-.53-.43-.28-.68l2.74-2.73z" />
        <path d="M9.6 8.42a.8.8 0 0 1 .56-.23h14.1c.36 0 .53.43.28.68l-2.74 2.74a.8.8 0 0 1-.56.23H7.14c-.35 0-.53-.43-.28-.68l2.74-2.74z" />
        <path d="M22.26 14.37a.8.8 0 0 0-.56-.23H7.6c-.36 0-.53.43-.28.68l2.74 2.74c.15.15.35.23.56.23h14.1c.36 0 .53-.43.28-.68l-2.74-2.74z" />
      </g>
    </svg>
  );
}

export function XrpLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#23292F" />
      <path
        fill="#ffffff"
        d="M22.2 8h2.7l-5.6 5.6a4.7 4.7 0 0 1-6.6 0L7.1 8h2.7l4.2 4.2c.9.9 2.5.9 3.4 0L22.2 8zM9.8 24H7.1l5.6-5.6a4.7 4.7 0 0 1 6.6 0L24.9 24h-2.7l-4.2-4.2a2.4 2.4 0 0 0-3.4 0L9.8 24z"
      />
    </svg>
  );
}

export function AdaLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#0033AD" />
      <g fill="#ffffff">
        <circle cx="16" cy="16" r="2.1" />
        <circle cx="16" cy="7.6" r="1.25" />
        <circle cx="16" cy="24.4" r="1.25" />
        <circle cx="8.7" cy="11.8" r="1.25" />
        <circle cx="23.3" cy="20.2" r="1.25" />
        <circle cx="8.7" cy="20.2" r="1.25" />
        <circle cx="23.3" cy="11.8" r="1.25" />
        <circle cx="16" cy="11.4" r=".95" />
        <circle cx="16" cy="20.6" r=".95" />
        <circle cx="12" cy="13.7" r=".95" />
        <circle cx="20" cy="18.3" r=".95" />
        <circle cx="12" cy="18.3" r=".95" />
        <circle cx="20" cy="13.7" r=".95" />
        <circle cx="5.2" cy="16" r=".8" />
        <circle cx="26.8" cy="16" r=".8" />
        <circle cx="10.6" cy="5.9" r=".8" />
        <circle cx="21.4" cy="26.1" r=".8" />
        <circle cx="10.6" cy="26.1" r=".8" />
        <circle cx="21.4" cy="5.9" r=".8" />
      </g>
    </svg>
  );
}

export function BnbLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#F3BA2F" />
      <path
        fill="#ffffff"
        d="M16 6.6l2.6 2.7-6.5 6.5-2.7-2.6L16 6.6zm7.1 7.1l2.6 2.7-9.7 9.7-9.7-9.7 2.6-2.7L16 21l7.1-7.3zm-13.6 2.7L6.9 16l2.6-2.6L12.1 16l-2.6 2.4zm10.4-.4L16 19l-3.2-3.2h.1L16 12.9l3.9 3.1z"
      />
      <path fill="#ffffff" d="M22.5 16l2.6-2.6L27.7 16l-2.6 2.6L22.5 16z" />
    </svg>
  );
}

export function TrxLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#EB0029" />
      <path
        fill="#ffffff"
        d="M23.6 11.3L9.2 8.2c-.3-.1-.5.2-.4.4l6 17.4c.1.3.5.3.6.1l8.4-14.3c.1-.2 0-.4-.2-.5zM21.4 12.6l-2.5 4.3-6.4-5.9 8.9 1.6zM11.3 11.5l6.3 5.8-2.1 6.9-4.2-12.7z"
      />
    </svg>
  );
}

/**
 * Fallback for an asset with no dedicated mark, so a new market still renders
 * something recognisable instead of a hole in the layout.
 */
export function LetterLogo({ symbol, size = 16 }: { symbol: string; size?: number }) {
  const letters = symbol.slice(0, 2).toUpperCase();
  // Deterministic hue from the symbol — stable across renders and reloads.
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) % 360;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="16" cy="16" r="16" fill={`hsl(${h} 42% 34%)`} />
      <text
        x="16"
        y="16"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={letters.length > 1 ? 13 : 16}
        fontWeight="600"
        fill="#ffffff"
        fontFamily="system-ui, sans-serif"
      >
        {letters}
      </text>
    </svg>
  );
}

const LOGOS: Record<string, (p: { size?: number }) => ReactNode> = {
  USDC: UsdcLogo,
  USDT0: Usdt0Logo,
  XLM: XlmLogo,
  BTC: BtcLogo,
  ETH: EthLogo,
  SOL: SolLogo,
  XRP: XrpLogo,
  ADA: AdaLogo,
  BNB: BnbLogo,
  TRX: TrxLogo,
};

/**
 * The mark for an asset symbol. Accepts either a bare asset ("BTC") or a
 * market symbol ("BTC-PERP"). Unknown assets fall back to a lettered circle
 * rather than rendering nothing.
 */
export function logoFor(symbol: string, size = 16): ReactNode {
  const base = (symbol ?? "").replace(/-PERP$/i, "").toUpperCase();
  const Logo = LOGOS[base];
  return Logo ? <Logo size={size} /> : <LetterLogo symbol={base || "?"} size={size} />;
}

/** Component form of logoFor, for JSX call sites. */
export function AssetLogo({ symbol, size = 16 }: { symbol: string; size?: number }) {
  return <>{logoFor(symbol, size)}</>;
}
