// Batch building, fill-id determinism, chunking and gas sizing. No database,
// no network: the Query and the gas estimator are fakes.
// Run: npm test

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";

import { MAX_FILLS_PER_BATCH } from "@/lib/chain/settlement";
import { PRECISION, type EngineMatch, type EngineOrder } from "@/lib/market/matching-engine";
import {
  MAX_BATCH_GAS,
  MIN_GAS_PER_FILL,
  MissingOrderError,
  buildFills,
  deriveFillId,
  halveAfterGasRevert,
  sizeBatches,
  withHeadroom,
  type PlannedFill,
} from "./batch";
import type { Query, Row } from "./db";

const E18 = PRECISION;
const NETWORK = "arc-local";
const ALICE = getAddress("0xaaaa00000000000000000000000000000000aaaa");
const BOB = getAddress("0xbbbb00000000000000000000000000000000bbbb");

const hash = (label: string) => keccak256(toHex(label));

interface OrderFixture {
  orderHash: Hex;
  owner: Address;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  nonce: bigint;
}

function fixture(label: string, owner: Address, isLong: boolean, price: bigint, nonce: bigint): OrderFixture {
  return { orderHash: hash(label), owner, isLong, size: 10n * E18, limitPrice: price, nonce };
}

/**
 * A Query that answers only the two statements `buildFills` issues, matched on
 * the table they read. Anything else is a test that has drifted from the code.
 */
function fakeQuery(orders: OrderFixture[], priorFills: Row[] = []): Query {
  return {
    async query<T extends Row = Row>(text: string): Promise<T[]> {
      if (text.includes('FROM "Order"')) {
        return orders.map((o) => ({
          orderHash: o.orderHash,
          owner: o.owner.toLowerCase(),
          marketId: 2,
          isLong: o.isLong,
          size: o.size.toString(),
          limitPrice: o.limitPrice.toString(),
          reduceOnly: false,
          nonce: o.nonce.toString(),
          expiry: "1800003600",
          referrer: null,
          signature: `0x${"11".repeat(65)}`,
        })) as unknown as T[];
      }
      if (text.includes('FROM "Fill"')) return priorFills as unknown as T[];
      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    },
  };
}

function match(maker: OrderFixture, taker: OrderFixture, size: bigint, sequence = 0): EngineMatch {
  const as = (o: OrderFixture): EngineOrder => ({
    orderHash: o.orderHash,
    owner: o.owner.toLowerCase() as Address,
    marketId: 2,
    isLong: o.isLong,
    size: o.size,
    limitPrice: o.limitPrice,
    reduceOnly: false,
    nonce: o.nonce,
    expiry: 1_800_003_600n,
    filledSize: 0n,
    createdAt: 1,
  });
  return {
    maker: as(maker),
    taker: as(taker),
    size,
    price: maker.limitPrice,
    notional: (size * maker.limitPrice) / E18,
    sequence,
  };
}

describe("deriveFillId", () => {
  const a = hash("maker");
  const b = hash("taker");

  test("is a 32-byte value", () => {
    const id = deriveFillId(a, b, E18, 100n * E18, 0n);
    assert.match(id, /^0x[0-9a-f]{64}$/);
  });

  test("is stable for the same inputs", () => {
    assert.equal(deriveFillId(a, b, E18, 100n * E18, 0n), deriveFillId(a, b, E18, 100n * E18, 0n));
  });

  test("changes with every field", () => {
    const base = deriveFillId(a, b, E18, 100n * E18, 0n);
    assert.notEqual(deriveFillId(b, a, E18, 100n * E18, 0n), base, "maker/taker order matters");
    assert.notEqual(deriveFillId(a, b, 2n * E18, 100n * E18, 0n), base, "size matters");
    assert.notEqual(deriveFillId(a, b, E18, 101n * E18, 0n), base, "price matters");
    assert.notEqual(deriveFillId(a, b, E18, 100n * E18, 1n), base, "sequence matters");
  });
});

