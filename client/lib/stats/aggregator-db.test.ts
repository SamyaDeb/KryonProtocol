// The aggregator against a Postgres migrated with the Arc baseline.
//
// What these prove, in order of what would hurt most if it broke:
//  1. `/api/leaderboard` and `/api/portfolio/[address]` return populated,
//     correctly scaled data after a run — the reason the service exists;
//  2. incremental passes equal a full rebuild (`diffStats` finds nothing);
//  3. reprocessing a window is idempotent;
//  4. a window that rolls past UTC midnight drops the trader that aged out;
//  5. a chain that moved under the cursor forces a rebuild.
//
// Needs KRYON_TEST_DATABASE_URL pointing at a DISPOSABLE database; skips
// without it. Builds and drops its own schema (lib/test/pg.ts).

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { pgDb, type Db } from "@/lib/indexer/db";
import { createLogger, Metrics, systemClock, type Clock } from "@/lib/keepers/runtime";
import {
  getStatsCursor,
  readAccountAnalytics,
  readTraderStats,
  type IndexedHead,
} from "@/lib/queries/analytics";
import {
  E18,
  TEST_DATABASE_URL,
  TEST_NETWORK,
  addr,
  b32,
  closeRouteDb,
  createScratchDb,
  routeEnv,
  seedAccount,
  seedFill,
  seedMarket,
  seedOrder,
  seedRow,
  type ScratchDb,
} from "@/lib/test/pg";
import { StatsAggregator } from "./aggregator";
import { diffStats } from "./verify";

const ALICE = addr(0xa11ce);
const BOB = addr(0xb0b);
const REF = addr(0xfee2);
const USD = (n: number) => BigInt(n) * E18;

type Msg = Record<string, unknown>;
type Handler = (req: NextRequest, ctx: { params: Promise<{ address: string }> }) => Promise<Response>;

