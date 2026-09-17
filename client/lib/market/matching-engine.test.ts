// The pure matching engine (plan §4.1). No database, no network, no clock.
// Run: npm test

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, type Address, type Hex } from "viem";

import {
  MAX_ORDER_TTL_SECONDS,
  PRECISION,
  matchOrders,
  notionalOf,
  type EngineInput,
  type EngineOrder,
} from "./matching-engine";

const E18 = PRECISION;
const NOW = 1_800_000_000n;
const MARKET = 2;
/** arc-local BTC-PERP: min_fill_notional_usd = 40. */
const MIN_NOTIONAL = 40n * E18;

const ALICE = "0xaaaa00000000000000000000000000000000aaaa" as Address;
const BOB = "0xbbbb00000000000000000000000000000000bbbb" as Address;
const CAROL = "0xcccc00000000000000000000000000000000cccc" as Address;

let seq = 0;
function order(o: Partial<EngineOrder> & Pick<EngineOrder, "owner" | "isLong" | "limitPrice">): EngineOrder {
  seq += 1;
  return {
    orderHash: (o.orderHash ?? keccak256(toHex(`order-${seq}`))) as Hex,
    marketId: MARKET,
    size: 1n * E18,
    reduceOnly: false,
    nonce: BigInt(seq),
    expiry: NOW + 3600n,
    filledSize: 0n,
    createdAt: 1_000 + seq,
    ...o,
  };
}

function run(orders: EngineOrder[], overrides: Partial<EngineInput> = {}) {
  return matchOrders({
    marketId: MARKET,
    nowSec: NOW,
    orders,
    positions: new Map(),
    minValidNonce: new Map(),
    minFillNotional: MIN_NOTIONAL,
    ...overrides,
  });
}

describe("crossing", () => {
  test("a bid at the ask crosses and fills at the maker's price", () => {
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, createdAt: 1 });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18, createdAt: 2 });
    const { matches } = run([ask, bid]);

    assert.equal(matches.length, 1);
    assert.equal(matches[0].maker.orderHash, ask.orderHash);
    assert.equal(matches[0].taker.orderHash, bid.orderHash);
    assert.equal(matches[0].price, 100n * E18);
    assert.equal(matches[0].size, 1n * E18);
    assert.equal(matches[0].notional, 100n * E18);
  });

  test("a bid above the ask executes at the resting ask, not the bid", () => {
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, createdAt: 1 });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 105n * E18, createdAt: 2 });
    const { matches } = run([ask, bid]);
    assert.equal(matches[0].price, 100n * E18);
  });

  test("a resting bid crossed by a later ask executes at the bid", () => {
    const bid = order({ owner: ALICE, isLong: true, limitPrice: 105n * E18, createdAt: 1 });
    const ask = order({ owner: BOB, isLong: false, limitPrice: 100n * E18, createdAt: 2 });
    const { matches } = run([bid, ask]);
    assert.equal(matches[0].maker.orderHash, bid.orderHash);
    assert.equal(matches[0].price, 105n * E18);
  });

  test("a book that does not cross produces nothing", () => {
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 101n * E18 });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18 });
    assert.deepEqual(run([ask, bid]).matches, []);
  });

  test("an empty book produces nothing", () => {
    assert.deepEqual(run([]).matches, []);
  });

  test("one side only produces nothing", () => {
    const bids = [1, 2, 3].map((i) => order({ owner: ALICE, isLong: true, limitPrice: BigInt(100 + i) * E18 }));
    assert.deepEqual(run(bids).matches, []);
  });
});

