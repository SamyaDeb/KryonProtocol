#!/usr/bin/env tsx
/**
 * WebSocket Server — broadcasts live market data to connected clients.
 *
 * Channels:
 *   orderbook:<marketId>   → { type: "orderbook", market_id, bids, asks, timestamp }
 *   trades:<marketId>      → { type: "trade", market_id, price, size, side, timestamp }
 *
 * Client messages:
 *   { type: "subscribe",   channels: ["orderbook:1", "trades:1"] }
 *   { type: "unsubscribe", channels: ["orderbook:1"] }
 *   { type: "ping" }       → { type: "pong" }
 *
 * Usage:
 *   PORT=8080 DATABASE_URL=... npx tsx scripts/ws-server.ts
 *   or via package.json: npm run dev:ws
 */

import { WebSocketServer, WebSocket } from "ws";
import { neon } from "../lib/sql";
import { ACTIVE_MARKETS } from "../config";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const BROADCAST_INTERVAL_MS = 1_000;
const PING_INTERVAL_MS = 25_000;
const PRICE_SCALE = 1e18;
const AMOUNT_SCALE = 1e7;

const MARKETS = Object.values(ACTIVE_MARKETS).map((m) => m.marketId);

// ── DB ────────────────────────────────────────────────────────────────────────

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface OrderBookLevel { price: string; size: string }
interface OrderBookSnapshot {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

interface Trade {
  price: string;
  size: string;
  side: "buy" | "sell" | null;
  timestamp: number;
}

// ── Subscription map: channel → set of sockets ────────────────────────────────

const subscriptions = new Map<string, Set<WebSocket>>();

/** Every channel this server will ever publish on. */
const VALID_CHANNELS = new Set(
  MARKETS.flatMap((id) => [`orderbook:${id}`, `trades:${id}`])
);

function subscribe(ws: WebSocket, channel: string) {
  if (!subscriptions.has(channel)) subscriptions.set(channel, new Set());
  subscriptions.get(channel)!.add(ws);
}

/**
 * Drop the socket, and drop the channel entirely once nobody is left on it.
 *
 * Leaving the empty Set behind leaked a map entry per channel name for the
 * lifetime of the process — permanently, since nothing ever pruned them.
 * Harmless while channel names are bounded, which they now are, but the
 * previous `\d+` match let one client mint unbounded distinct channels and
 * never give the memory back.
 */
function unsubscribe(ws: WebSocket, channel: string) {
  const sockets = subscriptions.get(channel);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) subscriptions.delete(channel);
}

function unsubscribeAll(ws: WebSocket) {
  for (const [channel, sockets] of subscriptions) {
    sockets.delete(ws);
    if (sockets.size === 0) subscriptions.delete(channel);
  }
}

function broadcast(channel: string, payload: object) {
  const sockets = subscriptions.get(channel);
  if (!sockets?.size) return;
  const msg = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    } else {
      sockets.delete(ws);
    }
  }
}

// ── DB queries ────────────────────────────────────────────────────────────────

async function fetchOrderBook(marketId: number): Promise<OrderBookSnapshot> {
  const sql = db();
  const rows = await sql`
    SELECT "isLong", "limitPrice"::numeric AS limit_price,
           "size"::numeric AS size, "filledSize"::numeric AS filled_size
    FROM "Order"
    WHERE "marketId" = ${marketId}
      AND cancelled = false
      AND "limitPrice" <> '0'
      AND "filledSize"::numeric < "size"::numeric
      AND ("expiryTs"::numeric = 0 OR "expiryTs"::numeric > EXTRACT(EPOCH FROM NOW()))
    ORDER BY "limitPrice"::numeric ASC
  `;
  const bidMap = new Map<string, number>();
  const askMap = new Map<string, number>();
  for (const row of rows) {
    const priceHuman = (Number(row.limit_price) / PRICE_SCALE).toFixed(4);
    const remaining = (Number(row.size) - Number(row.filled_size)) / AMOUNT_SCALE;
    if (row.isLong) {
      bidMap.set(priceHuman, (bidMap.get(priceHuman) ?? 0) + remaining);
    } else {
      askMap.set(priceHuman, (askMap.get(priceHuman) ?? 0) + remaining);
    }
  }
  return {
    bids: [...bidMap.entries()].sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).map(([price, size]) => ({ price, size: size.toFixed(4) })),
    asks: [...askMap.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).map(([price, size]) => ({ price, size: size.toFixed(4) })),
    timestamp: Date.now(),
  };
}

