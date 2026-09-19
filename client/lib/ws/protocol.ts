/**
 * The streaming wire protocol: channel names and every frame the server sends.
 *
 * COMPATIBILITY
 * -------------
 * The browser client is `lib/market/stream.ts`, which reads every frame below
 * through `lib/market/book.ts` (the `*_raw` fields only). Programmatic clients
 * may depend on these names and fields too, so a change only ADDS: new fields
 * and new frames, never a renamed or retyped one.
 *
 * SCALES
 * ------
 * Every price and size is sent twice: `price`/`size` as the same 4-dp display
 * decimal the REST API returns (`formatFixed`), and `*_raw` as the exact 1e18
 * integer string, for bots. The orderbook levels are byte-for-byte the REST
 * `/api/markets/:id/orderbook` levels, so the stream and the API can be compared
 * directly.
 *
 * PENDING FILLS
 * -------------
 *  - `trades:<id>` carries SETTLED fills only. A PENDING fill is an intent the
 *    chain may still reject; a print that later un-happens is worse than one
 *    that arrives a block late. Same rule as `/api/markets/:id/trades`.
 *  - `orderbook:<id>` sizes levels by REMAINING size, which already subtracts
 *    PENDING reservations (`lib/queries/orders.ts`) — exactly what the matcher
 *    will still trade.
 *  - `fills:<address>` is the one place a PENDING fill appears, and every frame
 *    carries `status`. It is the account's own view of its fills moving
 *    PENDING → SETTLED | REJECTED, not a print.
 */

import type { BookLevel } from "@/lib/queries/orders";
import type { StreamFill } from "@/lib/queries/stream";
import { formatFixed, parseAddress, parseMarketId } from "@/lib/queries/scalars";

// ── Channels ────────────────────────────────────────────────────────────────

export type Channel =
  | { kind: "orderbook"; marketId: number }
  | { kind: "trades"; marketId: number }
  | { kind: "fills"; address: string }
  | { kind: "markets" };

/**
 * Parse a channel name. Returns the canonical name too: an address is accepted
 * in EIP-55 checksum form but the channel is always the lowercase one, which is
 * what `subscribed` echoes back.
 */
export function parseChannel(raw: unknown): { name: string; channel: Channel } | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  if (raw === "markets") return { name: raw, channel: { kind: "markets" } };
  const i = raw.indexOf(":");
  if (i < 0) return null;
  const kind = raw.slice(0, i);
  const arg = raw.slice(i + 1);
  if (kind === "orderbook" || kind === "trades") {
    const marketId = parseMarketId(arg);
    return marketId === null ? null : { name: `${kind}:${marketId}`, channel: { kind, marketId } };
  }
  if (kind === "fills") {
    const address = parseAddress(arg);
    return address === null ? null : { name: `fills:${address}`, channel: { kind, address } };
  }
  return null;
}

export const channelName = {
  orderbook: (marketId: number) => `orderbook:${marketId}`,
  trades: (marketId: number) => `trades:${marketId}`,
  fills: (address: string) => `fills:${address}`,
  markets: "markets",
} as const;

// ── Client → server ─────────────────────────────────────────────────────────

export type ClientMessage =
  | { type: "subscribe"; channels: string[] }
  | { type: "unsubscribe"; channels: string[] }
  | { type: "ping" };

export type ParsedClientMessage = ClientMessage | { type: "invalid"; reason: "malformed" | "unknown_type" };

/** Parse one text frame. Never throws: a bad frame is answered, not fatal. */
export function parseClientMessage(text: string): ParsedClientMessage {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return { type: "invalid", reason: "malformed" };
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return { type: "invalid", reason: "malformed" };
  const m = msg as { type?: unknown; channels?: unknown };
  if (m.type === "ping") return { type: "ping" };
  if (m.type === "subscribe" || m.type === "unsubscribe") {
    if (!Array.isArray(m.channels) || m.channels.length > 256) return { type: "invalid", reason: "malformed" };
    return { type: m.type, channels: m.channels.filter((c): c is string => typeof c === "string") };
  }
  return { type: "invalid", reason: "unknown_type" };
}

// ── Server → client ─────────────────────────────────────────────────────────

export type ErrorCode =
  | "malformed"
  | "unknown_type"
  | "unknown_channel"
  | "channel_limit"
  | "rate_limited"
  | "binary_not_supported";

/** One aggregated price level; the REST orderbook route's level, field for field. */
export interface LevelJson {
  price: string;
  size: string;
  price_raw: string;
  size_raw: string;
  orders: number;
}

