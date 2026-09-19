// MarketStream against a fake socket: reference-counted channels, resubscribe
// after a reconnect, routing by channel, and backoff that resets on success.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { MarketStream, channelName, type SocketLike } from "./stream";
import type { StreamEvent } from "./book";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const stream = new MarketStream({
    url: "ws://test",
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    random: () => 0.5, // no jitter
    reconnectMs: 1_000,
    maxReconnectMs: 4_000,
    idleCloseMs: 5_000,
  });
  return { stream, sockets };
}

const book = (marketId: number) => ({ type: "orderbook", market_id: marketId, bids: [], asks: [], timestamp: 1 });

test("subscribes on open, routes by channel, and refcounts listeners", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { stream, sockets } = harness();
  const a: StreamEvent[] = [];
  const b: StreamEvent[] = [];
  const offA = stream.subscribe(channelName.orderbook(2), (e) => a.push(e));
  const offB = stream.subscribe(channelName.orderbook(2), (e) => b.push(e));
  const offC = stream.subscribe(channelName.orderbook(3), () => assert.fail("market 3 got market 2's book"));
  assert.equal(sockets.length, 1, "one socket for every channel");

  sockets[0].open();
  assert.deepEqual(sockets[0].sent, [{ type: "subscribe", channels: ["orderbook:2", "orderbook:3"] }]);
  assert.equal(stream.connected, true);

  sockets[0].receive(book(2));
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);

  offA();
  offA(); // releasing twice is harmless
  assert.equal(sockets[0].sent.length, 1, "channel still held by b");
  offB();
  assert.deepEqual(sockets[0].sent.at(-1), { type: "unsubscribe", channels: ["orderbook:2"] });
  offC();
  stream.close();
});

test("reconnects with backoff, resubscribes everything, resets the delay", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { stream, sockets } = harness();
  const got: StreamEvent[] = [];
  stream.subscribe(channelName.fills("0xaaaa00000000000000000000000000000000aaaa"), (e) => got.push(e));
  stream.subscribe(channelName.markets, (e) => got.push(e));
  sockets[0].open();

  sockets[0].drop();
  assert.equal(stream.connected, false);
  t.mock.timers.tick(999);
  assert.equal(sockets.length, 1, "no reconnect before the delay");
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 2);

  // Fails again before opening: the delay doubles.
  sockets[1].drop();
  t.mock.timers.tick(1_999);
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 3);

  sockets[2].open();
  assert.deepEqual(sockets[2].sent, [
    { type: "subscribe", channels: ["fills:0xaaaa00000000000000000000000000000000aaaa", "markets"] },
  ]);
  sockets[2].receive({ type: "markets", markets: [], timestamp: 5 });
  assert.equal(got.length, 1);

  // Success reset the delay back to the first step.
  sockets[2].drop();
  t.mock.timers.tick(1_000);
  assert.equal(sockets.length, 4);
  stream.close();
});

test("closes when idle, and a new subscriber cancels the idle close", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { stream, sockets } = harness();
  const off = stream.subscribe(channelName.trades(2), () => {});
  sockets[0].open();
  off();
  t.mock.timers.tick(4_000);
  const again = stream.subscribe(channelName.trades(2), () => {});
  t.mock.timers.tick(10_000);
  assert.equal(sockets[0].readyState, 1, "still open: a listener came back");
  again();
  t.mock.timers.tick(5_000);
  assert.equal(sockets[0].readyState, 3, "closed after the idle delay");
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 1, "an idle close does not reconnect");
});

test("errors go to the channels they name", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { stream, sockets } = harness();
  const errs = mock.fn();
  stream.subscribe(channelName.trades(9), errs);
  stream.subscribe(channelName.trades(2), () => assert.fail("error for trades:9 reached trades:2"));
  sockets[0].open();
  sockets[0].receive({ type: "error", message: "unknown_channel", channels: ["trades:9"] });
  assert.equal(errs.mock.callCount(), 1);
  stream.close();
});

test("pings on the interval while open", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { stream, sockets } = harness();
  stream.subscribe(channelName.markets, () => {});
  sockets[0].open();
  t.mock.timers.tick(25_000);
  assert.deepEqual(sockets[0].sent.at(-1), { type: "ping" });
  stream.close();
});
