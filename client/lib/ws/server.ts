/**
 * The streaming server: one process, one Arc network, one port.
 *
 * DATA FLOW
 * ---------
 * A poll loop (`runLoop`, like every keeper) reads the database through a
 * `StreamSource` and pushes only what changed:
 *
 *  - `orderbook:<id>` — the book is rebuilt from `lib/queries/orders.ts` every
 *    poll for each market someone is watching, and sent only when it differs
 *    from the last frame. Rebuilding rather than watching row timestamps is
 *    deliberate: an order EXPIRING changes the book without any row changing.
 *  - `trades:<id>`   — settled prints after a `(blockNumber, logIndex)` cursor.
 *  - `fills:<addr>`  — an account's fills whose row changed, every status.
 *  - `markets`       — mark, index, funding rate and open interest, on change.
 *
 * A new subscriber gets the current book / markets frame at once (from the
 * last poll); the tape and fills streams are "from now on" — history is REST.
 *
 * BOUNDS
 * ------
 * The endpoint is public and unauthenticated, so everything a client can make
 * the process hold is capped: connections (excess upgrades get HTTP 503),
 * channels per connection, frame size, inbound message rate, and — the one
 * that protects everybody else — outbound buffer. A client that stops reading
 * is terminated once `bufferedAmount` passes `maxBufferedBytes`, instead of
 * the process buffering broadcasts for it without limit.
 *
 * Liveness both ways: the server pings every `pingIntervalMs` and drops a
 * connection it has heard nothing from (message or pong) for `idleTimeoutMs`;
 * a client may send `{"type":"ping"}` and gets `{"type":"pong"}`.
 *
 * HEALTH
 * ------
 * Plain HTTP on the same port: `GET /healthz` is 200 while the last poll
 * succeeded and the last good database read is younger than `healthStaleMs`,
 * 503 otherwise (the database, not the socket, is what goes stale);
 * `GET /metrics` is the counter snapshot.
 *
 * Reads only. It holds no key and sends no transaction.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { ArcNetworkId } from "@/lib/network";
import { errorMessage, runLoop, systemClock, type Clock, type Logger, type Metrics } from "@/lib/keepers/runtime";
import type { TradeKey } from "@/lib/queries/stream";
import {
  channelName,
  fillMessage,
  levelJson,
  marketJson,
  parseChannel,
  parseClientMessage,
  tradeMessage,
  type ErrorCode,
  type ServerMessage,
} from "./protocol";
import type { StreamSource } from "./source";

export interface StreamLimits {
  maxConnections: number;
  maxChannelsPerConnection: number;
  /** Outbound bytes queued for one client before it is dropped as a slow consumer. */
  maxBufferedBytes: number;
  /** Largest inbound frame; every legitimate one is a small JSON control message. */
  maxPayloadBytes: number;
  /** Inbound messages allowed per `messageWindowMs` before the connection is closed. */
  maxMessagesPerWindow: number;
  messageWindowMs: number;
  pingIntervalMs: number;
  idleTimeoutMs: number;
  /** Book / tape / fills poll period. */
  pollMs: number;
  marketsPollMs: number;
  /** How far back each account-fills poll re-reads (see lib/queries/stream.ts). */
  fillOverlapMs: number;
  healthStaleMs: number;
  /** Max rows per stream per poll; the rest follow on the next poll. */
  batchLimit: number;
}

export const DEFAULT_LIMITS: StreamLimits = {
  maxConnections: 2_000,
  maxChannelsPerConnection: 32,
  maxBufferedBytes: 1024 * 1024,
  maxPayloadBytes: 16 * 1024,
  maxMessagesPerWindow: 100,
  messageWindowMs: 10_000,
  pingIntervalMs: 25_000,
  idleTimeoutMs: 75_000,
  pollMs: 500,
  marketsPollMs: 2_000,
  fillOverlapMs: 10_000,
  healthStaleMs: 15_000,
  batchLimit: 500,
};

export interface StreamServerOptions {
  network: ArcNetworkId;
  source: StreamSource;
  log: Logger;
  metrics: Metrics;
  clock?: Clock;
  limits?: Partial<StreamLimits>;
}

interface Conn {
  id: number;
  ws: WebSocket;
  channels: Set<string>;
  lastSeen: number;
  windowStart: number;
  windowCount: number;
  dropped: boolean;
}

