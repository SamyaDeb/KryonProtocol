// The browser reads only the exact `*_raw` integers, and drops anything
// malformed instead of throwing. Fixtures are built with the server's own
// encoders (lib/ws/protocol.ts), so a protocol change breaks this test rather
// than the trading screen.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fillMessage, levelJson, tradeMessage, type ServerMessage } from "@/lib/ws/protocol";
import type { StreamFill } from "@/lib/queries/stream";
import { aggregateSide, big, parseOrderBook, parseServerMessage, parseTicker, parseTrade, spreadOf, stats24hFromCandles, tickToWei } from "./book";

const E18 = 10n ** 18n;
const ALICE = "0xaaaa00000000000000000000000000000000aaaa";
const BOB = "0xbbbb00000000000000000000000000000000bbbb";

const fill = (over: Partial<StreamFill> = {}): StreamFill =>
  ({
    fillId: "0xf1",
    status: "PENDING",
    rejectReason: null,
    marketId: 2,
    maker: BOB,
    taker: ALICE,
    takerIsBuy: true,
    price: 24_187n * 10n ** 13n, // 0.24187: needs 5dp, so the 4dp display string is lossy
    size: 3n * E18 + 1n,
    makerFee: -5n,
    takerFee: 35n,
    txHash: null,
    blockNumber: null,
    createdAt: new Date(1_800_000_000_000),
    updatedAt: new Date(1_800_000_001_000),
    ...over,
  }) as StreamFill;

test("big accepts decimal integer strings only", () => {
  assert.equal(big("123"), 123n);
  assert.equal(big("-5"), -5n);
  assert.equal(big(7n), 7n);
  for (const bad of ["", "1.5", "1e18", "0x10", " 1", null, undefined, 12, "9".repeat(81)]) {
    assert.equal(big(bad), null, `${String(bad)} must not parse`);
  }
});

test("order book: raw values, bad levels dropped, best price first", () => {
  const level = (p: bigint, s: bigint) => levelJson({ price: p * E18, size: s * E18, orders: 1 });
  const book = parseOrderBook({
    bids: [level(99n, 1n), level(100n, 2n), { price: "100", size: "1" }],
    asks: [level(102n, 1n), level(101n, 3n), level(103n, 0n)],
    timestamp: 42,
  });
  assert.ok(book);
  assert.deepEqual(book.bids.map((l) => l.price), [100n * E18, 99n * E18]);
  assert.deepEqual(book.asks.map((l) => l.price), [101n * E18, 102n * E18], "zero-size level dropped");
  assert.equal(book.asks[0].size, 3n * E18);
  assert.equal(book.timestamp, 42);
  assert.equal(parseOrderBook({ bids: [] }), null);
  assert.equal(parseOrderBook(null), null);
});

test("trade: the raw price survives where the display string cannot", () => {
  const msg = tradeMessage(fill({ status: "SETTLED", txHash: "0xabc", blockNumber: 7n }));
  const t = parseTrade(msg);
  assert.ok(t);
  assert.equal(t.price, 24_187n * 10n ** 13n);
  assert.equal(t.size, 3n * E18 + 1n, "one wei of size is kept");
  assert.equal(t.side, "buy");
  assert.equal(t.txHash, "0xabc");
  assert.equal(parseTrade({ ...msg, price_raw: "0.5" }), null);
});

test("own fill: role, side, fee and status per viewer", () => {
  const asMaker = parseServerMessage(JSON.stringify(fillMessage(BOB, fill())));
  assert.ok(asMaker && asMaker.kind === "fill");
  assert.equal(asMaker.fill.role, "maker");
  assert.equal(asMaker.fill.side, "sell", "the maker took the other side");
  assert.equal(asMaker.fill.fee, -5n, "a rebate stays negative");
  assert.equal(asMaker.fill.status, "PENDING");
  assert.equal(asMaker.fill.blockNumber, null);

  const rejected = parseServerMessage(
    JSON.stringify(fillMessage(ALICE, fill({ status: "REJECTED", rejectReason: "AccountInsolvent" })))
  );
  assert.ok(rejected && rejected.kind === "fill");
  assert.equal(rejected.fill.role, "taker");
  assert.equal(rejected.fill.rejectReason, "AccountInsolvent");
  assert.equal(rejected.fill.fee, 35n);
});

