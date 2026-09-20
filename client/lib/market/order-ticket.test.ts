// The ticket blocks what settlement would reject, with the contracts' own
// arithmetic. Numbers are BTC-like: 2% initial, 1% maintenance, $40 minimum,
// 0.5 / 3.5 bps.

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateTicket, maxOrderSize, type TicketInput } from "./order-ticket";

const E18 = 10n ** 18n;
const usd = (n: number | bigint) => BigInt(n) * E18;

const base = (over: Partial<TicketInput> = {}): TicketInput => ({
  market: { active: true, initialMarginBps: 200, maintenanceMarginBps: 100, minFillNotional: usd(40), maxExecutionDeviationBps: 75 },
  side: "buy",
  kind: "limit",
  size: E18 / 10n, // 0.1 BTC
  limitPrice: usd(59_000),
  slippageBps: 100,
  reduceOnly: false,
  postOnly: false,
  bestBid: usd(59_900),
  bestAsk: usd(60_100),
  indexPrice: usd(60_000),
  position: { size: 0n, openNotional: 0n },
  health: { equity: usd(1_000), initialMarginRequired: 0n, maintenanceMarginRequired: 0n },
  makerRate: 50,
  takerRate: 350,
  ...over,
});

test("a resting limit: maker fee, no errors, IM on its notional", () => {
  const r = evaluateTicket(base());
  assert.deepEqual(r.errors, []);
  assert.equal(r.crosses, false);
  assert.equal(r.execPrice, usd(59_000));
  assert.equal(r.notional, usd(5_900));
  assert.equal(r.fee, (usd(5_900) * 50n + 999_999n) / 1_000_000n, "maker 0.5 bps, rounded up");
  assert.equal(r.orderMargin, usd(118));
  assert.deepEqual(r.positionAfter, { size: E18 / 10n, openNotional: usd(5_900) });
});

