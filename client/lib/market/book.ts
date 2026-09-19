/**
 * Market data as the browser holds it: order book, trades, the caller's own
 * fills and market tickers, every amount a bigint at its on-chain scale.
 *
 * The REST routes and the WebSocket server (lib/ws/protocol.ts) send each
 * amount twice: a rounded display string (`price`) and the exact integer
 * (`price_raw`). Only the raw value is read here; the display string is 4dp,
 * which cannot even show a TRX price.
 *
 * Parsers never throw. A malformed message is dropped (null), because one bad
 * frame must not take down a trading screen. The REST fallback fills the gap
 * on the next poll.
 *
 * Browser-safe: the protocol module is imported for its types only.
 */

import type { LevelJson, MarketJson, ServerMessage } from "@/lib/ws/protocol";

/** One aggregated price level. `size` is the REMAINING size (lib/queries/orders.ts). */
export interface BookLevel {
  /** 1e18 */
  price: bigint;
  /** 1e18 base units */
  size: bigint;
  orders: number;
}

export interface OrderBook {
  /** Best (highest) first. */
  bids: BookLevel[];
  /** Best (lowest) first. */
  asks: BookLevel[];
  /** ms since epoch, when the server built it. */
  timestamp: number;
}

/** A settled print on a market's tape. */
export interface Trade {
  fillId: string;
  price: bigint;
  size: bigint;
  /** The taker's side. */
  side: "buy" | "sell";
  timestamp: number;
  txHash: string | null;
}

export type FillStatus = "PENDING" | "SETTLED" | "REJECTED";

/**
 * One of the caller's fills. PENDING means matched off-chain and submitted,
 * not yet final; the UI must never show it as settled.
 */
export interface OwnFill {
  fillId: string;
  status: FillStatus;
  /** Decoded contract error name for REJECTED, e.g. "AccountInsolvent". */
  rejectReason: string | null;
  marketId: number;
  role: "maker" | "taker" | "both";
  side: "buy" | "sell";
  price: bigint;
  size: bigint;
  /** 1e18 USD, signed: negative is a rebate. */
  fee: bigint;
  txHash: string | null;
  blockNumber: bigint | null;
  timestamp: number;
  updatedAt: number;
}

export interface MarketTicker {
  marketId: number;
  symbol: string;
  active: boolean;
  markPrice: bigint;
  indexPrice: bigint;
  /** 1e18 fraction per hour, signed. */
  fundingRatePerHour: bigint;
  longOpenInterest: bigint;
  shortOpenInterest: bigint;
}

// ── Scalars ──────────────────────────────────────────────────────────────────

const INT_RE = /^-?\d{1,80}$/;

/** A decimal integer string as bigint, or null. */
export function big(raw: unknown): bigint | null {
  if (typeof raw === "bigint") return raw;
  if (typeof raw !== "string" || !INT_RE.test(raw)) return null;
  return BigInt(raw);
}

const num = (raw: unknown): number | null => (typeof raw === "number" && Number.isFinite(raw) ? raw : null);
const str = (raw: unknown): string | null => (typeof raw === "string" ? raw : null);
const side = (raw: unknown): "buy" | "sell" | null => (raw === "buy" || raw === "sell" ? raw : null);

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// ── Parsers ──────────────────────────────────────────────────────────────────

export function parseLevel(raw: unknown): BookLevel | null {
  if (!isObject(raw)) return null;
  const l = raw as Partial<LevelJson>;
  const price = big(l.price_raw);
  const size = big(l.size_raw);
  if (price === null || size === null || price <= 0n || size <= 0n) return null;
  return { price, size, orders: num(l.orders) ?? 0 };
}

/**
 * `{ bids, asks, timestamp }` from `/api/markets/:id/orderbook` or a WS
 * `orderbook` message. Bad levels are dropped; levels are re-sorted so the
 * best price is first even if a producer ever sends them otherwise.
 */
export function parseOrderBook(raw: unknown): OrderBook | null {
  if (!isObject(raw) || !Array.isArray(raw.bids) || !Array.isArray(raw.asks)) return null;
  const levels = (xs: unknown[]) => xs.map(parseLevel).filter((l): l is BookLevel => l !== null);
  const bids = levels(raw.bids).sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0));
  const asks = levels(raw.asks).sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  return { bids, asks, timestamp: num(raw.timestamp) ?? Date.now() };
}