describe("sizing", () => {
  test("an exact fill consumes both orders", () => {
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, size: 2n * E18, createdAt: 1 });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18, size: 2n * E18, createdAt: 2 });
    const { matches } = run([ask, bid]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].size, 2n * E18);
  });

  test("a partial fill leaves the larger order's remainder resting", () => {
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, size: 5n * E18, createdAt: 1 });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18, size: 2n * E18, createdAt: 2 });
    const { matches } = run([ask, bid]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].size, 2n * E18);
  });

  test("an order already partly filled only offers what is left", () => {
    const ask = order({
      owner: ALICE,
      isLong: false,
      limitPrice: 100n * E18,
      size: 5n * E18,
      filledSize: 3n * E18,
      createdAt: 1,
    });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18, size: 5n * E18, createdAt: 2 });
    const { matches } = run([ask, bid]);
    assert.equal(matches[0].size, 2n * E18);
  });

  test("one taker sweeps several makers, best price first", () => {
    const cheap = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, size: 1n * E18, createdAt: 1 });
    const dear = order({ owner: CAROL, isLong: false, limitPrice: 102n * E18, size: 1n * E18, createdAt: 2 });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 103n * E18, size: 2n * E18, createdAt: 3 });
    const { matches } = run([dear, cheap, bid]);

    assert.equal(matches.length, 2);
    assert.equal(matches[0].price, 100n * E18);
    assert.equal(matches[1].price, 102n * E18);
    assert.equal(matches[0].size + matches[1].size, 2n * E18);
  });

  test("a fully filled order is skipped, not matched", () => {
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, size: 1n * E18, filledSize: 1n * E18 });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18 });
    const { matches, skipped } = run([ask, bid]);
    assert.deepEqual(matches, []);
    assert.equal(skipped.filter((s) => s.reason === "fully-filled").length, 1);
  });
});

describe("price-time priority", () => {
  test("at equal price the earlier order fills first", () => {
    const early = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, size: 1n * E18, createdAt: 10 });
    const late = order({ owner: CAROL, isLong: false, limitPrice: 100n * E18, size: 1n * E18, createdAt: 20 });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18, size: 1n * E18, createdAt: 30 });
    const { matches } = run([late, early, bid]);

    assert.equal(matches.length, 1);
    assert.equal(matches[0].maker.orderHash, early.orderHash);
  });

  test("at equal price and equal time the lower orderHash fills first", () => {
    const hi = order({
      orderHash: `0x${"f".repeat(64)}` as Hex,
      owner: ALICE,
      isLong: false,
      limitPrice: 100n * E18,
      createdAt: 10,
    });
    const lo = order({
      orderHash: `0x${"1".repeat(64)}` as Hex,
      owner: CAROL,
      isLong: false,
      limitPrice: 100n * E18,
      createdAt: 10,
    });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18, size: 1n * E18, createdAt: 30 });
    const { matches } = run([hi, lo, bid]);

    assert.equal(matches.length, 1);
    assert.equal(matches[0].maker.orderHash, lo.orderHash);
  });

  test("the result does not depend on input order", () => {
    const build = () => [
      order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, size: 3n * E18, createdAt: 1 }),
      order({ owner: CAROL, isLong: false, limitPrice: 101n * E18, size: 3n * E18, createdAt: 2 }),
      order({ owner: BOB, isLong: true, limitPrice: 102n * E18, size: 4n * E18, createdAt: 3 }),
    ];
    const book = build();
    const forward = run(book).matches;
    const reversed = run([...book].reverse()).matches;

    const shape = (ms: typeof forward) => ms.map((m) => [m.maker.orderHash, m.taker.orderHash, m.size, m.price]);
    assert.deepEqual(shape(reversed), shape(forward));
  });
});

describe("order eligibility", () => {
  test("an expired order never matches", () => {
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, expiry: NOW - 1n });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18 });
    const { matches, skipped } = run([ask, bid]);
    assert.deepEqual(matches, []);
    assert.equal(skipped.find((s) => s.reason === "expired")?.orderHash, ask.orderHash);
  });

  test("an order expiring exactly now is treated as expired", () => {
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, expiry: NOW });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18 });
    assert.deepEqual(run([ask, bid]).matches, []);
  });

  test("an order signed beyond MAX_ORDER_TTL never matches", () => {
    const ask = order({
      owner: ALICE,
      isLong: false,
      limitPrice: 100n * E18,
      expiry: NOW + MAX_ORDER_TTL_SECONDS + 1n,
    });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18 });
    const { matches, skipped } = run([ask, bid]);
    assert.deepEqual(matches, []);
    assert.equal(skipped.find((s) => s.reason === "expired")?.orderHash, ask.orderHash);
  });

  test("an order below the account's minValidNonce never matches", () => {
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, nonce: 4n });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18, nonce: 9n });
    const { matches, skipped } = run([ask, bid], { minValidNonce: new Map([[ALICE, 5n]]) });
    assert.deepEqual(matches, []);
    assert.equal(skipped.find((s) => s.reason === "stale-nonce")?.orderHash, ask.orderHash);
  });

  test("an order from another market is ignored", () => {
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, marketId: MARKET + 1 });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18 });
    assert.deepEqual(run([ask, bid]).matches, []);
  });
});