export interface MarketJson {
  market_id: number;
  symbol: string;
  active: boolean;
  mark_price: string;
  index_price: string;
  /** 1e18 fraction per hour, signed; `funding_rate_per_hour` is it as a decimal. */
  funding_rate_per_hour: string;
  funding_rate_per_hour_raw: string;
  long_open_interest: string;
  short_open_interest: string;
  mark_price_raw: string;
  index_price_raw: string;
  long_open_interest_raw: string;
  short_open_interest_raw: string;
}

export type ServerMessage =
  | { type: "subscribed"; channels: string[] }
  | { type: "unsubscribed"; channels: string[] }
  | { type: "pong" }
  | { type: "error"; message: ErrorCode; channels?: string[] }
  | { type: "orderbook"; market_id: number; bids: LevelJson[]; asks: LevelJson[]; timestamp: number }
  | {
      type: "trade";
      market_id: number;
      price: string;
      size: string;
      side: "buy" | "sell";
      timestamp: number;
      fill_id: string;
      tx_hash: string | null;
      price_raw: string;
      size_raw: string;
      block_number: string | null;
    }
  | {
      type: "fill";
      address: string;
      fill_id: string;
      /** PENDING is an intent, not a settled trade. */
      status: "PENDING" | "SETTLED" | "REJECTED";
      reject_reason: string | null;
      market_id: number;
      role: "maker" | "taker" | "both";
      /** This account's direction (a self-trade is both; `side` is then the taker's). */
      side: "buy" | "sell";
      price: string;
      size: string;
      price_raw: string;
      size_raw: string;
      /** 1e18, signed (negative = rebate); the maker fee when role is maker. */
      fee_raw: string;
      tx_hash: string | null;
      block_number: string | null;
      timestamp: number;
      updated_at: number;
    }
  | { type: "markets"; markets: MarketJson[]; timestamp: number };

export function levelJson(l: BookLevel): LevelJson {
  return {
    price: formatFixed(l.price),
    size: formatFixed(l.size),
    price_raw: l.price.toString(),
    size_raw: l.size.toString(),
    orders: l.orders,
  };
}

export function tradeMessage(f: StreamFill): ServerMessage {
  return {
    type: "trade",
    market_id: f.marketId,
    price: formatFixed(f.price),
    size: formatFixed(f.size),
    side: f.takerIsBuy ? "buy" : "sell",
    timestamp: f.createdAt.getTime(),
    fill_id: f.fillId,
    tx_hash: f.txHash,
    price_raw: f.price.toString(),
    size_raw: f.size.toString(),
    block_number: f.blockNumber === null ? null : f.blockNumber.toString(),
  };
}

/** One fill as `address` sees it. `address` must be the maker, the taker, or both. */
export function fillMessage(address: string, f: StreamFill): ServerMessage {
  const isMaker = f.maker === address;
  const isTaker = f.taker === address;
  const role = isMaker && isTaker ? "both" : isMaker ? "maker" : "taker";
  // The maker traded against the taker, so it took the other side.
  const buys = role === "maker" ? !f.takerIsBuy : f.takerIsBuy;
  return {
    type: "fill",
    address,
    fill_id: f.fillId,
    status: f.status,
    reject_reason: f.rejectReason,
    market_id: f.marketId,
    role,
    side: buys ? "buy" : "sell",
    price: formatFixed(f.price),
    size: formatFixed(f.size),
    price_raw: f.price.toString(),
    size_raw: f.size.toString(),
    fee_raw: (role === "maker" ? f.makerFee : role === "taker" ? f.takerFee : f.makerFee + f.takerFee).toString(),
    tx_hash: f.txHash,
    block_number: f.blockNumber === null ? null : f.blockNumber.toString(),
    timestamp: f.createdAt.getTime(),
    updated_at: f.updatedAt.getTime(),
  };
}

export interface MarketState {
  marketId: number;
  symbol: string;
  active: boolean;
  lastMark: bigint;
  lastIndex: bigint;
  fundingRatePerHour: bigint;
  longOpenInterest: bigint;
  shortOpenInterest: bigint;
}

export function marketJson(m: MarketState): MarketJson {
  return {
    market_id: m.marketId,
    symbol: m.symbol,
    active: m.active,
    mark_price: formatFixed(m.lastMark),
    index_price: formatFixed(m.lastIndex),
    funding_rate_per_hour: formatFixed(m.fundingRatePerHour, 18, 10),
    funding_rate_per_hour_raw: m.fundingRatePerHour.toString(),
    long_open_interest: formatFixed(m.longOpenInterest),
    short_open_interest: formatFixed(m.shortOpenInterest),
    mark_price_raw: m.lastMark.toString(),
    index_price_raw: m.lastIndex.toString(),
    long_open_interest_raw: m.longOpenInterest.toString(),
    short_open_interest_raw: m.shortOpenInterest.toString(),
  };
}
