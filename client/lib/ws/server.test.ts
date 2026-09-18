// The streaming server's socket behaviour: a real server on an ephemeral port,
// real `ws` client sockets, and an in-memory StreamSource standing in for the
// database (lib/ws/stream-db.test.ts runs the real statements).
//
// No database needed; runs in every CI job.

import { after, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { createLogger, Metrics } from "@/lib/keepers/runtime";
import type { BookLevel } from "@/lib/queries/orders";
import type { StreamFill, TradeKey } from "@/lib/queries/stream";
import type { MarketState } from "./protocol";
import { StreamServer, type StreamLimits } from "./server";
import type { StreamSource } from "./source";

const E18 = 10n ** 18n;
const ALICE = "0x00000000000000000000000000000000000a11ce";
const BOB = "0x0000000000000000000000000000000000000b0b";

// ── fake source ─────────────────────────────────────────────────────────────

class FakeSource implements StreamSource {
  marketList: MarketState[] = [market(2, "BTC-PERP"), market(3, "ETH-PERP")];
  bookFor = new Map<number, { bids: BookLevel[]; asks: BookLevel[] }>();
  settled: StreamFill[] = [];
  fills: StreamFill[] = [];
  fail = false;
  bookCalls = 0;

  async markets() {
    if (this.fail) throw new Error("db down");
    return this.marketList;
  }
  async orderbook(marketId: number) {
    this.bookCalls += 1;
    return this.bookFor.get(marketId) ?? { bids: [], asks: [] };
  }
  async latestTradeKey(marketId: number): Promise<TradeKey | null> {
    const mine = this.settled.filter((f) => f.marketId === marketId);
    const last = mine[mine.length - 1];
    return last ? { blockNumber: last.blockNumber!, logIndex: last.logIndex! } : null;
  }
  async tradesAfter(marketId: number, after: TradeKey | null) {
    return this.settled.filter(
      (f) =>
        f.marketId === marketId &&
        f.status === "SETTLED" &&
        (after === null ||
          f.blockNumber! > after.blockNumber ||
          (f.blockNumber === after.blockNumber && f.logIndex! > after.logIndex))
    );
  }
  async fillChanges(addresses: readonly string[], since: Date) {
    return this.fills.filter(
      (f) => (addresses.includes(f.maker) || addresses.includes(f.taker)) && f.updatedAt >= since
    );
  }
}

function market(id: number, symbol: string): MarketState {
  return {
    marketId: id,
    symbol,
    active: true,
    lastMark: 100_000n * E18,
    lastIndex: 100_000n * E18,
    fundingRatePerHour: -(E18 / 100_000n),
    longOpenInterest: 3n * E18,
    shortOpenInterest: 2n * E18,
  };
}

const level = (price: bigint, size: bigint, orders = 1): BookLevel => ({ price: price * E18, size, orders });

let fillSeq = 0;
function fill(v: Partial<StreamFill> = {}): StreamFill {
  fillSeq += 1;
  return {
    fillId: `0x${fillSeq.toString(16).padStart(64, "0")}`,
    status: "SETTLED",
    rejectReason: null,
    marketId: 2,
    maker: BOB,
    taker: ALICE,
    makerOrderHash: "0x01",
    takerOrderHash: "0x02",
    takerIsBuy: true,
    size: E18 / 10n,
    price: 100_000n * E18,
    makerFee: -(10n ** 15n),
    takerFee: 5n * 10n ** 15n,
    txHash: `0x${"ab".repeat(32)}`,
    blockNumber: BigInt(fillSeq),
    logIndex: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...v,
  };
}

// ── harness ─────────────────────────────────────────────────────────────────

interface Client {
  ws: WebSocket;
  inbox: Record<string, unknown>[];
  next(pred?: (m: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  send(v: unknown): void;
  closed: Promise<{ code: number; reason: string }>;
}

const servers: StreamServer[] = [];
const clients: WebSocket[] = [];

async function start(limits: Partial<StreamLimits> = {}, source = new FakeSource()) {
  const metrics = new Metrics();
  const log = createLogger("ws-test", "error", {}, () => {});
  const server = new StreamServer({
    network: "arc-local",
    source,
    log,
    metrics,
    limits: { pingIntervalMs: 60_000, idleTimeoutMs: 120_000, ...limits },
  });
  servers.push(server);
  const port = await server.listen(0, "127.0.0.1");
  return { server, port, source, metrics, url: `ws://127.0.0.1:${port}` };
}

function connect(url: string, opts: { autoPong?: boolean } = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { autoPong: opts.autoPong ?? true });
    clients.push(ws);
    const inbox: Record<string, unknown>[] = [];
    const waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
    ws.on("message", (data) => {
      const m = JSON.parse(String(data)) as Record<string, unknown>;
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else inbox.push(m);
    });
    const closed = new Promise<{ code: number; reason: string }>((res) =>
      ws.on("close", (code, reason) => res({ code, reason: String(reason) }))
    );
    ws.once("open", () =>
      resolve({
        ws,
        inbox,
        closed,
        send: (v) => ws.send(typeof v === "string" ? v : JSON.stringify(v)),
        next(pred = () => true, timeoutMs = 2_000) {
          const i = inbox.findIndex(pred);
          if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const w = { pred, resolve: (m: Record<string, unknown>) => (clearTimeout(t), res(m)) };
            const t = setTimeout(() => {
              waiters.splice(waiters.indexOf(w), 1);
              rej(new Error(`timed out waiting for a message; inbox: ${JSON.stringify(inbox)}`));
            }, timeoutMs);
            waiters.push(w);
          });
        },
      })
    );
    ws.once("error", reject);
  });
}