describe("self-trade prevention", () => {
  test("the same owner on both sides does not trade and both stay resting", () => {
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, createdAt: 1 });
    const bid = order({ owner: ALICE, isLong: true, limitPrice: 100n * E18, createdAt: 2 });
    const { matches, skipped } = run([ask, bid]);
    assert.deepEqual(matches, []);
    assert.equal(skipped.filter((s) => s.reason === "self-trade").length, 1);
  });

  test("a self-trade is skipped over, and the next counterparty still fills", () => {
    const own = order({ owner: BOB, isLong: false, limitPrice: 100n * E18, size: 1n * E18, createdAt: 1 });
    const other = order({ owner: ALICE, isLong: false, limitPrice: 101n * E18, size: 1n * E18, createdAt: 2 });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 102n * E18, size: 1n * E18, createdAt: 3 });
    const { matches } = run([own, other, bid]);

    assert.equal(matches.length, 1);
    assert.equal(matches[0].maker.orderHash, other.orderHash);
    assert.equal(matches[0].price, 101n * E18);
  });
});

describe("reduce-only", () => {
  const positions = (entries: [Address, bigint][]) => new Map<string, bigint>(entries);

  test("a reduce-only sell closes a long, capped at the position", () => {
    const ask = order({
      owner: ALICE,
      isLong: false,
      limitPrice: 100n * E18,
      size: 5n * E18,
      reduceOnly: true,
      createdAt: 1,
    });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18, size: 5n * E18, createdAt: 2 });
    const { matches } = run([ask, bid], { positions: positions([[ALICE, 2n * E18]]) });

    assert.equal(matches.length, 1);
    assert.equal(matches[0].size, 2n * E18);
  });

  test("a reduce-only buy closes a short, capped at the position", () => {
    const bid = order({
      owner: ALICE,
      isLong: true,
      limitPrice: 100n * E18,
      size: 5n * E18,
      reduceOnly: true,
      createdAt: 1,
    });
    const ask = order({ owner: BOB, isLong: false, limitPrice: 100n * E18, size: 5n * E18, createdAt: 2 });
    const { matches } = run([bid, ask], { positions: positions([[ALICE, -3n * E18]]) });

    assert.equal(matches.length, 1);
    assert.equal(matches[0].size, 3n * E18);
  });

  test("a reduce-only order on the same side as the position never matches", () => {
    const bid = order({
      owner: ALICE,
      isLong: true,
      limitPrice: 100n * E18,
      size: 5n * E18,
      reduceOnly: true,
    });
    const ask = order({ owner: BOB, isLong: false, limitPrice: 100n * E18, size: 5n * E18 });
    const { matches, skipped } = run([bid, ask], { positions: positions([[ALICE, 4n * E18]]) });

    assert.deepEqual(matches, []);
    assert.equal(skipped.find((s) => s.reason === "reduce-only-no-position")?.orderHash, bid.orderHash);
  });

  test("a reduce-only order with no position never matches", () => {
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, reduceOnly: true });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18 });
    assert.deepEqual(run([ask, bid]).matches, []);
  });

  test("two reduce-only orders from one trader share a single position", () => {
    const first = order({
      owner: ALICE,
      isLong: false,
      limitPrice: 100n * E18,
      size: 3n * E18,
      reduceOnly: true,
      createdAt: 1,
    });
    const second = order({
      owner: ALICE,
      isLong: false,
      limitPrice: 100n * E18,
      size: 3n * E18,
      reduceOnly: true,
      createdAt: 2,
    });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18, size: 10n * E18, createdAt: 3 });
    const { matches } = run([first, second, bid], { positions: positions([[ALICE, 4n * E18]]) });

    const total = matches.reduce((acc, m) => acc + m.size, 0n);
    assert.equal(total, 4n * E18, "the two orders together close at most the 4e18 position");
  });
});

