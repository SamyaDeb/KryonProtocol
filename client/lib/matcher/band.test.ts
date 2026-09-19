// The execution band: the same arithmetic `Engine.applyFill` does, and the
// oracle read that decides whether a market can trade this tick. No network:
// the readContract client is a fake.
// Run: npm test

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { type Address } from "viem";

import { PRECISION, type EngineMatch, type EngineOrder } from "@/lib/market/matching-engine";
import {
  OracleUnavailableError,
  bandFor,
  filterBackstopFills,
  filterByBand,
  isBackstopMatch,
  readIndexPrice,
  withinBand,
} from "./band";
import type { MarketConfig } from "./book";

const E18 = PRECISION;
const ADAPTER = "0x00000000000000000000000000000000000000a4" as Address;

const MARKET: MarketConfig = {
  marketId: 2,
  symbol: "BTC-PERP",
  oracleId: `0x${"42544300".padEnd(64, "0")}`,
  active: true,
  minFillNotional: 40n * E18,
  // arc-local BTC-PERP: 75 bps.
  maxExecutionDeviationBps: 75,
  maxOracleAge: 15,
  maxOracleConfidenceBps: 100,
};

function fakeOracle(snap: unknown | Error) {
  return {
    async readContract() {
      if (snap instanceof Error) throw snap;
      return snap;
    },
  } as never;
}

describe("bandFor", () => {
  test("is ± bps of the index", () => {
    const band = bandFor(100_000n * E18, 75);
    assert.equal(band.index, 100_000n * E18);
    assert.equal(band.low, 99_250n * E18);
    assert.equal(band.high, 100_750n * E18);
  });

  test("the edges are inclusive, as the contract's comparison is", () => {
    // Engine reverts on `price < low || price > high`, so both edges settle.
    const band = bandFor(100_000n * E18, 75);
    assert.ok(withinBand(band.low, band));
    assert.ok(withinBand(band.high, band));
    assert.ok(!withinBand(band.low - 1n, band));
    assert.ok(!withinBand(band.high + 1n, band));
  });

  test("a zero index collapses the band rather than widening it", () => {
    const band = bandFor(0n, 75);
    assert.equal(band.low, 0n);
    assert.equal(band.high, 0n);
  });
});

describe("readIndexPrice", () => {
  test("returns the snapshot the Engine would read", async () => {
    const client = fakeOracle({
      price: 100_000n * E18,
      confidence: 5n * E18,
      publishTime: 1_800_000_000n,
      writeTime: 1_800_000_001n,
      source: 1,
      sourceCount: 3,
    });
    const index = await readIndexPrice(client, ADAPTER, MARKET);
    assert.equal(index.price, 100_000n * E18);
    assert.equal(index.sourceCount, 3);
  });

  test("a reverting adapter is an OracleUnavailableError, not a crash", async () => {
    // What a stale or too-wide feed does: `getPrice` reverts, and every fill
    // this tick would have reverted with it.
    const client = fakeOracle(new Error("execution reverted: StalePrice"));
    await assert.rejects(() => readIndexPrice(client, ADAPTER, MARKET), OracleUnavailableError);
  });

  test("a zero price is treated as no price", async () => {
    const client = fakeOracle({
      price: 0n,
      confidence: 0n,
      publishTime: 0n,
      writeTime: 0n,
      source: 0,
      sourceCount: 0,
    });
    await assert.rejects(() => readIndexPrice(client, ADAPTER, MARKET), OracleUnavailableError);
  });
});

describe("filterByBand", () => {
  const order = (price: bigint): EngineOrder => ({
    orderHash: `0x${"1".repeat(64)}`,
    owner: "0xaaaa00000000000000000000000000000000aaaa" as Address,
    marketId: 2,
    isLong: false,
    size: E18,
    limitPrice: price,
    reduceOnly: false,
    nonce: 1n,
    expiry: 1_800_003_600n,
    filledSize: 0n,
    createdAt: 1,
  });
  const at = (price: bigint): EngineMatch => ({
    maker: order(price),
    taker: order(price),
    size: E18,
    price,
    notional: price,
    sequence: 0,
  });

  test("keeps what the Engine would accept and drops what it would revert", () => {
    const index = 100_000n * E18;
    const { kept, dropped } = filterByBand(
      [at(100_000n * E18), at(100_700n * E18), at(101_000n * E18), at(98_000n * E18)],
      index,
      75
    );
    assert.deepEqual(kept.map((m) => m.price), [100_000n * E18, 100_700n * E18]);
    assert.deepEqual(dropped.map((m) => m.price), [101_000n * E18, 98_000n * E18]);
  });

  test("no matches means nothing kept and nothing dropped", () => {
    const { kept, dropped } = filterByBand([], 100_000n * E18, 75);
    assert.deepEqual(kept, []);
    assert.deepEqual(dropped, []);
  });
});