describe("stats aggregator against the Arc schema", { skip: !TEST_DATABASE_URL }, () => {
  let s: ScratchDb;
  let db: Db;
  let leaderboardRoute: (req: NextRequest) => Promise<Response>;
  let portfolioRoute: Handler;
  let now: Date;
  const clock: Clock = { now: () => now.getTime(), sleep: systemClock.sleep };

  const aggregator = (over: { rebuildHourUtc?: number } = {}) =>
    new StatsAggregator({
      db,
      network: TEST_NETWORK,
      log: createLogger("stats-test", "error", {}, () => {}),
      metrics: new Metrics(),
      clock,
      snapshotEveryMs: 0,
      batchSize: 2, // several batches, so batching cannot change the result
      ...over,
    });

  before(async () => {
    s = await createScratchDb("stats_agg");
    routeEnv(s);
    db = pgDb(s.url);
    leaderboardRoute = (await import("@/app/api/leaderboard/route")).GET;
    portfolioRoute = (await import("@/app/api/portfolio/[address]/route")).GET as Handler;
  });

  after(async () => {
    if (!s) return;
    await db.end();
    await closeRouteDb();
    await s.drop();
  });

  beforeEach(async () => {
    await s.reset();
    now = new Date("2026-09-19T12:00:00.000Z");
    await seedMarket(s);
    await seedAccount(s, { address: ALICE });
    await seedAccount(s, { address: BOB });
    await seedAccount(s, { address: REF });
  });

  // ── fixtures ──────────────────────────────────────────────────────────────

  let block = 0;
  /** A `ProtocolEvent` at `when`, and the log key a projection row shares with it. */
  async function event(when: string, name = "Placeholder"): Promise<{ blockNumber: bigint; txHash: string; logIndex: number }> {
    block += 1;
    const key = { blockNumber: BigInt(block), txHash: b32(0x70000n + BigInt(block)), logIndex: 0 };
    await seedRow(s, "ProtocolEvent", {
      network: TEST_NETWORK,
      blockNumber: key.blockNumber,
      blockHash: b32(0xb10c00n + BigInt(block)),
      blockTimestamp: new Date(when),
      txHash: key.txHash,
      logIndex: key.logIndex,
      contract: addr(0xc01174ac7),
      eventName: name,
      topic0: b32(1),
      args: {},
    });
    return key;
  }

  async function settledFill(when: string, v: { maker?: string; taker?: string; size: bigint; price: bigint; makerOrderHash?: string }) {
    const key = await event(when, "FillSettled");
    return seedFill(s, {
      status: "SETTLED",
      maker: v.maker ?? BOB,
      taker: v.taker ?? ALICE,
      size: v.size,
      price: v.price,
      ...(v.makerOrderHash ? { makerOrderHash: v.makerOrderHash } : {}),
      ...key,
    });
  }

  async function pnlEvent(when: string, address: string, kind: string, amount: bigint) {
    const key = await event(when, "PositionChanged");
    return seedRow(s, "PnlEvent", { network: TEST_NETWORK, address, marketId: 2, kind, amount, ...key });
  }

  async function balance(when: string, address: string, kind: "DEPOSIT" | "WITHDRAWAL", amount: bigint) {
    const key = await event(when, kind === "DEPOSIT" ? "Deposited" : "Withdrawn");
    return seedRow(s, "BalanceChange", {
      network: TEST_NETWORK,
      address,
      kind,
      internalAmount: amount,
      amount: amount / 10n ** 12n,
      ...key,
    });
  }

  async function liquidation(when: string, trader: string, closeSize: bigint, price: bigint) {
    const key = await event(when, "Liquidated");
    return seedRow(s, "LiquidationEvent", {
      network: TEST_NETWORK,
      trader,
      liquidator: addr(0x119),
      marketId: 2,
      closeSize,
      price,
      realizedPnl: -USD(10),
      penalty: USD(1),
      reward: USD(1),
      equityBefore: USD(100),
      equityAfter: USD(50),
      ...key,
    });
  }

  /** Alice deposits, trades twice today and pays fees; Bob is the maker. */
  async function baseline() {
    await balance("2026-09-01T00:00:00.000Z", ALICE, "DEPOSIT", USD(1_000));
    await settledFill("2026-09-19T01:00:00.000Z", { size: E18, price: USD(100) });
    await pnlEvent("2026-09-19T01:00:01.000Z", ALICE, "REALIZED_TRADE", USD(30));
    await pnlEvent("2026-09-19T01:00:02.000Z", ALICE, "FEE", -USD(2));
    await settledFill("2026-09-19T02:00:00.000Z", { size: E18 / 2n, price: USD(200) });
    await pnlEvent("2026-09-19T02:00:01.000Z", ALICE, "REALIZED_TRADE", -USD(10));
    await pnlEvent("2026-09-19T02:00:02.000Z", ALICE, "FUNDING", -USD(1));
  }

  const state = async () => ({
    traderStats: await readTraderStats(db, TEST_NETWORK),
    analytics: await readAccountAnalytics(db, TEST_NETWORK),
  });

  const head = async (): Promise<IndexedHead | null> => getStatsCursor(db, TEST_NETWORK);

  // ── tests ─────────────────────────────────────────────────────────────────

  test("the routes return populated, 1e6-scaled data after a run", async () => {
    await baseline();
    await liquidation("2026-09-19T03:00:00.000Z", ALICE, E18 / 4n, USD(100));
    const result = await aggregator().tick();
    assert.equal(result.mode, "rebuild", "no cursor yet: the first pass is a full build");

    const lb = await leaderboardRoute(
      new NextRequest(`http://localhost/api/leaderboard?period=DAY&metric=pnl&network=${TEST_NETWORK}`)
    );
    assert.equal(lb.status, 200);
    const board = (await lb.json()) as Msg;
    const traders = board.traders as Msg[];
    assert.ok(traders.length > 0, "the leaderboard is no longer empty");
    const alice = traders.find((t) => t.address === ALICE)!;
    assert.equal(alice.pnl, 20, "30 − 10 realized, in USDC");
    assert.equal(alice.volume, 200, "100 + 100 notional");
    assert.equal(alice.tradeCount, 2);
    assert.equal(alice.liquidations, 1);
    assert.equal(alice.accountValue, 1_030, "peak cash equity: 1000 deposited, peaking after the +30 trade");

    const pf = await portfolioRoute(
      new NextRequest(`http://localhost/api/portfolio/${ALICE}?network=${TEST_NETWORK}`, {
        headers: { "x-forwarded-for": "10.0.0.2" },
      }),
      { params: Promise.resolve({ address: ALICE }) }
    );
    assert.equal(pf.status, 200);
    const portfolio = (await pf.json()) as Msg;
    const analytics = portfolio.analytics as Msg;
    assert.equal(analytics.realizedPnl, 20);
    assert.equal(analytics.volume, 200);
    assert.equal(analytics.tradeCount, 2);
    assert.equal(analytics.totalDeposited, 1_000);
    assert.equal(analytics.totalFeesPaid, 2, "positive = paid");
    assert.equal(analytics.totalFundingPaid, 1);
    assert.equal(analytics.winRate, 0.5);
    assert.equal(analytics.liquidationCount, 1);
    assert.equal(analytics.lastTradeAt, "2026-09-19T02:00:00.000Z", "block timestamps, not row insert times");
  });

  test("incremental passes over several batches equal a full rebuild", async () => {
    await baseline();
    await aggregator().tick(); // first build
    const agg = aggregator();

    // Three more batches of events, each with its own incremental pass.
    await settledFill("2026-09-19T04:00:00.000Z", { maker: ALICE, taker: BOB, size: E18, price: USD(150) });
    await pnlEvent("2026-09-19T04:00:01.000Z", BOB, "REALIZED_TRADE", USD(5));
    assert.equal((await agg.tick()).mode, "incremental");

    await balance("2026-09-19T05:00:00.000Z", BOB, "DEPOSIT", USD(500));
    await liquidation("2026-09-19T05:30:00.000Z", BOB, E18 / 2n, USD(120));
    await agg.tick();

    const referred = await seedOrder(s, { owner: BOB, referrer: REF, nonce: 4242n });
    await settledFill("2026-09-19T06:00:00.000Z", {
      maker: BOB,
      taker: ALICE,
      size: E18,
      price: USD(90),
      makerOrderHash: String(referred[0].orderHash),
    });
    await agg.tick();

    const incremental = await state();
    assert.ok(incremental.traderStats.length >= 6, "rows for several addresses and periods");
    assert.ok(
      incremental.traderStats.some((r) => r.address === REF && r.referralCount === 1 && r.referralVolume === 90_000_000n),
      "the referrer got credit for the referred fill"
    );

    // The same thing computed from scratch must be identical.
    const verified = await aggregator().rebuild(now, "requested", await head(), true);
    assert.equal(verified.mismatches, 0, "a full rebuild reproduces the incremental result exactly");
    assert.deepEqual(diffStats(incremental, await state()), []);
  });

  test("reprocessing the same window is idempotent", async () => {
    await baseline();
    const agg = aggregator();
    await agg.tick();
    const first = await state();
    await agg.tick();
    await agg.tick();
    assert.deepEqual(diffStats(first, await state()), []);

    // And a rebuild over the same rows writes the same values again.
    await aggregator().rebuild(now, "requested", await head());
    assert.deepEqual(diffStats(first, await state()), []);
  });

  test("a trade that ages out at UTC midnight leaves the DAY board", async () => {
    await baseline();
    // The nightly recompute is parked at 23:00 UTC so this test sees the
    // incremental pass, which is what must notice the rolled window.
    const agg = aggregator({ rebuildHourUtc: 23 });
    await agg.tick();
    const before = (await state()).traderStats.filter((r) => r.address === ALICE && r.period === "DAY");
    assert.equal(before.length, 1);
    assert.equal(before[0].periodStart.toISOString(), "2026-09-19T00:00:00.000Z");

    // Next day, no new events: only the clock moved.
    now = new Date("2026-09-20T00:30:00.000Z");
    const rolled = await agg.tick();
    assert.equal(rolled.mode, "incremental");
    assert.ok(rolled.addresses > 0, "the rolled window is what made the address dirty");

    const after = await state();
    assert.equal(after.traderStats.filter((r) => r.address === ALICE && r.period === "DAY").length, 0);
    const week = after.traderStats.find((r) => r.address === ALICE && r.period === "WEEK")!;
    assert.equal(week.volume, 200_000_000n, "the WEEK window still holds them");
    assert.equal(week.periodStart.toISOString(), "2026-09-14T00:00:00.000Z");
    assert.equal(after.analytics.find((a) => a.address === ALICE)!.volume30d, 200_000_000n);
  });

  test("a chain that moved under the cursor forces a rebuild", async () => {
    await baseline();
    const agg = aggregator();
    await agg.tick();
    const cursor = await getStatsCursor(db, TEST_NETWORK);
    assert.ok(cursor, "the cursor was written");

    // Same height, different block: what a reorg leaves behind.
    await s.query(`UPDATE "ProtocolEvent" SET "blockHash" = $2 WHERE "network" = $1 AND "blockNumber" = $3`, [
      TEST_NETWORK,
      b32(0xdead),
      cursor!.blockNumber.toString(),
    ]);
    const result = await agg.tick();
    assert.equal(result.mode, "rebuild");
    assert.equal(result.reason, "reorg");
    assert.equal((await getStatsCursor(db, TEST_NETWORK))!.blockHash, b32(0xdead));
  });

  test("leaderboard snapshots are captured per period and metric", async () => {
    await baseline();
    const agg = aggregator();
    await agg.tick();
    await s.query(`DELETE FROM "LeaderboardSnapshot" WHERE "network" = $1`, [TEST_NETWORK]);
    const written = await agg.snapshot(now);
    assert.ok(written > 0);
    const rows = await s.query(
      `SELECT "period", "metric", "rankings", "traderCount" FROM "LeaderboardSnapshot" WHERE "network" = $1 ORDER BY "period", "metric"`,
      [TEST_NETWORK]
    );
    assert.equal(rows.length, written);
    const day = rows.find((r) => r.period === "DAY" && r.metric === "pnl")!;
    const rankings = day.rankings as Msg[];
    assert.equal(rankings[0].rank, 1);
    assert.equal(typeof rankings[0].pnl, "string", "money is a 1e6 string");

    // Ranked numerically: 12 USDC beats 9, though "9000000" > "12000000" as text.
    await s.query(`DELETE FROM "TraderStat" WHERE "network" = $1`, [TEST_NETWORK]);
    for (const [address, pnl] of [
      [ALICE, "9000000"],
      [BOB, "12000000"],
    ] as const) {
      await seedRow(s, "TraderStat", {
        network: TEST_NETWORK,
        address,
        period: "DAY",
        periodStart: new Date("2026-09-19T00:00:00.000Z"),
        realizedPnl: pnl,
        updatedAt: now,
      });
    }
    await s.query(`DELETE FROM "LeaderboardSnapshot" WHERE "network" = $1`, [TEST_NETWORK]);
    await agg.snapshot(now);
    const ranked = (
      await s.query(`SELECT "rankings" FROM "LeaderboardSnapshot" WHERE "network" = $1 AND "period" = 'DAY' AND "metric" = 'pnl'`, [
        TEST_NETWORK,
      ])
    )[0].rankings as Msg[];
    assert.deepEqual(
      ranked.map((r) => [r.address, r.pnl]),
      [
        [BOB, "12000000"],
        [ALICE, "9000000"],
      ]
    );
  });
});