const ofType = (type: string) => (m: Record<string, unknown>) => m.type === type;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
after(() => {});

// ── tests ───────────────────────────────────────────────────────────────────

describe("ws server: subscriptions", () => {
  test("subscribe, receive the book, receive only changes, unsubscribe", async () => {
    const { server, url, source } = await start();
    source.bookFor.set(2, { bids: [level(99_000n, 2n * E18, 2)], asks: [level(101_000n, E18)] });
    const c = await connect(url);

    c.send({ type: "subscribe", channels: ["orderbook:2", "trades:2"] });
    assert.deepEqual(await c.next(ofType("subscribed")), { type: "subscribed", channels: ["orderbook:2", "trades:2"] });

    await server.pollOnce();
    const book = await c.next(ofType("orderbook"));
    assert.equal(book.market_id, 2);
    assert.deepEqual(book.bids, [
      { price: "99000.0000", size: "2.0000", price_raw: (99_000n * E18).toString(), size_raw: (2n * E18).toString(), orders: 2 },
    ]);
    assert.equal((book.asks as unknown[]).length, 1);
    assert.equal(typeof book.timestamp, "number");

    // Unchanged book → nothing sent.
    await server.pollOnce();
    await sleep(50);
    assert.equal(c.inbox.filter(ofType("orderbook")).length, 0);

    // Changed book → one frame.
    source.bookFor.set(2, { bids: [level(99_000n, E18)], asks: [level(101_000n, E18)] });
    await server.pollOnce();
    const changed = await c.next(ofType("orderbook"));
    assert.equal((changed.bids as { size: string }[])[0].size, "1.0000");

    c.send({ type: "unsubscribe", channels: ["orderbook:2"] });
    assert.deepEqual(await c.next(ofType("unsubscribed")), { type: "unsubscribed", channels: ["orderbook:2"] });
    source.bookFor.set(2, { bids: [], asks: [] });
    await server.pollOnce();
    await sleep(50);
    assert.equal(c.inbox.filter(ofType("orderbook")).length, 0);
  });

  test("a late subscriber gets the current book at once", async () => {
    const { server, url, source } = await start();
    source.bookFor.set(2, { bids: [level(99_000n, E18)], asks: [] });
    const a = await connect(url);
    a.send({ type: "subscribe", channels: ["orderbook:2"] });
    await a.next(ofType("subscribed"));
    await server.pollOnce();
    await a.next(ofType("orderbook"));

    const b = await connect(url);
    b.send({ type: "subscribe", channels: ["orderbook:2"] });
    await b.next(ofType("subscribed"));
    const snap = await b.next(ofType("orderbook"));
    assert.equal((snap.bids as unknown[]).length, 1);
  });

  test("markets channel: snapshot on subscribe, then only on change", async () => {
    const { server, url, source } = await start({ marketsPollMs: 0 });
    await server.pollOnce();
    const c = await connect(url);
    c.send({ type: "subscribe", channels: ["markets"] });
    await c.next(ofType("subscribed"));
    const snap = await c.next(ofType("markets"));
    const m = (snap.markets as Record<string, unknown>[])[0];
    assert.equal(m.market_id, 2);
    assert.equal(m.symbol, "BTC-PERP");
    assert.equal(m.mark_price, "100000.0000");
    assert.equal(m.funding_rate_per_hour, "-0.0000100000");
    assert.equal(m.long_open_interest, "3.0000");

    await server.pollOnce();
    await sleep(50);
    assert.equal(c.inbox.filter(ofType("markets")).length, 0);

    source.marketList = [{ ...source.marketList[0], lastMark: 101_000n * E18 }, source.marketList[1]];
    await server.pollOnce();
    const changed = await c.next(ofType("markets"));
    assert.equal((changed.markets as Record<string, unknown>[])[0].mark_price, "101000.0000");
  });

  test("an unknown channel is refused, and nothing is recorded for it", async () => {
    const { url } = await start();
    const c = await connect(url);
    c.send({ type: "subscribe", channels: ["orderbook:99", "candles:2", "fills:0xnotanaddress", "orderbook:2"] });
    assert.deepEqual(await c.next(ofType("subscribed")), { type: "subscribed", channels: ["orderbook:2"] });
    const err = await c.next(ofType("error"));
    assert.equal(err.message, "unknown_channel");
    assert.deepEqual(err.channels, ["orderbook:99", "candles:2", "fills:0xnotanaddress"]);
  });

  test("the per-connection channel cap holds", async () => {
    const { url } = await start({ maxChannelsPerConnection: 2 });
    const c = await connect(url);
    c.send({ type: "subscribe", channels: ["orderbook:2", "trades:2", "orderbook:3"] });
    assert.deepEqual((await c.next(ofType("subscribed"))).channels, ["orderbook:2", "trades:2"]);
    const err = await c.next(ofType("error"));
    assert.equal(err.message, "channel_limit");
    assert.deepEqual(err.channels, ["orderbook:3"]);
    // Re-subscribing to a channel already held is not a new channel.
    c.send({ type: "subscribe", channels: ["trades:2"] });
    assert.deepEqual((await c.next(ofType("subscribed"))).channels, ["trades:2"]);
  });

  test("a checksummed address subscribes to the lowercase channel", async () => {
    const { url } = await start();
    const c = await connect(url);
    // EIP-55 form of 0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed.
    c.send({ type: "subscribe", channels: ["fills:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"] });
    assert.deepEqual((await c.next(ofType("subscribed"))).channels, ["fills:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"]);
  });
});