describe("the backstop's own band and caps", () => {
  const BACKSTOP = "0x00000000000000000000000000000000000000aa" as Address;
  const TRADER = "0x00000000000000000000000000000000000000bb" as Address;
  const INDEX = 100_000n * E18;

  const order = (owner: Address, price: bigint): EngineOrder => ({
    orderHash: `0x${"2".repeat(64)}`,
    owner,
    marketId: 2,
    isLong: false,
    size: E18,
    limitPrice: price,
    reduceOnly: true,
    nonce: 1n,
    expiry: 1_800_003_600n,
    filledSize: 0n,
    createdAt: 1,
  });
  /** A match at `price` for `size`, with the backstop as maker unless told otherwise. */
  const at = (price: bigint, size = E18, makerOwner: Address = BACKSTOP): EngineMatch => ({
    maker: order(makerOwner, price),
    taker: order(TRADER, price),
    size,
    price,
    notional: (size * price) / E18,
    sequence: 0,
  });
  // 1%, $10,000 per fill, $25,000 left today.
  const limits = { maxDeviationBps: 100n, maxFillNotional: 10_000n * E18, dailyRemaining: 25_000n * E18 };

  test("a fill the market band allows but Insurance would reject is dropped", () => {
    // The market band is 75 bps here; the unwind band is 100 bps of a much
    // tighter kind — the point is that the matcher no longer offers a fill
    // that onBackstopFill would revert.
    const { kept, dropped } = filterBackstopFills([at(100_500n * E18, E18 / 20n), at(101_500n * E18, E18 / 20n)], {
      backstop: BACKSTOP,
      index: INDEX,
      limits,
    });
    assert.deepEqual(kept.map((m) => m.price), [100_500n * E18]);
    assert.deepEqual(dropped.map((d) => d.reason), ["outside-unwind-band"]);
  });

  test("orders that are not the backstop's pass through untouched", () => {
    const outside = at(101_500n * E18, E18, TRADER);
    const { kept, dropped } = filterBackstopFills([outside], { backstop: BACKSTOP, index: INDEX, limits });
    assert.deepEqual(kept, [outside]);
    assert.deepEqual(dropped, []);
    assert.equal(isBackstopMatch(outside, BACKSTOP), false);
  });

  test("the backstop as taker counts too", () => {
    const m: EngineMatch = { ...at(101_500n * E18), maker: order(TRADER, 101_500n * E18), taker: order(BACKSTOP, 101_500n * E18) };
    assert.equal(isBackstopMatch(m, BACKSTOP), true);
    assert.equal(filterBackstopFills([m], { backstop: BACKSTOP, index: INDEX, limits }).dropped[0].reason, "outside-unwind-band");
  });

  test("a fill over the per-fill cap is dropped", () => {
    const { kept, dropped } = filterBackstopFills([at(INDEX, 2n * E18)], { backstop: BACKSTOP, index: INDEX, limits });
    assert.deepEqual(kept, []);
    assert.deepEqual(dropped.map((d) => d.reason), ["over-fill-cap"]);
  });

  test("the daily cap is counted across the batch, in the order offered", () => {
    // Three $10,000 fills against $25,000 left: the third would revert.
    const ten = () => at(INDEX, E18 / 10n);
    const { kept, dropped } = filterBackstopFills([ten(), ten(), ten()], { backstop: BACKSTOP, index: INDEX, limits });
    assert.equal(kept.length, 2);
    assert.deepEqual(dropped.map((d) => d.reason), ["over-daily-cap"]);
  });

  test("unwinding disabled drops every backstop fill", () => {
    const { kept, dropped } = filterBackstopFills([at(INDEX, E18 / 10n)], {
      backstop: BACKSTOP,
      index: INDEX,
      limits: { ...limits, maxDeviationBps: 0n },
    });
    assert.deepEqual(kept, []);
    assert.deepEqual(dropped.map((d) => d.reason), ["unwind-disabled"]);
  });
});
