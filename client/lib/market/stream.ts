/**
 * Browser client for the Kryon WebSocket server (scripts/ws-server.ts).
 *
 * Channels, as lib/ws/protocol.ts names them:
 *   orderbook:<marketId>   the aggregated book, remaining sizes
 *   trades:<marketId>      settled prints
 *   fills:<address>        the caller's own fills, PENDING → SETTLED / REJECTED
 *   markets                every market's mark, index, funding and OI
 *
 * One socket per network, shared by every component. Channels are
 * reference-counted: the socket subscribes on the first listener and
 * unsubscribes after the last. After a reconnect it resubscribes to every live
 * channel, and the server answers each subscription with a snapshot, so
 * nothing needs replaying.
 *
 * No URL configured means no socket at all: `enabled` is false and callers
 * poll the REST routes instead (MarketDataProvider does both, preferring this).
 */

import { parseServerMessage, type StreamEvent } from "@/lib/market/book";
import { channelName } from "@/lib/ws/protocol";
import { getWsUrl, type ArcNetworkId } from "@/lib/network";

export { channelName };

export type StreamListener = (event: StreamEvent) => void;
export type StatusListener = (connected: boolean) => void;

/** The subset of the DOM WebSocket this client uses, so tests can fake it. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface StreamOptions {
  url: string;
  createSocket?: (url: string) => SocketLike;
  pingIntervalMs?: number;
  /** First reconnect delay; doubles to `maxReconnectMs`, with ±20% jitter. */
  reconnectMs?: number;
  maxReconnectMs?: number;
  /** Close the socket this long after the last channel is released. */
  idleCloseMs?: number;
  random?: () => number;
}

const OPEN = 1;

/** The channel an event belongs to. */
function channelOf(ev: StreamEvent): string | null {
  switch (ev.kind) {
    case "orderbook":
      return channelName.orderbook(ev.marketId);
    case "trade":
      return channelName.trades(ev.marketId);
    case "fill":
      return channelName.fills(ev.address);
    case "markets":
      return channelName.markets;
    default:
      return null;
  }
}

export class MarketStream {
  private readonly opts: Required<Omit<StreamOptions, "createSocket">> & Pick<StreamOptions, "createSocket">;
  private socket: SocketLike | null = null;
  private readonly listeners = new Map<string, Set<StreamListener>>();
  private readonly statusListeners = new Set<StatusListener>();
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private isConnected = false;
  private closed = false;

  constructor(options: StreamOptions) {
    this.opts = {
      pingIntervalMs: 25_000,
      reconnectMs: 1_000,
      maxReconnectMs: 30_000,
      idleCloseMs: 10_000,
      random: Math.random,
      ...options,
    };
    this.reconnectDelay = this.opts.reconnectMs;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Listen on a channel. The returned function releases it; call it on unmount.
   * Errors for this channel (unknown channel, limits) arrive as `error` events.
   */
  subscribe(channel: string, listener: StreamListener): () => void {
    let set = this.listeners.get(channel);
    const isNew = !set;
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    this.cancelIdleClose();
    if (isNew) this.send({ type: "subscribe", channels: [channel] });
    this.ensureSocket();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        this.send({ type: "unsubscribe", channels: [channel] });
        if (this.listeners.size === 0) this.scheduleIdleClose();
      }
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Tear down for good (network switch, tests). */
  close(): void {
    this.closed = true;
    this.clearTimers();
    this.listeners.clear();
    this.socket?.close();
    this.socket = null;
    this.setConnected(false);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private ensureSocket(): void {
    if (this.closed || this.socket || this.reconnectTimer) return;
    this.connect();
  }

  private connect(): void {
    if (this.closed || this.listeners.size === 0) return;
    let socket: SocketLike;
    try {
      socket = this.opts.createSocket
        ? this.opts.createSocket(this.opts.url)
        : (new WebSocket(this.opts.url) as unknown as SocketLike);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectDelay = this.opts.reconnectMs;
      this.setConnected(true);
      this.startPing();
      const channels = [...this.listeners.keys()];
      if (channels.length > 0) this.send({ type: "subscribe", channels });
    };
    socket.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      this.dispatch(parseServerMessage(e.data));
    };
    socket.onerror = () => {
      /* onclose follows */
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.stopPing();
      this.setConnected(false);
      if (!this.closed && this.listeners.size > 0) this.scheduleReconnect();
    };
  }

  private dispatch(ev: StreamEvent | null): void {
    if (!ev) return;
    if (ev.kind === "error") {
      // An error names the channels it concerns; tell exactly those listeners.
      for (const c of ev.channels) this.listeners.get(c)?.forEach((l) => l(ev));
      return;
    }
    const channel = channelOf(ev);
    if (channel) this.listeners.get(channel)?.forEach((l) => l(ev));
  }

  private send(payload: object): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(payload));
  }

  private setConnected(v: boolean): void {
    if (this.isConnected === v) return;
    this.isConnected = v;
    this.statusListeners.forEach((l) => l(v));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const jitter = 0.8 + this.opts.random() * 0.4;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay * jitter);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.opts.maxReconnectMs);
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.listeners.size > 0) return;
      this.stopPing();
      const s = this.socket;
      this.socket = null;
      s?.close();
      this.setConnected(false);
    }, this.opts.idleCloseMs);
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), this.opts.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers(): void {
    this.stopPing();
    this.cancelIdleClose();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

const streams = new Map<ArcNetworkId, MarketStream>();

/**
 * The shared stream for a network, or null when that network has no WS URL
 * configured (NEXT_PUBLIC_WS_URL_ARC_*): the caller polls REST instead.
 */
export function marketStream(network: ArcNetworkId): MarketStream | null {
  if (typeof window === "undefined") return null;
  const url = getWsUrl(network);
  if (!url) return null;
  let s = streams.get(network);
  if (!s) {
    s = new MarketStream({ url });
    streams.set(network, s);
  }
  return s;
}