/** A trade from `/api/markets/:id/trades` or a WS `trade` message. */
export function parseTrade(raw: unknown): Trade | null {
  if (!isObject(raw)) return null;
  const price = big(raw.price_raw);
  const size = big(raw.size_raw);
  const s = side(raw.side);
  const fillId = str(raw.fill_id);
  const timestamp = num(raw.timestamp);
  if (price === null || size === null || s === null || fillId === null || timestamp === null) return null;
  return { fillId, price, size, side: s, timestamp, txHash: str(raw.tx_hash) };
}

/** A WS `fill` message (channel `fills:<address>`). */
export function parseOwnFill(raw: unknown): OwnFill | null {
  if (!isObject(raw)) return null;
  const status = raw.status;
  const role = raw.role;
  if (status !== "PENDING" && status !== "SETTLED" && status !== "REJECTED") return null;
  if (role !== "maker" && role !== "taker" && role !== "both") return null;
  const price = big(raw.price_raw);
  const size = big(raw.size_raw);
  const fee = big(raw.fee_raw);
  const s = side(raw.side);
  const fillId = str(raw.fill_id);
  const marketId = num(raw.market_id);
  const timestamp = num(raw.timestamp);
  if (price === null || size === null || fee === null || s === null || fillId === null || marketId === null || timestamp === null) {
    return null;
  }
  return {
    fillId,
    status,
    rejectReason: str(raw.reject_reason),
    marketId,
    role,
    side: s,
    price,
    size,
    fee,
    txHash: str(raw.tx_hash),
    blockNumber: raw.block_number === null ? null : big(raw.block_number),
    timestamp,
    updatedAt: num(raw.updated_at) ?? timestamp,
  };
}

export function parseTicker(raw: unknown): MarketTicker | null {
  if (!isObject(raw)) return null;
  const m = raw as Partial<MarketJson>;
  const marketId = num(m.market_id);
  const symbol = str(m.symbol);
  const values = [m.mark_price_raw, m.index_price_raw, m.funding_rate_per_hour_raw, m.long_open_interest_raw, m.short_open_interest_raw].map(big);
  if (marketId === null || symbol === null || typeof m.active !== "boolean" || values.some((v) => v === null)) return null;
  const [markPrice, indexPrice, fundingRatePerHour, longOpenInterest, shortOpenInterest] = values as bigint[];
  return { marketId, symbol, active: m.active, markPrice, indexPrice, fundingRatePerHour, longOpenInterest, shortOpenInterest };
}

// ── WebSocket messages ───────────────────────────────────────────────────────

export type StreamEvent =
  | { kind: "orderbook"; marketId: number; book: OrderBook }
  | { kind: "trade"; marketId: number; trade: Trade }
  | { kind: "fill"; address: string; fill: OwnFill }
  | { kind: "markets"; markets: MarketTicker[]; timestamp: number }
  | { kind: "error"; message: string; channels: string[] };

/**
 * A server frame as a typed event, or null for frames the UI ignores
 * (subscribe acks, pong) and for anything malformed.
 */
export function parseServerMessage(text: string): StreamEvent | null {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(msg)) return null;
  const type = msg.type as ServerMessage["type"] | undefined;
  switch (type) {
    case "orderbook": {
      const marketId = num(msg.market_id);
      const book = parseOrderBook(msg);
      return marketId === null || book === null ? null : { kind: "orderbook", marketId, book };
    }
    case "trade": {
      const marketId = num(msg.market_id);
      const trade = parseTrade(msg);
      return marketId === null || trade === null ? null : { kind: "trade", marketId, trade };
    }
    case "fill": {
      const address = str(msg.address);
      const fill = parseOwnFill(msg);
      return address === null || fill === null ? null : { kind: "fill", address, fill };
    }
    case "markets": {
      if (!Array.isArray(msg.markets)) return null;
      const markets = msg.markets.map(parseTicker).filter((m): m is MarketTicker => m !== null);
      return { kind: "markets", markets, timestamp: num(msg.timestamp) ?? Date.now() };
    }
    case "error":
      return {
        kind: "error",
        message: str(msg.message) ?? "unknown",
        channels: Array.isArray(msg.channels) ? msg.channels.filter((c): c is string => typeof c === "string") : [],
      };
    default:
      return null;
  }
}