interface Frame {
  /** The frame minus its timestamp: what "changed" is decided on. */
  key: string;
  text: string;
}

export class StreamServer {
  readonly network: ArcNetworkId;
  readonly limits: StreamLimits;
  private readonly source: StreamSource;
  private readonly log: Logger;
  private readonly metrics: Metrics;
  private readonly clock: Clock;

  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private readonly subs = new Map<string, Set<Conn>>();
  /** Upgrades accepted but not yet connected, so a burst cannot overshoot the cap. */
  private reserved = 0;
  private nextId = 1;

  private validMarkets = new Set<number>();
  private marketsFrame: Frame | null = null;
  private lastMarketsAt = -Infinity;
  private readonly books = new Map<number, Frame>();
  /** `undefined` until the first poll after someone subscribes; then the tape position. */
  private readonly tradeCursors = new Map<number, TradeKey | null>();
  private fillCursor: Date | null = null;
  /** `fillId|status|rejectReason` → updatedAt ms, for the overlap window. */
  private readonly fillSeen = new Map<string, number>();

  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closing = false;
  private closed: Promise<void> | null = null;
  private readonly startedAt: number;
  /** Last successful database read (the market heartbeat). */
  private lastPollOkAt: number | null = null;
  private lastPollError: string | null = null;

  constructor(o: StreamServerOptions) {
    this.network = o.network;
    this.source = o.source;
    this.log = o.log;
    this.metrics = o.metrics;
    this.clock = o.clock ?? systemClock;
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.startedAt = this.clock.now();

    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.limits.maxPayloadBytes, clientTracking: false });
    this.httpServer = http.createServer((req, res) => this.onHttp(req, res));
    this.httpServer.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    this.httpServer.on("clientError", (_err, socket) => socket.destroy());
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Bind, load the market list, start heartbeats. Resolves to the bound port. */
  async listen(port: number, host?: string): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(port, host, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });
    try {
      await this.refreshMarkets(true);
    } catch (err) {
      // Not fatal: the poll loop retries, and /healthz reports 503 meanwhile.
      this.log.warn("initial market load failed", { error: errorMessage(err) });
    }
    this.heartbeat = setInterval(() => this.beat(), this.limits.pingIntervalMs);
    this.heartbeat.unref();
    const bound = (this.httpServer.address() as AddressInfo).port;
    this.log.info("listening", { port: bound, network: this.network, limits: this.limits });
    return bound;
  }

  /** Poll until `signal` aborts, then close every connection and the port. */
  async run(signal: AbortSignal): Promise<void> {
    await runLoop(
      { tickMs: this.limits.pollMs, signal, log: this.log, metrics: this.metrics, clock: this.clock },
      () => this.pollOnce()
    );
    await this.close();
  }

  /** Close every client with 1001 (going away), then the port. Idempotent. */
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.closed = (async () => {
      const open = [...this.conns];
      await Promise.all(
        open.map(
          (c) =>
            new Promise<void>((resolve) => {
              if (c.ws.readyState === WebSocket.CLOSED) return resolve();
              const t = setTimeout(() => {
                c.ws.terminate();
                resolve();
              }, 2_000);
              c.ws.once("close", () => {
                clearTimeout(t);
                resolve();
              });
              c.ws.close(1001, "server shutting down");
            })
        )
      );
      this.wss.close();
      await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
      this.log.info("closed", { closedConnections: open.length });
    })();
    return this.closed;
  }

  // ── polling ───────────────────────────────────────────────────────────────

  /** One pass over every stream someone is subscribed to. Public for tests. */
  async pollOnce(): Promise<void> {
    const started = this.clock.now();
    const errors: string[] = [];
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        this.metrics.inc("ws_poll_errors_total");
        errors.push(`${name}: ${errorMessage(err)}`);
      }
    };

    await step("markets", () => this.refreshMarkets(false));
    await step("orderbook", () => this.pollBooks());
    await step("trades", () => this.pollTrades());
    await step("fills", () => this.pollFills());

    const elapsed = this.clock.now() - started;
    this.metrics.gauge("ws_poll_ms", elapsed);
    if (errors.length === 0) {
      this.lastPollError = null;
    } else {
      this.lastPollError = errors.join("; ");
      this.log.warn("poll failed", { errors });
    }
  }

  private async refreshMarkets(force: boolean): Promise<void> {
    const now = this.clock.now();
    if (!force && now - this.lastMarketsAt < this.limits.marketsPollMs) return;
    const markets = await this.source.markets();
    // The market read runs every `marketsPollMs` whether or not anyone is
    // subscribed, so it doubles as the database heartbeat /healthz reports on.
    this.lastMarketsAt = now;
    this.lastPollOkAt = this.clock.now();
    this.validMarkets = new Set(markets.map((m) => m.marketId));
    const body = markets.map(marketJson);
    const key = JSON.stringify(body);
    if (this.marketsFrame?.key === key) return;
    const text = this.frame({ type: "markets", markets: body, timestamp: now });
    this.marketsFrame = { key, text };
    this.broadcast(channelName.markets, text);
  }

  private async pollBooks(): Promise<void> {
    const nowSec = BigInt(Math.floor(this.clock.now() / 1000));
    for (const marketId of this.subscribedMarkets("orderbook")) {
      const started = this.clock.now();
      const book = await this.source.orderbook(marketId, nowSec);
      const bids = book.bids.map(levelJson);
      const asks = book.asks.map(levelJson);
      const key = JSON.stringify([bids, asks]);
      if (this.books.get(marketId)?.key === key) continue;
      const text = this.frame({ type: "orderbook", market_id: marketId, bids, asks, timestamp: this.clock.now() });
      this.books.set(marketId, { key, text });
      this.broadcast(channelName.orderbook(marketId), text);
      this.metrics.gauge("ws_broadcast_latency_ms", this.clock.now() - started);
    }
  }

  private async pollTrades(): Promise<void> {
    for (const marketId of this.subscribedMarkets("trades")) {
      if (!this.tradeCursors.has(marketId)) {
        // First poll since someone subscribed: start at the tip; history is REST.
        this.tradeCursors.set(marketId, await this.source.latestTradeKey(marketId));
        continue;
      }
      const after = this.tradeCursors.get(marketId) ?? null;
      const fills = await this.source.tradesAfter(marketId, after, this.limits.batchLimit);
      if (fills.length === 0) continue;
      const channel = channelName.trades(marketId);
      for (const f of fills) {
        // `status = 'SETTLED'` is in the query; this guards the invariant anyway.
        if (f.status !== "SETTLED" || f.blockNumber === null || f.logIndex === null) continue;
        this.broadcast(channel, this.frame(tradeMessage(f)));
      }
      const last = fills[fills.length - 1];
      if (last.blockNumber !== null && last.logIndex !== null) {
        this.tradeCursors.set(marketId, { blockNumber: last.blockNumber, logIndex: last.logIndex });
      }
    }
  }

  private async pollFills(): Promise<void> {
    const addresses = [...this.subs.keys()].filter((c) => c.startsWith("fills:")).map((c) => c.slice(6));
    if (addresses.length === 0) {
      // Nobody is listening: forget the cursor, so the next subscriber starts from now.
      this.fillCursor = null;
      this.fillSeen.clear();
      return;
    }
    if (this.fillCursor === null) this.fillCursor = new Date(this.clock.now());
    const overlap = this.limits.fillOverlapMs;
    const since = new Date(this.fillCursor.getTime() - overlap);
    const rows = await this.source.fillChanges(addresses, since, this.limits.batchLimit);
    const watched = new Set(addresses);
    for (const f of rows) {
      const seenKey = `${f.fillId}|${f.status}|${f.rejectReason ?? ""}`;
      if (this.fillSeen.has(seenKey)) continue;
      this.fillSeen.set(seenKey, f.updatedAt.getTime());
      for (const address of new Set([f.maker, f.taker])) {
        if (watched.has(address)) this.broadcast(channelName.fills(address), this.frame(fillMessage(address, f)));
      }
      if (f.updatedAt > this.fillCursor) this.fillCursor = f.updatedAt;
    }
    const horizon = this.fillCursor.getTime() - overlap;
    for (const [k, at] of this.fillSeen) if (at < horizon) this.fillSeen.delete(k);
  }

  private subscribedMarkets(kind: "orderbook" | "trades"): number[] {
    const out: number[] = [];
    const prefix = `${kind}:`;
    for (const [channel, set] of this.subs) {
      if (set.size > 0 && channel.startsWith(prefix)) out.push(Number(channel.slice(prefix.length)));
    }
    return out;
  }

  // ── sending ───────────────────────────────────────────────────────────────

  private frame(msg: ServerMessage): string {
    return JSON.stringify(msg);
  }

  private broadcast(channel: string, text: string): void {
    const set = this.subs.get(channel);
    if (!set || set.size === 0) return;
    this.metrics.inc("ws_broadcasts_total");
    for (const c of set) this.send(c, text);
  }

  private send(c: Conn, text: string): void {
    if (c.dropped || c.ws.readyState !== WebSocket.OPEN) return;
    if (c.ws.bufferedAmount > this.limits.maxBufferedBytes) {
      // Slow consumer: it has not read what is already queued, and buffering
      // for it grows without bound. Judged on the backlog, not on this frame,
      // so one large book to a client that is keeping up is never a drop.
      // Terminate (not close — a close frame would queue behind the backlog).
      c.dropped = true;
      this.metrics.inc("ws_clients_dropped_slow_total");
      this.log.warn("dropping slow consumer", { conn: c.id, bufferedBytes: c.ws.bufferedAmount });
      c.ws.terminate();
      return;
    }
    c.ws.send(text);
    this.metrics.inc("ws_messages_sent_total");
  }

  private reply(c: Conn, msg: ServerMessage): void {
    this.send(c, this.frame(msg));
  }

  private error(c: Conn, message: ErrorCode, channels?: string[]): void {
    this.reply(c, channels ? { type: "error", message, channels } : { type: "error", message });
  }

  // ── connections ───────────────────────────────────────────────────────────

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    if (this.closing || this.conns.size + this.reserved >= this.limits.maxConnections) {
      this.metrics.inc("ws_connections_rejected_total");
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    this.reserved += 1;
    let settled = false;
    const release = () => {
      if (!settled) {
        settled = true;
        this.reserved -= 1;
      }
    };
    socket.once("close", release);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      release();
      this.onConnection(ws);
    });
  }

  private onConnection(ws: WebSocket): void {
    const now = this.clock.now();
    const c: Conn = { id: this.nextId++, ws, channels: new Set(), lastSeen: now, windowStart: now, windowCount: 0, dropped: false };
    this.conns.add(c);
    this.metrics.inc("ws_connections_total");
    this.gauges();

    ws.on("message", (data: RawData, isBinary: boolean) => this.onMessage(c, data, isBinary));
    ws.on("pong", () => {
      c.lastSeen = this.clock.now();
    });
    ws.on("error", (err) => this.log.debug("socket error", { conn: c.id, error: errorMessage(err) }));
    ws.on("close", () => this.onClose(c));
  }

  private onClose(c: Conn): void {
    if (!this.conns.delete(c)) return;
    for (const channel of c.channels) this.removeSub(c, channel);
    c.channels.clear();
    this.gauges();
  }

  private onMessage(c: Conn, data: RawData, isBinary: boolean): void {
    const now = this.clock.now();
    c.lastSeen = now;
    if (now - c.windowStart >= this.limits.messageWindowMs) {
      c.windowStart = now;
      c.windowCount = 0;
    }
    c.windowCount += 1;
    if (c.windowCount > this.limits.maxMessagesPerWindow) {
      this.metrics.inc("ws_rate_limited_total");
      this.error(c, "rate_limited");
      c.ws.close(1008, "rate limited");
      return;
    }
    if (isBinary) {
      this.metrics.inc("ws_malformed_total");
      this.error(c, "binary_not_supported");
      return;
    }

    const msg = parseClientMessage(data.toString());
    switch (msg.type) {
      case "ping":
        this.reply(c, { type: "pong" });
        return;
      case "subscribe":
        this.subscribe(c, msg.channels);
        return;
      case "unsubscribe":
        this.unsubscribe(c, msg.channels);
        return;
      case "invalid":
        this.metrics.inc("ws_malformed_total");
        this.error(c, msg.reason);
        return;
    }
  }

  private subscribe(c: Conn, raws: string[]): void {
    const accepted: string[] = [];
    const unknown: string[] = [];
    const overLimit: string[] = [];
    const added: string[] = [];
    for (const raw of raws) {
      const parsed = parseChannel(raw);
      const known =
        parsed !== null &&
        (parsed.channel.kind === "orderbook" || parsed.channel.kind === "trades"
          ? this.validMarkets.has(parsed.channel.marketId)
          : true);
      if (!parsed || !known) {
        unknown.push(String(raw).slice(0, 64));
        continue;
      }
      if (c.channels.has(parsed.name)) {
        if (!accepted.includes(parsed.name)) accepted.push(parsed.name);
        continue;
      }
      if (c.channels.size >= this.limits.maxChannelsPerConnection) {
        overLimit.push(parsed.name);
        continue;
      }
      c.channels.add(parsed.name);
      let set = this.subs.get(parsed.name);
      if (!set) this.subs.set(parsed.name, (set = new Set()));
      set.add(c);
      accepted.push(parsed.name);
      added.push(parsed.name);
    }

    this.reply(c, { type: "subscribed", channels: accepted });
    if (unknown.length > 0) this.error(c, "unknown_channel", unknown);
    if (overLimit.length > 0) this.error(c, "channel_limit", overLimit);
    this.gauges();

    // Snapshot streams: hand the newcomer the current frame instead of making it wait for a change.
    for (const name of added) {
      if (name === channelName.markets && this.marketsFrame) this.send(c, this.marketsFrame.text);
      if (name.startsWith("orderbook:")) {
        const frame = this.books.get(Number(name.slice("orderbook:".length)));
        if (frame) this.send(c, frame.text);
      }
    }
  }

  private unsubscribe(c: Conn, raws: string[]): void {
    const removed: string[] = [];
    for (const raw of raws) {
      const parsed = parseChannel(raw);
      if (!parsed || !c.channels.delete(parsed.name)) continue;
      this.removeSub(c, parsed.name);
      removed.push(parsed.name);
    }
    this.reply(c, { type: "unsubscribed", channels: removed });
    this.gauges();
  }

  /** Remove `c` from `channel`, and forget the channel's state once nobody is left. */
  private removeSub(c: Conn, channel: string): void {
    const set = this.subs.get(channel);
    if (!set) return;
    set.delete(c);
    if (set.size > 0) return;
    this.subs.delete(channel);
    // A stale cached book must not be replayed to the next subscriber, and a
    // tape cursor must restart at the tip rather than replay what nobody saw.
    if (channel.startsWith("orderbook:")) this.books.delete(Number(channel.slice("orderbook:".length)));
    if (channel.startsWith("trades:")) this.tradeCursors.delete(Number(channel.slice("trades:".length)));
  }

  private beat(): void {
    const now = this.clock.now();
    for (const c of this.conns) {
      if (now - c.lastSeen > this.limits.idleTimeoutMs) {
        this.metrics.inc("ws_clients_idle_timeout_total");
        this.log.debug("dropping idle connection", { conn: c.id });
        c.ws.terminate();
        continue;
      }
      if (c.ws.readyState === WebSocket.OPEN) c.ws.ping();
    }
  }

  private gauges(): void {
    let subscriptions = 0;
    for (const c of this.conns) subscriptions += c.channels.size;
    this.metrics.gauge("ws_connections", this.conns.size);
    this.metrics.gauge("ws_channels", this.subs.size);
    this.metrics.gauge("ws_subscriptions", subscriptions);
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  /** What `/healthz` reports. Public so the script can log it at shutdown. */
  health(): { ok: boolean; body: Record<string, unknown> } {
    const now = this.clock.now();
    const age = this.lastPollOkAt === null ? null : now - this.lastPollOkAt;
    const ok = !this.closing && this.lastPollError === null && age !== null && age <= this.limits.healthStaleMs;
    return {
      ok,
      body: {
        status: ok ? "ok" : "degraded",
        service: "ws",
        network: this.network,
        uptime_s: Math.floor((now - this.startedAt) / 1000),
        connections: this.conns.size,
        channels: this.subs.size,
        markets: this.validMarkets.size,
        last_poll_ok_at: this.lastPollOkAt === null ? null : new Date(this.lastPollOkAt).toISOString(),
        last_poll_age_ms: age,
        last_error: this.lastPollError,
      },
    };
  }

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method_not_allowed" });
    if (path === "/healthz") {
      const h = this.health();
      return json(h.ok ? 200 : 503, h.body);
    }
    if (path === "/metrics") return json(200, this.metrics.snapshot());
    return json(426, { error: "upgrade_required", hint: "connect with a WebSocket client" });
  }
}