describe("ws server: trades and fills", () => {
  test("the tape carries settled fills only, from the tip, in chain order", async () => {
    const { server, url, source } = await start();
    source.settled.push(fill()); // history before the subscription
    const c = await connect(url);
    c.send({ type: "subscribe", channels: ["trades:2"] });
    await c.next(ofType("subscribed"));
    await server.pollOnce(); // positions the cursor at the tip

    const pending = fill({ status: "PENDING", blockNumber: null, logIndex: null, txHash: null });
    const a = fill({ takerIsBuy: false });
    const b = fill();
    source.settled.push(pending, a, b);
    await server.pollOnce();

    const t1 = await c.next(ofType("trade"));
    const t2 = await c.next(ofType("trade"));
    assert.equal(t1.fill_id, a.fillId);
    assert.equal(t1.side, "sell");
    assert.equal(t2.fill_id, b.fillId);
    assert.equal(t2.side, "buy");
    assert.equal(t1.price, "100000.0000");
    assert.equal(t1.size, "0.1000");
    await sleep(50);
    assert.equal(c.inbox.filter(ofType("trade")).length, 0, "the pending fill and the history must not print");

    await server.pollOnce();
    await sleep(50);
    assert.equal(c.inbox.filter(ofType("trade")).length, 0, "a print is sent once");
  });

  test("fills:<address> labels each transition PENDING → SETTLED once", async () => {
    const { server, url, source } = await start();
    const c = await connect(url);
    c.send({ type: "subscribe", channels: [`fills:${BOB}`] });
    await c.next(ofType("subscribed"));

    const f = fill({ status: "PENDING", blockNumber: null, logIndex: null, txHash: null });
    source.fills = [f];
    await server.pollOnce();
    const p = await c.next(ofType("fill"));
    assert.equal(p.status, "PENDING");
    assert.equal(p.role, "maker");
    assert.equal(p.side, "sell", "the maker took the other side of a taker buy");
    assert.equal(p.fee_raw, (-(10n ** 15n)).toString());

    await server.pollOnce();
    await sleep(50);
    assert.equal(c.inbox.filter(ofType("fill")).length, 0, "no repeat inside the overlap window");

    source.fills = [{ ...f, status: "SETTLED", blockNumber: 9n, logIndex: 1, updatedAt: new Date(Date.now() + 5) }];
    await server.pollOnce();
    const s = await c.next(ofType("fill"));
    assert.equal(s.status, "SETTLED");
    assert.equal(s.block_number, "9");
  });
});

