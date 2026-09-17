// The execution band: the same arithmetic `Engine.applyFill` does, and the
// oracle read that decides whether a market can trade this tick. No network:
// the readContract client is a fake.
// Run: npm test

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { type Address } from "viem";

import { PRECISION, type EngineMatch, type EngineOrder } from "@/lib/market/matching-engine";
import { OracleUnavailableError, bandFor, filterByBand, readIndexPrice, withinBand } from "./band";
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
