/**
 * Market metadata: what the chain owns, and what only the UI owns.
 *
 * WHY THE SPLIT
 * -------------
 * `@/config`'s MARKETS was one hardcoded table holding both, and the two halves
 * drift for different reasons. Risk parameters — margins, leverage, the OI cap,
 * `minFillNotional` — are on-chain state: `RiskParams.setMarketParams` emits
 * `MarketParamsSet`, the indexer projects it into `Market.params`, and the
 * gateway enforces it. A copy of those numbers in the client is a copy that
 * goes stale silently, and the failure is a UI advertising 50x on a market the
 * margin engine will only grant 10x on, or an order the gateway rejects for
 * falling under a `minFillNotional` the client did not know had moved.
 *
 * So: risk parameters come from the database (`lib/queries/markets.ts`), and
 * this module holds only what the chain has no opinion about — how to render a
 * symbol. Price/size decimals, the tick ladder and the TradingView symbol are
 * presentation, they are not derivable from on-chain state, and a wrong one
 * misformats a number rather than mispricing an order.
 *
 * A market with no entry here still trades: `displayFor` derives a usable
 * fallback from the symbol. The table is a refinement, never a gate.
 */

/** Presentation metadata for one symbol. Chain state never lives here. */
export interface MarketDisplay {
  symbol: string;
  displayName: string;
  baseAsset: string;
  quoteAsset: string;
  /** Binance pair the off-chain price sources quote. */
  priceSourceSymbol: string;
  /** TradingView `EXCHANGE:TICKER`. Verified against symbol-search; see the test. */
  tvSymbol: string;
  /** Price display precision. 1 for BTC ($76,996.5), 5 for TRX ($0.24187). */
  priceDecimals: number;
  /** Base-unit (size) display precision. */
  sizeDecimals: number;
  /** Order-book aggregation ladder, finest first. Drives OrderBook's TICKS. */
  tickSizes: number[];
}

export const MARKET_DISPLAY: Record<string, MarketDisplay> = {
  "BTC-PERP": {
    symbol: "BTC-PERP",
    displayName: "BTC-PERP",
    baseAsset: "BTC",
    quoteAsset: "USDC",
    priceSourceSymbol: "BTCUSDT",
    tvSymbol: "COINBASE:BTCUSD",
    priceDecimals: 1,
    sizeDecimals: 4,
    tickSizes: [0.1, 1, 10, 100],
  },
  "ETH-PERP": {
    symbol: "ETH-PERP",
    displayName: "ETH-PERP",
    baseAsset: "ETH",
    quoteAsset: "USDC",
    priceSourceSymbol: "ETHUSDT",
    tvSymbol: "COINBASE:ETHUSD",
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 10],
  },
  "SOL-PERP": {
    symbol: "SOL-PERP",
    displayName: "SOL-PERP",
    baseAsset: "SOL",
    quoteAsset: "USDC",
    priceSourceSymbol: "SOLUSDT",
    tvSymbol: "COINBASE:SOLUSD",
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
  },
  "XRP-PERP": {
    symbol: "XRP-PERP",
    displayName: "XRP-PERP",
    baseAsset: "XRP",
    quoteAsset: "USDC",
    priceSourceSymbol: "XRPUSDT",
    tvSymbol: "COINBASE:XRPUSD",
    priceDecimals: 4,
    sizeDecimals: 1,
    tickSizes: [0.0001, 0.001, 0.01, 0.1],
  },
  "ADA-PERP": {
    symbol: "ADA-PERP",
    displayName: "ADA-PERP",
    baseAsset: "ADA",
    quoteAsset: "USDC",
    priceSourceSymbol: "ADAUSDT",
    tvSymbol: "COINBASE:ADAUSD",
    priceDecimals: 4,
    sizeDecimals: 1,
    tickSizes: [0.0001, 0.001, 0.01, 0.1],
  },
  "BNB-PERP": {
    symbol: "BNB-PERP",
    displayName: "BNB-PERP",
    baseAsset: "BNB",
    quoteAsset: "USDC",
    priceSourceSymbol: "BNBUSDT",
    // Coinbase does not list BNB; BINANCE:BNBUSDT is the pair the oracle uses.
    tvSymbol: "BINANCE:BNBUSDT",
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
  },
  "TRX-PERP": {
    symbol: "TRX-PERP",
    displayName: "TRX-PERP",
    baseAsset: "TRX",
    quoteAsset: "USDC",
    priceSourceSymbol: "TRXUSDT",
    // Coinbase has no TRX pair on TradingView (COINBASE:TRXUSD 404s and the
    // chart renders "This symbol doesn't exist"). Binance is the venue we
    // already price TRX against.
    tvSymbol: "BINANCE:TRXUSDT",
    priceDecimals: 5,
    sizeDecimals: 0,
    tickSizes: [0.00001, 0.0001, 0.001, 0.01],
  },
};

/** The market the Trade tab opens. */
export const DEFAULT_MARKET_SYMBOL = "BTC-PERP";

/**
 * The UI's symbol for a market: "BTC-PERP".
 *
 * On chain a market is identified by its id and oracle feed, and the indexer
 * names it after the feed (`bytes32("BTC")` → "BTC"). Every URL and table here
 * says "BTC-PERP", so a bare base asset is completed with the suffix. A symbol
 * that already carries one is left alone.
 */
export function canonicalSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  return s.includes("-") ? s : `${s}-PERP`;
}

/**
 * Display metadata for a symbol, falling back to a usable default.
 *
 * A market listed on chain that nobody has added a row for here must still
 * render — governance can list one without a client deploy. The fallback
 * formats conservatively (4 price decimals) rather than guessing tightly:
 * showing more precision than a market needs is cosmetic, showing less rounds
 * a real price away.
 */
export function displayFor(symbol: string): MarketDisplay {
  const canonical = canonicalSymbol(symbol);
  const known = MARKET_DISPLAY[canonical];
  if (known) return known;
  const base = canonical.split("-")[0] || canonical;
  return {
    symbol: canonical,
    displayName: canonical,
    baseAsset: base,
    quoteAsset: "USDC",
    priceSourceSymbol: `${base}USDT`,
    tvSymbol: `BINANCE:${base}USDT`,
    priceDecimals: 4,
    sizeDecimals: 4,
    tickSizes: [0.0001, 0.001, 0.01, 0.1],
  };
}