describe("ws server: protocol robustness", () => {
  test("ping/pong both ways", async () => {
    const { url } = await start({ pingIntervalMs: 50 });
    const c = await connect(url);
    c.send({ type: "ping" });
    assert.deepEqual(await c.next(ofType("pong")), { type: "pong" });
    const pinged = await new Promise<boolean>((res) => {
      c.ws.once("ping", () => res(true));
      setTimeout(() => res(false), 1_000);
    });
    assert.ok(pinged, "server sends protocol pings");
  });

  test("malformed, binary and unknown frames are answered, never fatal", async () => {
    const { url, metrics } = await start();
    const c = await connect(url);
    c.send("{not json");
    assert.equal((await c.next(ofType("error"))).message, "malformed");
    c.send("[1,2]");
    assert.equal((await c.next(ofType("error"))).message, "malformed");
    c.send({ type: "subscribe", channels: "orderbook:2" });
    assert.equal((await c.next(ofType("error"))).message, "malformed");
    c.send({ type: "hello" });
    assert.equal((await c.next(ofType("error"))).message, "unknown_type");
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    assert.equal((await c.next(ofType("error"))).message, "binary_not_supported");
    // Still serving.
    c.send({ type: "ping" });
    await c.next(ofType("pong"));
    assert.equal(metrics.snapshot().counters.ws_malformed_total, "5");
  });

  test("an oversized frame closes that connection only", async () => {
    const { url } = await start({ maxPayloadBytes: 1024 });
    const big = await connect(url);
    const ok = await connect(url);
    big.send({ type: "subscribe", channels: ["x".repeat(4096)] });
    const closed = await big.closed;
    assert.equal(closed.code, 1009);
    ok.send({ type: "ping" });
    await ok.next(ofType("pong"));
  });

  test("the inbound rate limit closes a flooding client", async () => {
    const { url } = await start({ maxMessagesPerWindow: 5, messageWindowMs: 60_000 });
    const c = await connect(url);
    for (let i = 0; i < 10; i++) c.send({ type: "ping" });
    assert.equal((await c.next(ofType("error"))).message, "rate_limited");
    assert.equal((await c.closed).code, 1008);
  });
});