test("markets ticker parses every raw field", () => {
  const t = parseTicker({
    market_id: 2, symbol: "BTC", active: true,
    mark_price_raw: (65_000n * E18).toString(), index_price_raw: (64_990n * E18).toString(),
    funding_rate_per_hour_raw: (-(E18 / 10_000n)).toString(),
    long_open_interest_raw: E18.toString(), short_open_interest_raw: "0",
  });
  assert.ok(t);
  assert.equal(t.fundingRatePerHour, -(E18 / 10_000n));
  assert.equal(parseTicker({ market_id: 2, symbol: "BTC", active: "yes" }), null);
});

test("server frames: routed by type, acks and garbage ignored", () => {
  const book: ServerMessage = { type: "orderbook", market_id: 3, bids: [], asks: [], timestamp: 1 };
  const ev = parseServerMessage(JSON.stringify(book));
  assert.deepEqual(ev, { kind: "orderbook", marketId: 3, book: { bids: [], asks: [], timestamp: 1 } });

  const err = parseServerMessage(JSON.stringify({ type: "error", message: "channel_limit", channels: ["trades:9"] }));
  assert.deepEqual(err, { kind: "error", message: "channel_limit", channels: ["trades:9"] });

  assert.equal(parseServerMessage(JSON.stringify({ type: "pong" })), null);
  assert.equal(parseServerMessage(JSON.stringify({ type: "subscribed", channels: [] })), null);
  assert.equal(parseServerMessage("not json"), null);
  assert.equal(parseServerMessage("[1,2]"), null);
});

test("ticks convert exactly, with no float residue", () => {
  assert.equal(tickToWei(0.1), E18 / 10n);
  assert.equal(tickToWei(0.00001), E18 / 100_000n);
  assert.equal(tickToWei(5), 5n * E18);
  assert.equal(tickToWei(0.01), E18 / 100n);
  assert.throws(() => tickToWei(0));
});

test("aggregation: bids round down, asks up, best first, running totals", () => {
  const lv = (p: bigint, s: bigint) => ({ price: p, size: s, orders: 1 });
  const tick = E18; // $1
  const bids = aggregateSide([lv(100n * E18 + E18 / 2n, E18), lv(100n * E18, 2n * E18), lv(99n * E18, E18)], tick, "bid", {
    depth: 10,
    quote: false,
  });
  assert.deepEqual(bids.map((r) => [r.price, r.size, r.total]), [
    [100n * E18, 3n * E18, 3n * E18],
    [99n * E18, E18, 4n * E18],
  ]);
  const asks = aggregateSide([lv(101n * E18 + 1n, E18), lv(101n * E18, E18)], tick, "ask", { depth: 10, quote: true });
  assert.deepEqual(asks.map((r) => r.price), [101n * E18, 102n * E18], "an ask one wei above 101 buckets at 102");
  assert.equal(asks[0].amount, 101n * E18, "quote amount is size × price");
  assert.equal(asks[1].total, 101n * E18 + 102n * E18);
  assert.equal(aggregateSide([lv(1n, 1n), lv(2n, 1n), lv(3n, 1n)], 1n, "ask", { depth: 2, quote: false }).length, 2);
});

test("spread and mid", () => {
  const lv = (p: bigint) => ({ price: p, size: E18, orders: 1 });
  const s = spreadOf({ bids: [lv(100n * E18)], asks: [lv(101n * E18)] });
  assert.ok(s);
  assert.equal(s.spread, E18);
  assert.equal(s.mid, 100n * E18 + E18 / 2n);
  assert.equal(s.spreadPpm, 995_024n, "≈ 0.995%, in 1e-8 units");
  assert.equal(spreadOf({ bids: [], asks: [lv(1n)] }), null);
});

test("24h stats: only the last day's buckets, oldest open first", () => {
  const now = 1_800_000_000_000;
  const hour = (h: number, o: bigint, hi: bigint, lo: bigint) => ({
    time: Math.floor(now / 1000) - h * 3600, open_raw: String(o), high_raw: String(hi), low_raw: String(lo),
  });
  const s = stats24hFromCandles([hour(30, 1n, 999n, 1n), hour(20, 10n, 15n, 9n), hour(2, 12n, 20n, 11n), { time: "x" }], now);
  assert.deepEqual(s, { open: 10n, high: 20n, low: 9n });
  assert.deepEqual(stats24hFromCandles([], now), { open: 0n, high: 0n, low: 0n });
  assert.deepEqual(stats24hFromCandles(null, now), { open: 0n, high: 0n, low: 0n });
});