async function fetchRecentTrades(marketId: number, limit = 50): Promise<Trade[]> {
  const sql = db();
  // Side is the taker's direction, joined from the taker's own order — the same
  // rule as /api/markets/:id/trades, so the streamed tape and the REST tape can
  // never disagree about which way a print went.
  const rows = await sql`
    SELECT f."fillPrice"::text AS fill_price, f."fillSize"::text AS fill_size,
           f."createdAt" AS ts, ot."isLong" AS taker_is_long
    FROM "Fill" f
    LEFT JOIN "Order" ot ON ot.owner = f.taker AND ot.nonce = f."takerNonce"
    WHERE f."marketId" = ${marketId}
    ORDER BY f."createdAt" DESC, f.id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => {
    const raw = Number(r.fill_size);
    const size = raw >= 1e12 ? raw / PRICE_SCALE : raw / AMOUNT_SCALE;
    return {
      price: (Number(r.fill_price) / PRICE_SCALE).toFixed(4),
      size: size.toFixed(4),
      side:
        r.taker_is_long === null || r.taker_is_long === undefined
          ? null
          : ((r.taker_is_long ? "buy" : "sell") as "buy" | "sell"),
      timestamp: new Date(r.ts).getTime(),
    };
  });
}

// Track last-seen trade timestamp per market to only broadcast new ones
const lastTradeTs = new Map<number, number>();

// ── Broadcast loop ────────────────────────────────────────────────────────────

async function broadcastMarket(marketId: number) {
  const obChannel = `orderbook:${marketId}`;
  const trChannel = `trades:${marketId}`;
  const hasObSubs = (subscriptions.get(obChannel)?.size ?? 0) > 0;
  const hasTrSubs = (subscriptions.get(trChannel)?.size ?? 0) > 0;
  if (!hasObSubs && !hasTrSubs) return;

  try {
    if (hasObSubs) {
      const book = await fetchOrderBook(marketId);
      broadcast(obChannel, { type: "orderbook", market_id: marketId, ...book });
    }
    if (hasTrSubs) {
      const trades = await fetchRecentTrades(marketId, 10);
      const lastTs = lastTradeTs.get(marketId) ?? 0;
      const newTrades = trades.filter((t) => t.timestamp > lastTs);
      if (newTrades.length > 0) {
        lastTradeTs.set(marketId, newTrades[0].timestamp);
        for (const trade of newTrades.reverse()) {
          broadcast(trChannel, { type: "trade", market_id: marketId, ...trade });
        }
      }
    }
  } catch (e) {
    // Non-fatal — DB blip, skip this tick
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("fetch failed")) console.error(`[ws] broadcast error market ${marketId}:`, msg.slice(0, 120));
  }
}

// ── Server setup ──────────────────────────────────────────────────────────────

// maxPayload: this endpoint is public and unauthenticated, and every message it
// accepts is a small JSON control frame. The `ws` default is 100MB, so without
// a cap a single client can make the process allocate that much per frame.
const wss = new WebSocketServer({ port: PORT, maxPayload: 16 * 1024 });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as { type: string; channels?: string[] };
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      } else if (msg.type === "subscribe" && Array.isArray(msg.channels)) {
        // Match against the channels this server actually publishes, not a
        // shape. `\d+` accepted `orderbook:99999999` for a market that does not
        // exist: the subscription was recorded, nothing was ever broadcast to
        // it, and the entry sat in the map — so an unauthenticated client could
        // grow that map without bound.
        const valid = msg.channels.filter(
          (c) => typeof c === "string" && VALID_CHANNELS.has(c)
        );
        valid.forEach((c) => subscribe(ws, c));
        ws.send(JSON.stringify({ type: "subscribed", channels: valid }));
      } else if (msg.type === "unsubscribe" && Array.isArray(msg.channels)) {
        msg.channels.forEach((c) => unsubscribe(ws, c));
      }
    } catch { /* ignore unparseable */ }
  });

  ws.on("close", () => unsubscribeAll(ws));
  ws.on("error", () => unsubscribeAll(ws));
});

// Heartbeat to drop dead connections
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    ws.ping();
  }
}, PING_INTERVAL_MS);

// Broadcast loop
const broadcastLoop = setInterval(async () => {
  await Promise.all(MARKETS.map(broadcastMarket));
}, BROADCAST_INTERVAL_MS);

wss.on("close", () => {
  clearInterval(heartbeat);
  clearInterval(broadcastLoop);
});

const clientCount = () => [...wss.clients].filter((c) => c.readyState === WebSocket.OPEN).length;

console.log(`✓ WebSocket server starting`);
console.log(`  Port     : ${PORT}`);
console.log(`  Markets  : ${MARKETS.join(", ")}`);
console.log(`  Interval : ${BROADCAST_INTERVAL_MS}ms`);

// Log connection count every 30s
setInterval(() => {
  console.log(`[ws] ${clientCount()} connected clients`);
}, 30_000);

process.on("SIGTERM", () => {
  clearInterval(heartbeat);
  clearInterval(broadcastLoop);
  wss.close(() => process.exit(0));
});
