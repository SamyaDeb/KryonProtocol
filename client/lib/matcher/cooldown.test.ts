// The rule this enforces: an order the chain has just refused is not offered
// again on the very next tick. Without it the matcher re-offers the same fill
// every second and pays gas for every rejection — 52 of 56 batches on the live
// testnet venue, from two accounts that simply could not afford the trade.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";

import { RejectionCooldown } from "./cooldown";

const order = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const OPTS = { baseMs: 2_000, maxMs: 60_000, parkAfter: 5, forgetAfterMs: 300_000 };

test("a refused order is held, and released when its wait is over", () => {
  const c = new RejectionCooldown(OPTS);
  c.strike(order(1), "InsufficientCollateral", 1_000);
  assert.equal(c.blocked(order(1), 1_000), true);
  assert.equal(c.blocked(order(1), 2_999), true, "still waiting");
  assert.equal(c.blocked(order(1), 3_001), false, "2s later it may try again");
  assert.equal(c.blocked(order(2), 1_000), false, "another order is unaffected");
});

test("each further refusal doubles the wait, up to a ceiling", () => {
  const c = new RejectionCooldown(OPTS);
  const waits: number[] = [];
  for (let i = 0; i < 8; i++) waits.push(c.strike(order(1), "InsufficientCollateral", 0).until);
  assert.deepEqual(waits.slice(0, 5), [2_000, 4_000, 8_000, 16_000, 32_000]);
  assert.deepEqual(waits.slice(5), [60_000, 60_000, 60_000], "capped, not unbounded");
});

test("an order that keeps failing is parked", () => {
  const c = new RejectionCooldown(OPTS);
  for (let i = 1; i < OPTS.parkAfter; i++) {
    assert.equal(c.strike(order(1), "InsufficientCollateral", 0).parked, false, `strike ${i}`);
  }
  const last = c.strike(order(1), "InsufficientCollateral", 0);
  assert.equal(last.parked, true);
  assert.equal(last.strikes, OPTS.parkAfter);
  // Still time-limited: funding the account frees the order without a restart.
  assert.equal(c.blocked(order(1), 60_001), false);
});

test("a fill that settles clears the order's record", () => {
  const c = new RejectionCooldown(OPTS);
  c.strike(order(1), "InsufficientCollateral", 0);
  c.strike(order(1), "InsufficientCollateral", 0);
  c.clear(order(1));
  assert.equal(c.blocked(order(1), 0), false);
  assert.equal(c.strike(order(1), "InsufficientCollateral", 0).until, 2_000, "back to the first step");
});

test("an order keeps its strikes after its wait is served", () => {
  // Otherwise an order that fails, waits it out, and fails again gets the
  // same two seconds forever — no escalation, and the storm just runs slower.
  const c = new RejectionCooldown(OPTS);
  c.strike(order(1), "InsufficientCollateral", 0);
  c.sweep(10_000); // wait long served
  assert.equal(c.blocked(order(1), 10_000), false, "free to try again");
  assert.equal(c.strike(order(1), "InsufficientCollateral", 10_000).until, 14_000, "4s, not 2s");
});

test("records are forgotten eventually, so the map cannot grow forever", () => {
  const c = new RejectionCooldown(OPTS);
  const { until } = c.strike(order(1), "InsufficientCollateral", 0);
  c.sweep(until + OPTS.forgetAfterMs);
  assert.ok(c.stateOf(order(1)), "still remembered right up to the window's end");
  c.sweep(until + OPTS.forgetAfterMs + 1);
  assert.equal(c.stateOf(order(1)), undefined);
});

test("the hash is matched however it is cased", () => {
  const c = new RejectionCooldown(OPTS);
  c.strike(order(0xabc).toUpperCase().replace("0X", "0x") as Hex, "InsufficientCollateral", 0);
  assert.equal(c.blocked(order(0xabc), 0), true);
});

test("counting what is held right now", () => {
  const c = new RejectionCooldown(OPTS);
  c.strike(order(1), "x", 0);
  c.strike(order(2), "x", 0);
  assert.equal(c.blockedCount(0), 2);
  assert.equal(c.blockedCount(3_000), 0, "both waits served");
});
