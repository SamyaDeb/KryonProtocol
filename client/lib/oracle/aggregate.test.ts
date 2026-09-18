import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { aggregate, deviationBps, median } from "./aggregate";
import type { SourceQuote } from "./sources";

const E18 = 10n ** 18n;
const q = (source: string, usd: number, ts = 1_000): SourceQuote => ({
  source,
  symbol: "BTC",
  price: BigInt(Math.round(usd * 1e6)) * 10n ** 12n,
  ts,
});
const OPTS = { minSources: 2, maxSourceDeviationBps: 50n };

describe("median", () => {
  test("odd count takes the middle", () => {
    assert.equal(median([3n, 1n, 2n]), 2n);
  });
  test("even count averages the middle two, rounding down", () => {
    assert.equal(median([1n, 2n, 4n, 10n]), 3n);
    assert.equal(median([1n, 2n]), 1n);
  });
  test("does not mutate its input", () => {
    const v = [3n, 1n, 2n];
    median(v);
    assert.deepEqual(v, [3n, 1n, 2n]);
  });
  test("refuses an empty set", () => {
    assert.throws(() => median([]));
  });
});

describe("aggregate", () => {
  test("three agreeing sources: median, confidence is the widest distance", () => {
    const r = aggregate("BTC", [q("a", 100_000), q("b", 100_010), q("c", 99_990)], OPTS);
    assert.ok(r.ok);
    assert.equal(r.value.price, 100_000n * E18);
    assert.equal(r.value.confidence, 10n * E18);
    assert.deepEqual(r.value.used, ["a", "b", "c"]);
    assert.equal(r.value.dropped.length, 0);
  });

  test("an outlier is dropped and the median recomputed over the rest", () => {
    const r = aggregate("BTC", [q("a", 100_000), q("b", 100_020), q("bad", 103_000)], OPTS);
    assert.ok(r.ok);
    assert.deepEqual(r.value.used, ["a", "b"]);
    assert.equal(r.value.dropped[0].source, "bad");
    assert.equal(r.value.price, 100_010n * E18);
    assert.equal(r.value.confidence, 10n * E18);
  });

  test("never publishes from a single source, even if configured lower", () => {
    const r = aggregate("BTC", [q("a", 100_000)], { ...OPTS, minSources: 1 });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.kind, "insufficient-sources");
  });

  test("two sources that disagree beyond the bound are a disagreement, not a price", () => {
    const r = aggregate("BTC", [q("a", 100_000), q("b", 101_500)], OPTS);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.kind, "disagreement");
  });

  test("an outlier that leaves only one survivor fails closed", () => {
    const r = aggregate("BTC", [q("a", 100_000), q("b", 100_000 * 1.02), q("c", 100_000 * 0.97)], OPTS);
    assert.equal(r.ok, false);
  });

  test("oldestTs is the oldest quote actually used", () => {
    const r = aggregate("BTC", [q("a", 100_000, 500), q("b", 100_001, 900), q("bad", 90_000, 100)], OPTS);
    assert.ok(r.ok);
    assert.equal(r.value.oldestTs, 500);
  });
});

describe("deviationBps", () => {
  test("is symmetric in direction, relative to the reference", () => {
    assert.equal(deviationBps(101n, 100n), 100n);
    assert.equal(deviationBps(99n, 100n), 100n);
  });
});
