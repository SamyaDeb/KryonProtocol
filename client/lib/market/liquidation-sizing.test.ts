// A liquidator that closes more than it needs to is taking value from the
// trader it is liquidating. These pin the ordering and the sizing so that
// cannot silently regress back to "full close first".

import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSizeLadder } from "./liquidation-sizing";

const PRICE = 10n ** 18n;
const AMT = 10n ** 7n;

// 800 units at price 1.00 -> notional 800.
const position = { size: 800n * AMT };
const price = PRICE;

test("a barely-underwater account is offered a small close first", () => {
  // Equity 79, maintenance 80 -> shortfall 1 on an 800 notional.
  // min = 800 * 1 / 800 = 1 unit, +25% safety = 1.25.
  const ladder = closeSizeLadder(position, price, {
    equity: 79n * AMT,
    maintenance_margin_required: 80n * AMT,
  });

  assert.equal(ladder[0], (1n * AMT * 125n) / 100n, "first attempt is the minimum needed");
  assert.ok(
    ladder[0] < position.size / 10n,
    "a 1-in-800 shortfall must not propose closing a tenth of the position"
  );
});

test("the ladder only ever escalates", () => {
  const ladder = closeSizeLadder(position, price, {
    equity: 40n * AMT,
    maintenance_margin_required: 80n * AMT,
  });
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ladder[i] > ladder[i - 1], `ladder must ascend: ${ladder.join(", ")}`);
  }
  assert.equal(ladder.at(-1), position.size, "a full close remains the last resort");
});

test("a deeply underwater account goes straight to a full close", () => {
  // Shortfall exceeds the whole notional, so the computed minimum is >= size
  // and is dropped as a distinct rung.
  const ladder = closeSizeLadder(position, price, {
    equity: -900n * AMT,
    maintenance_margin_required: 80n * AMT,
  });
  assert.equal(ladder.at(-1), position.size);
  assert.ok(
    ladder.every((c) => c <= position.size),
    "never proposes closing more than the position holds"
  );
});

test("an account that is not short of margin still gets plain escalations", () => {
  const ladder = closeSizeLadder(position, price, {
    equity: 200n * AMT,
    maintenance_margin_required: 80n * AMT,
  });
  assert.deepEqual(ladder, [position.size / 2n, position.size]);
});

test("a zero or missing price does not invent a minimum", () => {
  const ladder = closeSizeLadder(position, 0n, {
    equity: 40n * AMT,
    maintenance_margin_required: 80n * AMT,
  });
  assert.deepEqual(ladder, [position.size / 2n, position.size]);
});

test("an empty position proposes nothing", () => {
  assert.deepEqual(closeSizeLadder({ size: 0n }, price, { equity: 0n, maintenance_margin_required: 1n }), []);
});