describe("buildFills", () => {
  const ask = fixture("ask", ALICE, false, 100n * E18, 1n);
  const bid = fixture("bid", BOB, true, 100n * E18, 2n);

  test("attaches both signed orders and the derived id", async () => {
    const q = fakeQuery([ask, bid]);
    const [fill] = await buildFills(q, NETWORK, [match(ask, bid, E18)]);

    assert.equal(fill.fillId, deriveFillId(ask.orderHash, bid.orderHash, E18, 100n * E18, 0n));
    assert.equal(fill.maker.owner, ALICE);
    assert.equal(fill.taker.owner, BOB);
    assert.equal(fill.maker.nonce, 1n);
    assert.equal(fill.takerIsBuy, true);
    assert.equal(fill.notional, 100n * E18);
    assert.equal(fill.makerSignature, `0x${"11".repeat(65)}`);
  });

  test("rebuilding the same matches produces the same ids", async () => {
    const q = fakeQuery([ask, bid]);
    const matches = [match(ask, bid, E18)];
    const first = await buildFills(q, NETWORK, matches);
    const second = await buildFills(q, NETWORK, matches);
    assert.deepEqual(second.map((f) => f.fillId), first.map((f) => f.fillId));
  });

  test("an existing Fill row for the same shape advances the sequence", async () => {
    // What happens when a rejected fill is re-matched: the old row still holds
    // the old id under the unique key, so the new fill must get a new one.
    const prior = [
      {
        makerOrderHash: ask.orderHash,
        takerOrderHash: bid.orderHash,
        size: E18.toString(),
        price: (100n * E18).toString(),
        n: 1,
      },
    ];
    const [fill] = await buildFills(fakeQuery([ask, bid], prior), NETWORK, [match(ask, bid, E18)]);
    assert.equal(fill.fillId, deriveFillId(ask.orderHash, bid.orderHash, E18, 100n * E18, 1n));
  });

  test("two matches of the same shape in one tick get different ids", async () => {
    const q = fakeQuery([ask, bid]);
    const fills = await buildFills(q, NETWORK, [match(ask, bid, E18, 0), match(ask, bid, E18, 1)]);
    assert.equal(fills.length, 2);
    assert.notEqual(fills[0].fillId, fills[1].fillId);
  });

  test("a repeated match is deduplicated rather than failing the tick", async () => {
    const q = fakeQuery([ask, bid]);
    const same = match(ask, bid, E18);
    const fills = await buildFills(q, NETWORK, [same, same]);
    assert.equal(fills.length, 1);
  });

  test("a match whose order is missing is an error, not a silent drop", async () => {
    const q = fakeQuery([ask]);
    await assert.rejects(() => buildFills(q, NETWORK, [match(ask, bid, E18)]), MissingOrderError);
  });

  test("no matches means no queries and no fills", async () => {
    const q: Query = {
      async query() {
        throw new Error("should not query");
      },
    };
    assert.deepEqual(await buildFills(q, NETWORK, []), []);
  });
});

