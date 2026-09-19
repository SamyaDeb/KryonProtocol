// Position arithmetic, pinned to the contracts' rounding. Each case says which
// Solidity path it mirrors, so a divergence points at the line to compare.

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyFill, entryPrice, feeFor, liquidationPrice, marginAt, notional, unrealizedPnl } from "./math";

const E18 = 10n ** 18n;
const usd = (n: number | bigint) => BigInt(n) * E18;

test("notional truncates like KryonMath.mulPrecision, sign ignored", () => {
  assert.equal(notional(E18 / 2n, usd(60_000)), usd(30_000));
  assert.equal(notional(-E18 / 2n, usd(60_000)), usd(30_000));
  assert.equal(notional(1n, 1n), 0n, "wei × wei truncates to zero");
  assert.equal(notional(3n, E18 / 2n), 1n);
});

test("fees round up on debits and toward zero on rebates (FeeRouter.quote)", () => {
  // 3.5 bps on $60,000 is exactly $21.
  assert.equal(feeFor(usd(60_000), 350n), usd(21));
  assert.equal(feeFor(1n, 350n), 1n, "a one-wei notional still pays one wei");
  assert.equal(feeFor(3n, 500_000n), 2n, "1.5 rounds up to 2");
  assert.equal(feeFor(3n, -500_000n), -1n, "a 1.5 rebate rounds down to 1");
  assert.equal(feeFor(usd(1), 0n), 0n);
  assert.equal(feeFor(0n, 350n), 0n);
});

test("entry price is |basis| / |size|, floored at one wei", () => {
  assert.equal(entryPrice(E18, usd(60_000)), usd(60_000));
  assert.equal(entryPrice(-2n * E18, -usd(120_000)), usd(60_000));
  assert.equal(entryPrice(E18, 0n), 1n);
  assert.equal(entryPrice(0n, usd(5)), 0n);
});

test("unrealized PnL: gains and losses on both sides", () => {
  assert.equal(unrealizedPnl(E18, usd(60_000), usd(61_000)), usd(1_000));
  assert.equal(unrealizedPnl(E18, usd(60_000), usd(59_000)), -usd(1_000));
  assert.equal(unrealizedPnl(-E18, -usd(60_000), usd(59_000)), usd(1_000));
  assert.equal(unrealizedPnl(-E18, -usd(60_000), usd(61_000)), -usd(1_000));
  assert.equal(unrealizedPnl(0n, 0n, usd(1)), 0n);
});

test("margin is the notional's bps", () => {
  assert.equal(marginAt(E18, usd(60_000), 100), usd(600));
  assert.equal(marginAt(-E18, usd(60_000), 250), usd(1_500));
});

test("applyFill: open, add, reduce, close and flip (Engine._applyFill)", () => {
  const flat = { size: 0n, openNotional: 0n };
  const long = applyFill(flat, E18, usd(60_000));
  assert.deepEqual(long, { size: E18, openNotional: usd(60_000), realized: 0n, increased: true });

  const added = applyFill(long, E18, usd(62_000));
  assert.deepEqual(added, { size: 2n * E18, openNotional: usd(122_000), realized: 0n, increased: true });

  // Close half at 64,000: basis removed pro rata (61,000), realized 3,000.
  const half = applyFill(added, -E18, usd(64_000));
  assert.deepEqual(half, { size: E18, openNotional: usd(61_000), realized: usd(3_000), increased: false });

  // Close the rest at a loss.
  const closed = applyFill(half, -E18, usd(60_000));
  assert.deepEqual(closed, { size: 0n, openNotional: 0n, realized: -usd(1_000), increased: false });

  // Flip: sell 3 against a 1 long at 65,000 → close 1 (+5,000), open 2 short.
  const flipped = applyFill(long, -3n * E18, usd(65_000));
  assert.deepEqual(flipped, { size: -2n * E18, openNotional: -usd(130_000), realized: usd(5_000), increased: true });

  // A short gains when price falls.
  const shortClose = applyFill({ size: -E18, openNotional: -usd(60_000) }, E18, usd(55_000));
  assert.deepEqual(shortClose, { size: 0n, openNotional: 0n, realized: usd(5_000), increased: false });
});

test("applyFill keeps the two notional pieces summing to the fill notional", () => {
  // An odd price where closeQty × price and the residual truncate separately.
  const price = usd(60_000) + 7n;
  const flipped = applyFill({ size: 3n, openNotional: 1n }, -10n * E18, price);
  const fill = notional(10n * E18, price);
  const closeNotional = notional(3n, price);
  assert.equal(-flipped.openNotional, fill - closeNotional, "the residual gets exactly what is left");
});

test("liquidation price: a single long and short, BTC-like 1% maintenance", () => {
  // 1 BTC long at 60,000 with $6,000 equity: E + (P − 60,000) = 0.01 × P
  // → P = 54,000 / 0.99 = 54,545.45…
  const long = liquidationPrice({ size: E18, equity: usd(6_000), price: usd(60_000), maintenanceMarginBps: 100 });
  assert.equal(long, (usd(54_000) * 10_000n) / 9_900n);

  // The mirror short: E − (P − 60,000) = 0.01 × P → P = 66,000 / 1.01
  const short = liquidationPrice({ size: -E18, equity: usd(6_000), price: usd(60_000), maintenanceMarginBps: 100 });
  assert.equal(short, (usd(66_000) * 10_000n) / 10_100n);
});

test("liquidation price: at that price equity equals maintenance", () => {
  const size = 3n * E18;
  const equity = usd(1_234);
  const price = usd(3_000);
  const bps = 250;
  const p = liquidationPrice({ size, equity, price, maintenanceMarginBps: bps })!;
  const equityAtP = equity + unrealizedPnl(size, notional(size, price), p);
  const maintenanceAtP = marginAt(size, p, bps);
  assert.ok(abs(equityAtP - maintenanceAtP) < usd(1) / 1000n, "within a tenth of a cent");
});

test("liquidation price: none, already liquidatable, and other positions", () => {
  // Fully collateralised long: no positive price liquidates it.
  assert.equal(liquidationPrice({ size: E18, equity: usd(60_000), price: usd(60_000), maintenanceMarginBps: 100 }), null);
  assert.equal(liquidationPrice({ size: 0n, equity: usd(1), price: usd(1), maintenanceMarginBps: 100 }), null);
  // Equity below maintenance now: the price is above the current one for a long.
  const under = liquidationPrice({ size: E18, equity: usd(100), price: usd(60_000), maintenanceMarginBps: 100 })!;
  assert.ok(under > usd(60_000));
  // Other positions' maintenance moves a long's liquidation price up.
  const alone = liquidationPrice({ size: E18, equity: usd(6_000), price: usd(60_000), maintenanceMarginBps: 100 })!;
  const withOther = liquidationPrice({
    size: E18, equity: usd(6_000), price: usd(60_000), maintenanceMarginBps: 100, otherMaintenance: usd(1_000),
  })!;
  assert.ok(withOther > alone);
});

const abs = (x: bigint) => (x < 0n ? -x : x);