describe("minimum fill notional", () => {
  test("a match below minFillNotional is dropped and both orders stay resting", () => {
    // 0.1 @ 100 = 10 < 40
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, size: E18 / 10n, createdAt: 1 });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18, size: E18 / 10n, createdAt: 2 });
    const { matches, skipped } = run([ask, bid]);

    assert.deepEqual(matches, []);
    assert.equal(skipped.filter((s) => s.reason === "below-min-notional").length, 1);
  });

  test("a match exactly at minFillNotional is kept", () => {
    // 0.4 @ 100 = 40
    const size = (4n * E18) / 10n;
    const ask = order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, size, createdAt: 1 });
    const bid = order({ owner: BOB, isLong: true, limitPrice: 100n * E18, size, createdAt: 2 });
    const { matches } = run([ask, bid]);

    assert.equal(matches.length, 1);
    assert.equal(matches[0].notional, MIN_NOTIONAL);
  });

  test("a dust remainder rests instead of becoming a second fill", () => {
    // Taker 1.0, maker 0.95: the 0.05 remainder is worth 5, below the floor.
    const maker = order({
      owner: ALICE,
      isLong: false,
      limitPrice: 100n * E18,
      size: (95n * E18) / 100n,
      createdAt: 1,
    });
    const taker = order({ owner: BOB, isLong: true, limitPrice: 100n * E18, size: E18, createdAt: 2 });
    const { matches } = run([maker, taker]);

    assert.equal(matches.length, 1);
    assert.equal(matches[0].size, (95n * E18) / 100n);
  });
});

describe("invariants", () => {
  test("filled size never exceeds either order's remaining size", () => {
    // Deterministic pseudo-random books; every run is reproducible from the seed.
    let state = 0x2545f491n;
    const rand = (n: number) => {
      state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return Number((state >> 33n) % BigInt(n));
    };
    const owners = [ALICE, BOB, CAROL];

    for (let iteration = 0; iteration < 300; iteration++) {
      const orders: EngineOrder[] = [];
      const count = 2 + rand(10);
      for (let i = 0; i < count; i++) {
        const size = BigInt(1 + rand(20)) * E18;
        const filled = (size * BigInt(rand(3))) / 4n;
        orders.push(
          order({
            owner: owners[rand(owners.length)],
            isLong: rand(2) === 0,
            limitPrice: BigInt(90 + rand(20)) * E18,
            size,
            filledSize: filled,
            createdAt: rand(50),
          })
        );
      }

      const { matches } = run(orders);
      const consumed = new Map<Hex, bigint>();
      for (const m of matches) {
        for (const side of [m.maker, m.taker]) {
          consumed.set(side.orderHash, (consumed.get(side.orderHash) ?? 0n) + m.size);
        }
        assert.equal(m.notional, notionalOf(m.size, m.price));
        assert.ok(m.size > 0n, "a match is never zero-sized");
        assert.notEqual(m.maker.owner, m.taker.owner, "a match is never a self-trade");
        assert.notEqual(m.maker.isLong, m.taker.isLong, "a match always has opposite sides");
        assert.ok(m.notional >= MIN_NOTIONAL, "a match always clears the notional floor");
      }
      for (const [hash, total] of consumed) {
        const o = orders.find((x) => x.orderHash === hash)!;
        assert.ok(total <= o.size - o.filledSize, `${hash} overfilled: ${total} > ${o.size - o.filledSize}`);
      }
    }
  });

  test("reruns of the same book produce identical matches", () => {
    const book = [
      order({ owner: ALICE, isLong: false, limitPrice: 100n * E18, size: 3n * E18, createdAt: 1 }),
      order({ owner: CAROL, isLong: false, limitPrice: 100n * E18, size: 3n * E18, createdAt: 2 }),
      order({ owner: BOB, isLong: true, limitPrice: 101n * E18, size: 5n * E18, createdAt: 3 }),
    ];
    const once = run(book).matches;
    const twice = run(book).matches;
    assert.deepEqual(
      twice.map((m) => [m.maker.orderHash, m.taker.orderHash, m.size, m.price, m.sequence]),
      once.map((m) => [m.maker.orderHash, m.taker.orderHash, m.size, m.price, m.sequence])
    );
  });
});