describe("sizeBatches", () => {
  const plan = (n: number): PlannedFill[] =>
    Array.from({ length: n }, (_, i) => ({
      fillId: hash(`fill-${i}`),
      maker: {
        owner: ALICE,
        marketId: 2,
        isLong: false,
        size: 10n * E18,
        limitPrice: 100n * E18,
        reduceOnly: false,
        nonce: BigInt(i * 2),
        expiry: 1_800_003_600n,
        referrer: "0x0000000000000000000000000000000000000000" as Address,
      },
      makerSignature: `0x${"11".repeat(65)}`,
      taker: {
        owner: BOB,
        marketId: 2,
        isLong: true,
        size: 10n * E18,
        limitPrice: 100n * E18,
        reduceOnly: false,
        nonce: BigInt(i * 2 + 1),
        expiry: 1_800_003_600n,
        referrer: "0x0000000000000000000000000000000000000000" as Address,
      },
      takerSignature: `0x${"22".repeat(65)}`,
      size: E18,
      price: 100n * E18,
      marketId: 2,
      makerOrderHash: hash(`maker-${i}`),
      takerOrderHash: hash(`taker-${i}`),
      takerIsBuy: true,
      notional: 100n * E18,
    }));

  /** 380k per fill, the figure the gas pass recorded for an opening fill. */
  const perFill = (gas: bigint) => async (fills: readonly PlannedFill[]) => BigInt(fills.length) * gas;

  test("splits at the 40-fill cap", async () => {
    const batches = await sizeBatches(plan(95), perFill(380_000n));
    assert.deepEqual(batches.map((b) => b.fills.length), [MAX_FILLS_PER_BATCH, MAX_FILLS_PER_BATCH, 15]);
  });

  test("a batch inside the cap and the gas budget is not split", async () => {
    const batches = await sizeBatches(plan(40), perFill(380_000n));
    assert.equal(batches.length, 1);
    assert.equal(batches[0].estimate, 40n * 380_000n);
    assert.equal(batches[0].gas, (40n * 380_000n * 120n) / 100n);
  });

  test("halves a batch whose estimate exceeds the gas budget", async () => {
    // 900k per fill × 40 = 36M, twice the 18M budget.
    const batches = await sizeBatches(plan(40), perFill(900_000n));
    assert.ok(batches.length > 1, "expected a split");
    for (const b of batches) {
      assert.ok(b.estimate <= MAX_BATCH_GAS, `batch of ${b.fills.length} still over budget at ${b.estimate}`);
    }
    assert.equal(batches.reduce((n, b) => n + b.fills.length, 0), 40, "no fill is lost in the split");
  });

  test("the split preserves order", async () => {
    const fills = plan(40);
    const batches = await sizeBatches(fills, perFill(900_000n));
    const flat = batches.flatMap((b) => b.fills.map((f) => f.fillId));
    assert.deepEqual(flat, fills.map((f) => f.fillId));
  });

  test("a single fill over the budget is still returned, not dropped", async () => {
    const batches = await sizeBatches(plan(1), perFill(MAX_BATCH_GAS * 2n));
    assert.equal(batches.length, 1);
    assert.equal(batches[0].fills.length, 1);
    assert.ok(batches[0].estimate > MAX_BATCH_GAS, "the chain gets to give the real answer");
  });

  test("a full 40-fill batch at the measured 380k per fill is not split", async () => {
    // The batch cap exists because 40 fills measured ~15.2M. If the gas budget
    // split that batch, the cap would be a lie and every tick would pay for
    // two transactions instead of one.
    const batches = await sizeBatches(plan(40), perFill(380_000n));
    assert.equal(batches.length, 1);
    assert.equal(batches[0].estimate, 15_200_000n);
  });

  test("the resize floor stops the halving", async () => {
    const batches = await sizeBatches(plan(8), perFill(MAX_BATCH_GAS), { minBatchFills: 4 });
    for (const b of batches) assert.ok(b.fills.length >= 4);
  });

  test("nothing in, nothing out", async () => {
    assert.deepEqual(await sizeBatches([], perFill(380_000n)), []);
  });
});

describe("withHeadroom", () => {
  test("adds the requested percentage", () => {
    assert.equal(withHeadroom(10_000_000n, 120n), 12_000_000n);
  });

  test("never returns less than one fill's floor", () => {
    assert.equal(withHeadroom(1_000n, 120n), MIN_GAS_PER_FILL);
  });
});

describe("halveAfterGasRevert", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i);

  test("splits a batch in two, losing nothing", () => {
    const halves = halveAfterGasRevert(ids(40));
    assert.deepEqual(halves.map((h) => h.length), [20, 20]);
    assert.deepEqual(halves.flat(), ids(40));
  });

  test("an odd batch puts the extra fill in the first half", () => {
    assert.deepEqual(halveAfterGasRevert(ids(7)).map((h) => h.length), [4, 3]);
  });

  test("a single fill has nothing left to split, so it gives up", () => {
    // Retrying the same one-fill batch would revert identically, forever.
    assert.deepEqual(halveAfterGasRevert(ids(1)), []);
  });

  test("the floor stops the halving before it reaches one", () => {
    assert.deepEqual(halveAfterGasRevert(ids(4), 4), []);
    assert.deepEqual(halveAfterGasRevert(ids(5), 4).map((h) => h.length), [3, 2]);
  });

  test("an empty batch gives up", () => {
    assert.deepEqual(halveAfterGasRevert([]), []);
  });
});
