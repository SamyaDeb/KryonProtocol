// Fee resolution for GET /api/fees: the indexer path (projected schedule and
// tier), the chain path (database unavailable), and the FeeRouter's own rules
// (removed tier falls back to the market, no rebate while rebates are off).
// The database-backed cases need KRYON_TEST_DATABASE_URL and use the real
// Arc schema, so a renamed column fails here rather than as a 500.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { effectiveRates, feesToJson, resolveFees, type FeeChain, type Rates } from "./fees";
import type { Queryable } from "./queries/client";
import { TEST_DATABASE_URL, TEST_NETWORK, addr, createScratchDb, seedAccount, seedMarket, type ScratchDb } from "./test/pg";

const ALICE = addr(0xa11ce);

interface FakeState {
  rebates: boolean;
  floor: number;
  tiers: Record<number, Rates>;
  accountTiers: Record<string, number>;
  markets: { id: number; symbol: string; active: boolean; rates: Rates }[];
}

function fakeChain(s: FakeState, calls: string[] = []): FeeChain {
  const unset: Rates = { makerRate: 0, takerRate: 0, set: false };
  return {
    rebatesEnabled: async () => (calls.push("rebatesEnabled"), s.rebates),
    minNetRate: async () => (calls.push("minNetRate"), s.floor),
    tierRates: async (t) => (calls.push(`tierRates(${t})`), s.tiers[t] ?? unset),
    accountTier: async (a) => (calls.push("accountTier"), s.accountTiers[a.toLowerCase()] ?? 0),
    marketRates: async (id) => (calls.push(`marketRates(${id})`), s.markets.find((m) => m.id === id)?.rates ?? unset),
    markets: async () => (calls.push("markets"), s.markets.map(({ id, symbol, active }) => ({ id, symbol, active }))),
  };
}

const failingDb: Queryable = {
  query: async () => {
    throw new Error("connection refused");
  },
};

function state(over: Partial<FakeState> = {}): FakeState {
  return {
    rebates: false,
    floor: 100,
    tiers: { 2: { makerRate: -20, takerRate: 250, set: true } },
    accountTiers: {},
    markets: [
      { id: 2, symbol: "BTC", active: true, rates: { makerRate: 50, takerRate: 350, set: true } },
      { id: 3, symbol: "ETH", active: true, rates: { makerRate: 50, takerRate: 350, set: true } },
      // Listed but never given a schedule: quote() reverts, so it is not tradable.
      { id: 4, symbol: "SOL", active: false, rates: { makerRate: 0, takerRate: 0, set: false } },
    ],
    ...over,
  };
}

describe("fee rules mirror FeeRouter", () => {
  const markets = [{ marketId: 2, symbol: "BTC", active: true, makerRate: 50, takerRate: 350 }];

  test("tier 0 uses the market schedule", () => {
    assert.deepEqual(effectiveRates(markets, 0, null, false), {
      effectiveTier: 0,
      rates: [{ marketId: 2, makerRate: 50, takerRate: 350 }],
    });
  });

  test("a defined tier replaces the market schedule", () => {
    const r = effectiveRates(markets, 2, { makerRate: 10, takerRate: 200, set: true }, false);
    assert.deepEqual(r, { effectiveTier: 2, rates: [{ marketId: 2, makerRate: 10, takerRate: 200 }] });
  });

  test("a removed tier falls back to the market and reports tier 0", () => {
    const r = effectiveRates(markets, 3, { makerRate: 0, takerRate: 0, set: false }, false);
    assert.deepEqual(r, { effectiveTier: 0, rates: [{ marketId: 2, makerRate: 50, takerRate: 350 }] });
  });

  test("a negative maker rate pays no rebate while rebates are off", () => {
    const tier = { makerRate: -20, takerRate: 250, set: true };
    assert.equal(effectiveRates(markets, 2, tier, false).rates[0].makerRate, 0);
    assert.equal(effectiveRates(markets, 2, tier, true).rates[0].makerRate, -20);
  });
});