describe("ws server: bounds", () => {
  test("the connection cap refuses the extra upgrade with 503", async () => {
    const { url, metrics } = await start({ maxConnections: 2 });
    await connect(url);
    await connect(url);
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url);
      clients.push(ws);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => reject(new Error("third connection was accepted")));
      ws.on("error", () => {});
    });
    assert.equal(status, 503);
    assert.equal(metrics.snapshot().counters.ws_connections_rejected_total, "1");
  });

  test("a slow consumer is dropped instead of buffered without bound", async () => {
    const { server, url, source, metrics } = await start({ maxBufferedBytes: 64 * 1024 });
    const slow = await connect(url);
    const fast = await connect(url);
    for (const c of [slow, fast]) {
      c.send({ type: "subscribe", channels: ["orderbook:2"] });
      await c.next(ofType("subscribed"));
    }
    // Stop reading: the kernel buffers fill, then the server's queue grows.
    (slow.ws as unknown as { _socket: { pause(): void } })._socket.pause();

    let fastFrames = 0;
    fast.ws.on("message", () => (fastFrames += 1));
    for (let i = 0; i < 400 && metrics.snapshot().counters.ws_clients_dropped_slow_total === undefined; i++) {
      // A deep book, different every poll, so every poll broadcasts ~60 KB.
      const bids = Array.from({ length: 600 }, (_, k) => level(BigInt(90_000 + k), BigInt(i + 1) * E18));
      source.bookFor.set(2, { bids, asks: [] });
      await server.pollOnce();
      await sleep(1);
    }
    assert.equal(metrics.snapshot().counters.ws_clients_dropped_slow_total, "1");
    await sleep(100);
    assert.ok(fastFrames > 0, "the reading client kept receiving");
    fast.send({ type: "ping" });
    await fast.next(ofType("pong"));
  });

  test("an idle connection that stops answering pings is dropped", async () => {
    const { url, metrics } = await start({ pingIntervalMs: 50, idleTimeoutMs: 200 });
    const dead = await connect(url, { autoPong: false });
    const live = await connect(url);
    await dead.closed;
    assert.equal(metrics.snapshot().counters.ws_clients_idle_timeout_total, "1");
    live.send({ type: "ping" });
    await live.next(ofType("pong"));
  });
});

describe("ws server: health and shutdown", () => {
  test("/healthz is 503 until the database answers, 200 after, 503 when reads go stale", async () => {
    const down = new FakeSource();
    down.fail = true;
    const { server, port, source } = await start({ healthStaleMs: 150, marketsPollMs: 100 }, down);
    const get = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    assert.equal((await get("/healthz")).status, 503);
    source.fail = false;
    await server.pollOnce();
    const ok = await get("/healthz");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, "ok");
    assert.equal(ok.body.network, "arc-local");
    assert.equal(ok.body.markets, 2);

    source.fail = true;
    await sleep(200);
    await server.pollOnce();
    const bad = await get("/healthz");
    assert.equal(bad.status, 503);
    assert.match(String(bad.body.last_error), /db down/);

    const m = await get("/metrics");
    assert.equal(m.status, 200);
    assert.ok("counters" in m.body);
    assert.equal((await get("/")).status, 426);
  });

  test("shutdown closes every client with 1001 and frees the port", async () => {
    const { server, port, url } = await start();
    const a = await connect(url);
    const b = await connect(url);
    a.send({ type: "subscribe", channels: ["orderbook:2"] });
    await a.next(ofType("subscribed"));

    const controller = new AbortController();
    const running = server.run(controller.signal);
    await sleep(20);
    controller.abort();
    await running;

    assert.equal((await a.closed).code, 1001);
    assert.equal((await b.closed).code, 1001);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  });
});