test("a market buy: slippage-bounded limit over the best ask, fills at the ask, taker fee", () => {
  // 100bps of slippage off a 60,100 ask is 60,701, past the 75bps band around
  // the 60,000 index, so the signed price is the band's edge instead.
  const r = evaluateTicket(base({ kind: "market", limitPrice: null }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.limitPrice, (usd(60_000) * 10_075n) / 10_000n);
  assert.equal(r.slippageClamped, true);
  assert.equal(r.crosses, true);
  assert.equal(r.execPrice, usd(60_100));
  assert.equal(r.fee, (usd(6_010) * 350n) / 1_000_000n);
});

test("slippage inside the band is left alone", () => {
  const r = evaluateTicket(base({ kind: "market", limitPrice: null, slippageBps: 25 }));
  assert.equal(r.limitPrice, (usd(60_100) * 10_025n) / 10_000n, "off the ask, as asked");
  assert.equal(r.slippageClamped, false);
});

test("a market order never signs a price the chain would refuse", () => {
  // The band is what Engine.applyFill enforces; past its edge a fill is not a
  // trade but a guaranteed rejection, and an order resting there is a maker
  // whose price can never be matched.
  for (const side of ["buy", "sell"] as const) {
    for (const slippageBps of [100, 500, 5_000]) {
      const r = evaluateTicket(base({ kind: "market", limitPrice: null, side, slippageBps, bestBid: null, bestAsk: null }));
      const edge = side === "buy" ? (usd(60_000) * 10_075n) / 10_000n : (usd(60_000) * 9_925n) / 10_000n;
      assert.equal(r.limitPrice, edge, `${side} at ${slippageBps}bps`);
      assert.equal(r.slippageClamped, true);
    }
  }
});

test("a limit order outside the band is still the user's to place", () => {
  // Unlike a market order, a resting limit is a standing offer: the band is
  // measured at fill time, so it becomes fillable when the index reaches it.
  const r = evaluateTicket(base({ side: "buy", limitPrice: usd(50_000) }));
  assert.equal(r.limitPrice, usd(50_000), "left exactly as typed");
  assert.equal(r.slippageClamped, false);
});

test("a market sell with an empty book prices off the index", () => {
  const r = evaluateTicket(base({ kind: "market", side: "sell", bestBid: null, bestAsk: null }));
  // ...and the band still caps it: 100bps asked, 75bps is all a fill can use.
  assert.equal(r.limitPrice, (usd(60_000) * 9_925n) / 10_000n);
  assert.equal(r.crosses, false, "nothing to cross: it rests");
  const none = evaluateTicket(base({ kind: "market", bestAsk: null, indexPrice: 0n }));
  assert.ok(none.errors.includes("no_reference_price"));
});

test("post-only refuses a crossing limit", () => {
  const r = evaluateTicket(base({ limitPrice: usd(60_200), postOnly: true }));
  assert.ok(r.errors.includes("post_only_would_cross"));
  assert.ok(!evaluateTicket(base({ postOnly: true })).errors.includes("post_only_would_cross"));
});

test("minimum fill notional", () => {
  const r = evaluateTicket(base({ size: E18 / 10_000n })); // $5.90
  assert.ok(r.errors.includes("below_min_notional"));
});

test("inactive market: blocked, except a reduce-only close", () => {
  const paused = { active: false, initialMarginBps: 200, maintenanceMarginBps: 100, minFillNotional: usd(40), maxExecutionDeviationBps: 75 };
  assert.ok(evaluateTicket(base({ market: paused })).errors.includes("market_inactive"));
  const close = evaluateTicket(
    base({ market: paused, side: "sell", reduceOnly: true, position: { size: E18 / 10n, openNotional: usd(6_000) } })
  );
  assert.ok(!close.errors.includes("market_inactive"));
});

test("reduce-only rules", () => {
  assert.ok(evaluateTicket(base({ reduceOnly: true })).errors.includes("reduce_only_no_position"));
  const long = { size: E18 / 10n, openNotional: usd(6_000) };
  assert.ok(evaluateTicket(base({ reduceOnly: true, position: long })).errors.includes("reduce_only_wrong_side"));
  assert.ok(
    evaluateTicket(base({ reduceOnly: true, side: "sell", size: E18, position: long })).errors.includes("reduce_only_too_large")
  );
  assert.deepEqual(evaluateTicket(base({ reduceOnly: true, side: "sell", position: long, limitPrice: usd(61_000) })).errors, []);
});

test("insufficient margin blocks increasing orders only", () => {
  // $100 equity cannot hold 0.1 BTC bought at the index at 2% ($120 IM).
  // (Bought $1,000 under the index it could: that fill marks +$100 at once.)
  const poor = { equity: usd(100), initialMarginRequired: 0n, maintenanceMarginRequired: 0n };
  const r = evaluateTicket(base({ health: poor, limitPrice: usd(60_000) }));
  assert.ok(!evaluateTicket(base({ health: poor })).errors.includes("insufficient_margin"));
  assert.ok(r.errors.includes("insufficient_margin"));
  assert.ok(r.marginHeadroom! < 0n);
  // Closing half of an existing long needs no initial margin even when thin.
  const long = { size: E18 / 5n, openNotional: usd(12_000) };
  const thin = { equity: usd(150), initialMarginRequired: usd(240), maintenanceMarginRequired: usd(120) };
  const close = evaluateTicket(base({ side: "sell", size: E18 / 10n, limitPrice: usd(60_000), position: long, health: thin }));
  assert.ok(!close.errors.includes("insufficient_margin"));
});

test("liquidation price after a fill matches the single-position formula", () => {
  // Flat account, $1,000 equity, buys 0.1 BTC at the index: E ≈ 1,000 − fee.
  const r = evaluateTicket(base({ limitPrice: usd(60_000), bestAsk: usd(60_000), kind: "limit" }));
  assert.ok(r.liquidationPrice !== null);
  const equity = usd(1_000) - r.fee;
  // P = (0 + s·price − E) / (s · (1 − m)) with s = 0.1, price = index
  const expected = ((usd(6_000) - equity) * E18 * 10_000n) / ((E18 / 10n) * 9_900n);
  assert.equal(r.liquidationPrice, expected);
  assert.ok(r.liquidationPrice! < usd(60_000));
});

test("no health read yet: previews without margin or liquidation figures", () => {
  const r = evaluateTicket(base({ health: null }));
  assert.equal(r.marginHeadroom, null);
  assert.equal(r.liquidationPrice, null);
  assert.deepEqual(r.errors, []);
});

test("max size: headroom over IM plus taker fee, floored to the size step", () => {
  const step = E18 / 10_000n; // BTC shows 4 decimals
  const max = maxOrderSize({ headroom: usd(1_000), price: usd(60_000), initialMarginBps: 200, takerRate: 350, step });
  // per BTC: 60,000 × (0.02 + 0.00035) = 1,221 → 1,000 / 1,221 = 0.81900…
  assert.equal(max, 8_190n * step);
  assert.equal(maxOrderSize({ headroom: 0n, price: usd(1), initialMarginBps: 200, takerRate: 0, step }), 0n);
});