describe("chain path (no database)", () => {
  test("reads schedule and tier from the FeeRouter, skipping unscheduled markets", async () => {
    const s = state({ accountTiers: { [ALICE]: 2 } });
    const f = await resolveFees({ network: TEST_NETWORK, sql: null, chain: fakeChain(s), address: ALICE });
    assert.equal(f.source, "chain");
    assert.deepEqual(f.markets.map((m) => [m.marketId, m.symbol, m.makerRate, m.takerRate]), [
      [2, "BTC", 50, 350],
      [3, "ETH", 50, 350],
    ]);
    assert.equal(f.account?.tierSource, "chain");
    assert.equal(f.account?.tier, 2);
    assert.deepEqual(f.account?.rates[0], { marketId: 2, makerRate: 0, takerRate: 250 });
  });

  test("a failing database degrades to the chain and reports it", async () => {
    const errors: unknown[] = [];
    const f = await resolveFees({
      network: TEST_NETWORK,
      sql: failingDb,
      chain: fakeChain(state()),
      address: ALICE,
      onDbError: (e) => errors.push(e),
    });
    assert.equal(f.source, "chain");
    assert.equal(f.account?.tierSource, "chain");
    assert.equal(errors.length, 1);
  });

  test("a chain failure propagates: the fee cannot be stated without the globals", async () => {
    const chain = { ...fakeChain(state()), minNetRate: async () => Promise.reject(new Error("rpc down")) };
    await assert.rejects(resolveFees({ network: TEST_NETWORK, sql: null, chain }), /rpc down/);
  });

  test("JSON: rates in millionths, account rates labelled, no account without an address", async () => {
    const f = await resolveFees({ network: TEST_NETWORK, sql: null, chain: fakeChain(state()) });
    const j = feesToJson(TEST_NETWORK, f);
    assert.equal(j.rate_denominator, 1_000_000);
    assert.equal(j.net_rate_floor, 100);
    assert.equal(j.rebates_enabled, false);
    assert.deepEqual(j.markets[0], { market_id: 2, symbol: "BTC", active: true, maker_rate: 50, taker_rate: 350 });
    assert.equal(j.account, null);
  });
});

describe("indexer path (Arc schema)", { skip: !TEST_DATABASE_URL }, () => {
  let s: ScratchDb;

  before(async () => {
    s = await createScratchDb("fees");
  });
  after(async () => {
    if (s) await s.drop();
  });
  beforeEach(async () => {
    await s.reset();
  });

  test("schedule and tier come from the projections; globals from the chain", async () => {
    await seedMarket(s, { id: 2, symbol: "BTC-PERP", makerRate: 40, takerRate: 300 });
    await seedMarket(s, { id: 3, symbol: "ETH-PERP", active: false, makerRate: 60, takerRate: 400 });
    await seedAccount(s, { address: ALICE, feeTier: 2 });
    const calls: string[] = [];
    const f = await resolveFees({ network: TEST_NETWORK, sql: s, chain: fakeChain(state(), calls), address: ALICE });

    assert.equal(f.source, "indexer");
    assert.deepEqual(f.markets.map((m) => [m.marketId, m.symbol, m.active, m.makerRate, m.takerRate]), [
      [2, "BTC-PERP", true, 40, 300],
      [3, "ETH-PERP", false, 60, 400],
    ]);
    assert.equal(f.account?.tier, 2);
    assert.equal(f.account?.tierSource, "indexer");
    assert.deepEqual(f.account?.rates[0], { marketId: 2, makerRate: 0, takerRate: 250 });
    // The projected data was not re-read from the chain.
    assert.ok(!calls.includes("markets") && !calls.includes("accountTier"), calls.join(","));
    assert.ok(calls.includes("tierRates(2)"));
  });

  test("an account the indexer has never seen is tier 0", async () => {
    await seedMarket(s, { id: 2, makerRate: 40, takerRate: 300 });
    const f = await resolveFees({ network: TEST_NETWORK, sql: s, chain: fakeChain(state()), address: addr(0xdead) });
    assert.equal(f.account?.tier, 0);
    assert.deepEqual(f.account?.rates, [{ marketId: 2, makerRate: 40, takerRate: 300 }]);
  });

  test("never answers from another network", async () => {
    await seedMarket(s, { network: "arc-testnet", id: 2, makerRate: 40, takerRate: 300 });
    const f = await resolveFees({ network: TEST_NETWORK, sql: s, chain: fakeChain(state()) });
    assert.deepEqual(f.markets, []);
  });
});

describe("GET /api/fees", () => {
  test("a malformed address is 400 before any read", async () => {
    process.env.NEXT_PUBLIC_KRYON_NETWORK = TEST_NETWORK;
    process.env.NEXT_PUBLIC_KRYON_NETWORKS = TEST_NETWORK;
    const { GET } = await import("@/app/api/fees/route");
    const res = await GET(new NextRequest(`http://localhost/api/fees?network=${TEST_NETWORK}&address=0x123`));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_address");
  });
});
