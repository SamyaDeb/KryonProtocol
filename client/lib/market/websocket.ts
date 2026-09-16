"use client";

import type { OrderBook, RecentTrade } from "@/lib/market/matcher";
import { WS_URL } from "@/config";

// Realtime streaming is delivered by a dedicated WebSocket service, configured
// via NEXT_PUBLIC_WS_URL (e.g. wss://stream.kryon.xyz). When unset — the
// default in this deployment — the client stays dormant and the app sources
// realtime data from resilient REST polling in MarketDataProvider. This keeps
// the WS layer fully pluggable without spamming reconnects at a non-existent
// endpoint.
// ─── Types ────────────────────────────────────────────────────────────────────

type WsMessage =
  | { type: "orderbook"; market_id: number; bids: { price: string; size: string }[]; asks: { price: string; size: string }[]; timestamp: number }
  | { type: "trade"; market_id: number; price: string; size: string; side: "buy" | "sell" | null; timestamp: number }
  | { type: "subscribed"; channels: string[] }
  | { type: "pong" }
  | { type: "error"; message: string };

export type WsOrderBookHandler = (marketId: number, book: OrderBook) => void;
export type WsTradeHandler = (marketId: number, trade: RecentTrade) => void;
export type WsStatusHandler = (connected: boolean) => void;

// ─── Singleton state ──────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1_000;
let isDestroyed = false;

const MAX_RECONNECT_DELAY = 30_000;
const PING_INTERVAL_MS = 25_000;
let pingTimer: ReturnType<typeof setInterval> | null = null;

const subscribedChannels = new Set<string>();
let onOrderBook: WsOrderBookHandler | null = null;
let onTrade: WsTradeHandler | null = null;
let onStatus: WsStatusHandler | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWsUrl(): string | null {
  // Only connect when an explicit streaming URL is configured. No fallback to
  // the REST origin — that endpoint does not speak WebSocket.
  return WS_URL || null;
}

function send(payload: object) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendSubscribe(channels: string[]) {
  if (channels.length === 0) return;
  send({ type: "subscribe", channels });
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function withJitter(delay: number): number {
  // ±20% random jitter prevents thundering herd when many tabs reconnect simultaneously
  return delay * (0.8 + Math.random() * 0.4);
}

function scheduleReconnect() {
  if (isDestroyed) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, withJitter(reconnectDelay));
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

// ─── Core connect ─────────────────────────────────────────────────────────────

function connect() {
  if (isDestroyed) return;
  const url = getWsUrl();
  if (!url) return;

  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelay = 1_000;
    onStatus?.(true);
    startPing();
    if (subscribedChannels.size > 0) {
      sendSubscribe([...subscribedChannels]);
    }
  };

  ws.onmessage = (e: MessageEvent<string>) => {
    try {
      const msg = JSON.parse(e.data) as WsMessage;
      handleMessage(msg);
    } catch { /* ignore unparseable */ }
  };

  ws.onerror = () => { /* onclose will fire next */ };

  ws.onclose = () => {
    ws = null;
    stopPing();
    onStatus?.(false);
    scheduleReconnect();
  };
}

function handleMessage(msg: WsMessage) {
  if (msg.type === "orderbook") {
    onOrderBook?.(msg.market_id, {
      bids: msg.bids,
      asks: msg.asks,
      timestamp: msg.timestamp,
    });
  } else if (msg.type === "trade") {
    onTrade?.(msg.market_id, {
      price: msg.price,
      size: msg.size,
      side: msg.side,
      timestamp: msg.timestamp,
    });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function wsSetHandlers(
  book: WsOrderBookHandler,
  trade: WsTradeHandler,
  status: WsStatusHandler
) {
  onOrderBook = book;
  onTrade = trade;
  onStatus = status;
}

export function wsSubscribe(marketId: number) {
  // No streaming server configured → stay on REST polling, don't attempt to connect.
  if (!getWsUrl()) return;
  const channels = [`orderbook:${marketId}`, `trades:${marketId}`];
  channels.forEach((c) => subscribedChannels.add(c));
  if (ws?.readyState === WebSocket.OPEN) {
    sendSubscribe(channels);
  } else if (!ws) {
    isDestroyed = false;
    connect();
  }
}

export function wsUnsubscribe(marketId: number) {
  const channels = [`orderbook:${marketId}`, `trades:${marketId}`];
  channels.forEach((c) => subscribedChannels.delete(c));
  send({ type: "unsubscribe", channels });
}

export function wsDisconnect() {
  isDestroyed = true;
  stopPing();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  ws?.close();
  ws = null;
}

export function wsReset() {
  isDestroyed = false;
  reconnectDelay = 1_000;
}
