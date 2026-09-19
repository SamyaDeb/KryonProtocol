// Every read route, executed against a Postgres migrated with the Arc baseline.
//
// Each route gets (at least) a happy path, an empty result and a malformed
// request. The happy and empty paths assert a 200: before step 2 every one of
// these handlers issued SQL naming columns the Arc schema does not have, and
// the symptom was exactly a 500 on the first real query — which is what these
// would have reported. `schema-drift.test.ts` catches the same class
// statically, without a database.
//
// Needs KRYON_TEST_DATABASE_URL pointing at a DISPOSABLE database. The suite
// builds and drops its own schema (lib/test/pg.ts) and never touches `public`.
// Run: KRYON_TEST_DATABASE_URL=postgresql://localhost:5432/kryon_api_test npm test

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

import type { Query } from "@/lib/indexer/db";
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
  seedPosition,
  seedRow,
  type ScratchDb,
} from "./pg";

const ALICE = addr(0xa11ce);
const BOB = addr(0xb0b);
const NOW = () => Math.floor(Date.now() / 1000);

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(h: Handler, path: string, params: Record<string, string> = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const req = new NextRequest(`http://localhost${path}${sep}network=${TEST_NETWORK}`, {
    headers: { "x-forwarded-for": "10.0.0.1" },
  });
  const res = await h(req, { params: Promise.resolve(params) });
  return { status: res.status, body: (await res.json()) as never as Record<string, unknown> & unknown[] };
}

describe("API routes against the Arc schema", { skip: !TEST_DATABASE_URL }, () => {
  let s: ScratchDb;
  let deploymentDir = "";
  const r = {} as Record<string, Handler>;

  before(async () => {
    s = await createScratchDb("api_routes");
    routeEnv(s);
    // /api/ready checks the web configuration (lib/config-check.ts): the
    // offered network needs a deployment record, so give it a fixture one.
    deploymentDir = mkdtempSync(join(tmpdir(), "kryon-api-routes-"));
    const record = join(deploymentDir, "arc-local.json");
    writeFileSync(
      record,
      JSON.stringify({
        chainId: 5042002,
        timelock: addr(9),
        proxies: { vault: addr(1), engine: addr(2), gateway: addr(8), oracle: addr(3), liquidation: addr(4), insurance: addr(5), risk: addr(6), feeRouter: addr(7) },
      })
    );
    process.env.KRYON_DEPLOYMENT_FILE_ARC_LOCAL = record;
    // Imported only now: `@/lib/network` fixes the allowed networks at load.
    const load = async (p: string) => (await import(p)).GET as Handler;
    r.markets = await load("@/app/api/markets/route");
    r.market = await load("@/app/api/markets/[id]/route");
    r.trades = await load("@/app/api/markets/[id]/trades/route");
    r.candles = await load("@/app/api/markets/[id]/candles/route");
    r.orderbook = await load("@/app/api/markets/[id]/orderbook/route");
    r.orders = await load("@/app/api/orders/list/route");
    r.fills = await load("@/app/api/fills/route");
    r.positions = await load("@/app/api/positions/route");
    r.funding = await load("@/app/api/funding/route");
    r.portfolio = await load("@/app/api/portfolio/[address]/route");
    r.leaderboard = await load("@/app/api/leaderboard/route");
    r.ready = await load("@/app/api/ready/route");
    r.health = await load("@/app/api/health/route");
    r.time = await load("@/app/api/time/route");
  });

  after(async () => {
    if (deploymentDir) rmSync(deploymentDir, { recursive: true, force: true });
    delete process.env.KRYON_DEPLOYMENT_FILE_ARC_LOCAL;
    if (!s) return;
    await closeRouteDb();
    await s.drop();
  });

  beforeEach(async () => {
    await s.reset();
  });

  async function baseline() {
    await seedMarket(s);
    await seedAccount(s, { address: ALICE });
    await seedAccount(s, { address: BOB });
  }

  // ── Markets ────────────────────────────────────────────────────────────────

  describe("GET /api/markets", () => {
    test("lists markets with on-chain risk params and 24h settled volume", async () => {
      await baseline();
      await seedMarket(s, { id: 3, symbol: "ETH-PERP", active: false, params: {} });
      await seedFill(s, { status: "SETTLED", size: E18 / 10n, price: 100_000n * E18 });
      await seedFill(s, { size: E18, price: 100_000n * E18 }); // PENDING: not volume

      const { status, body } = await call(r.markets, "/api/markets");
      assert.equal(status, 200);
      const markets = body.markets as Record<string, unknown>[];
      assert.deepEqual(markets.map((m) => [m.symbol, m.active]), [["BTC-PERP", true], ["ETH-PERP", false]]);
      assert.equal(markets[0].min_fill_notional, (10n * E18).toString());
      assert.equal(markets[0].max_execution_deviation_bps, 75);
      assert.equal(markets[0].volume, (10_000n * E18).toString(), "0.1 × 100k, settled only");
      assert.equal(markets[0].volume_base, (E18 / 10n).toString());
      assert.equal(markets[1].min_fill_notional, "0", "unparameterised market reads as zero, not NaN");
      assert.equal(body.amount_precision, E18.toString());
    });

    test("empty database lists nothing", async () => {
      const { status, body } = await call(r.markets, "/api/markets");
      assert.equal(status, 200);
      assert.deepEqual(body.markets, []);
    });

    test("never answers from another network", async () => {
      await seedMarket(s, { network: "arc-testnet" });
      const { body } = await call(r.markets, "/api/markets");
      assert.deepEqual(body.markets, []);
    });
  });

  describe("GET /api/markets/:id", () => {
    test("returns the market in the listing's shape", async () => {
      await baseline();
      const { status, body } = await call(r.market, "/api/markets/2", { id: "2" });
      assert.equal(status, 200);
      assert.equal(body.symbol, "BTC-PERP");
      assert.equal(body.last_price, (100_000n * E18).toString());
      assert.equal(body.volume, "0");
      assert.equal(body.long_open_interest, "0");
    });

    test("unknown market is 404", async () => {
      assert.equal((await call(r.market, "/api/markets/9", { id: "9" })).status, 404);
    });

    test("malformed id is 400", async () => {
      for (const id of ["0", "abc", "-1", "4294967296", "1e3"]) {
        assert.equal((await call(r.market, `/api/markets/${id}`, { id })).status, 400, id);
      }
    });
  });

  describe("GET /api/markets/:id/trades", () => {
    test("settled prints only, newest first by chain order, side from takerIsBuy", async () => {
      await baseline();
      await seedFill(s, { status: "SETTLED", takerIsBuy: true, price: 100_000n * E18, blockNumber: 10n, logIndex: 0 });
      await seedFill(s, { status: "SETTLED", takerIsBuy: false, price: 99_000n * E18, blockNumber: 11n, logIndex: 0 });
      await seedFill(s, { takerIsBuy: true, price: 1n * E18 }); // PENDING
      await seedFill(s, { status: "REJECTED", rejectReason: "PriceOutsideBand", price: 2n * E18 });

      const { status, body } = await call(r.trades, "/api/markets/2/trades", { id: "2" });
      assert.equal(status, 200);
      assert.deepEqual(
        (body as unknown as { price: string; side: string }[]).map((t) => [t.price, t.side]),
        [["99000.0000", "sell"], ["100000.0000", "buy"]]
      );
      const first = (body as unknown as Record<string, unknown>[])[0];
      assert.equal(first.price_raw, (99_000n * E18).toString(), "the exact price rides along");
      assert.equal(first.block_number, "11");
      assert.equal(typeof first.size_raw, "string");
    });

    test("no fills is an empty list", async () => {
      const { status, body } = await call(r.trades, "/api/markets/2/trades", { id: "2" });
      assert.equal(status, 200);
      assert.deepEqual(body, []);
    });

    test("bad limit is 400", async () => {
      assert.equal((await call(r.trades, "/api/markets/2/trades?limit=x", { id: "2" })).status, 400);
    });
  });

  describe("GET /api/markets/:id/candles", () => {
    test("buckets settled fills into OHLCV, oldest first", async () => {
      await baseline();
      const t = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 60_000);
      await seedFill(s, { status: "SETTLED", price: 100n * E18, size: E18, blockNumber: 1n, logIndex: 0, createdAt: t });
      await seedFill(s, { status: "SETTLED", price: 120n * E18, size: E18, blockNumber: 2n, logIndex: 0, createdAt: t });
      await seedFill(s, { status: "SETTLED", price: 90n * E18, size: 2n * E18, blockNumber: 3n, logIndex: 0, createdAt: t });
      await seedFill(s, { price: 500n * E18, createdAt: t }); // PENDING, ignored

      const { status, body } = await call(r.candles, "/api/markets/2/candles?tf=3600", { id: "2" });
      assert.equal(status, 200);
      assert.deepEqual(body, [
        {
          time: Math.floor(t.getTime() / 1000 / 3600) * 3600, open: 100, high: 120, low: 90, close: 90, volume: 4,
          open_raw: (100n * E18).toString(), high_raw: (120n * E18).toString(), low_raw: (90n * E18).toString(),
          close_raw: (90n * E18).toString(), volume_raw: (4n * E18).toString(),
        },
      ]);
    });

    test("no fills is an empty list", async () => {
      const { status, body } = await call(r.candles, "/api/markets/2/candles", { id: "2" });
      assert.equal(status, 200);
      assert.deepEqual(body, []);
    });

    test("tf below a minute is 400", async () => {
      assert.equal((await call(r.candles, "/api/markets/2/candles?tf=5", { id: "2" })).status, 400);
    });
  });

  describe("GET /api/markets/:id/orderbook", () => {
    test("aggregates remaining size of working orders only", async () => {
      await baseline();
      await seedAccount(s, { address: addr(0xca401), minValidNonce: 100n });
      const bid = await seedOrder(s, { owner: ALICE, isLong: true, size: 3n * E18, limitPrice: 99n * E18 });
      await seedOrder(s, { owner: BOB, isLong: true, size: E18, limitPrice: 99n * E18, filledSize: E18 / 2n, status: "PARTIALLY_FILLED" });
      await seedOrder(s, { owner: BOB, isLong: false, size: 2n * E18, limitPrice: 101n * E18 });
      // Not working: cancelled, expired, filled, under minValidNonce.
      await seedOrder(s, { owner: ALICE, isLong: false, limitPrice: 100n * E18, status: "CANCELLED" });
      await seedOrder(s, { owner: ALICE, isLong: false, limitPrice: 100n * E18, expiry: BigInt(NOW() - 1) });
      await seedOrder(s, { owner: ALICE, isLong: false, limitPrice: 100n * E18, filledSize: E18, status: "FILLED" });
      await seedOrder(s, { owner: addr(0xca401), isLong: false, limitPrice: 100n * E18, nonce: 5n });
      // A PENDING fill reserves 1 of the 3 on Alice's bid; a rejected-but-pending one does not.
      await seedFill(s, { makerOrderHash: bid[0].orderHash, size: E18 });
      await seedFill(s, { makerOrderHash: bid[0].orderHash, size: E18, rejectReason: "OrderCancelled" });

      const { status, body } = await call(r.orderbook, "/api/markets/2/orderbook", { id: "2" });
      assert.equal(status, 200);
      const lv = (l: Record<string, unknown>) => [l.price, l.size, l.orders];
      assert.deepEqual((body.bids as Record<string, unknown>[]).map(lv), [["99.0000", "2.5000", 2]]);
      assert.deepEqual((body.asks as Record<string, unknown>[]).map(lv), [["101.0000", "2.0000", 1]]);
      assert.equal((body.bids as Record<string, unknown>[])[0].size_raw, ((5n * E18) / 2n).toString());
    });

    test("an order wholly reserved by PENDING fills leaves the book", async () => {
      await baseline();
      const o = await seedOrder(s, { owner: ALICE, size: E18 });
      await seedFill(s, { takerOrderHash: o[0].orderHash, size: E18 });
      const { body } = await call(r.orderbook, "/api/markets/2/orderbook", { id: "2" });
      assert.deepEqual(body.bids, []);
    });

    test("empty book", async () => {
      const { status, body } = await call(r.orderbook, "/api/markets/2/orderbook", { id: "2" });
      assert.equal(status, 200);
      assert.deepEqual([body.bids, body.asks], [[], []]);
    });
  });

  // ── Account reads ──────────────────────────────────────────────────────────

  describe("GET /api/orders/list", () => {
    test("open orders carry filled, pending and remaining size", async () => {
      await baseline();
      const o = await seedOrder(s, { owner: ALICE, size: 4n * E18, filledSize: E18, status: "PARTIALLY_FILLED", nonce: 7n });
      await seedOrder(s, { owner: ALICE, status: "CANCELLED", nonce: 8n });
      await seedOrder(s, { owner: BOB, nonce: 9n });
      await seedFill(s, { makerOrderHash: o[0].orderHash, size: E18 });

      const open = await call(r.orders, `/api/orders/list?address=${ALICE}`);
      assert.equal(open.status, 200);
      const orders = open.body.orders as Record<string, unknown>[];
      assert.equal(orders.length, 1);
      assert.equal(orders[0].order_hash, o[0].orderHash);
      assert.equal(orders[0].filled_size, E18.toString());
      assert.equal(orders[0].pending_size, E18.toString());
      assert.equal(orders[0].remaining_size, (2n * E18).toString());
      assert.equal(orders[0].status, "PARTIALLY_FILLED");

      const all = await call(r.orders, `/api/orders/list?address=${ALICE}&status=all`);
      assert.equal((all.body.orders as unknown[]).length, 2);
    });

    test("orders below the on-chain minValidNonce are not open", async () => {
      await baseline();
      await s.query(`UPDATE "Account" SET "minValidNonce" = 10 WHERE "address" = $1`, [ALICE]);
      await seedOrder(s, { owner: ALICE, nonce: 9n });
      const open = await call(r.orders, `/api/orders/list?address=${ALICE}`);
      assert.deepEqual(open.body.orders, []);
      const all = await call(r.orders, `/api/orders/list?address=${ALICE}&status=all`);
      assert.equal((all.body.orders as Record<string, unknown>[])[0].nonce_invalidated, true);
    });

    test("checksummed input matches the lowercase row", async () => {
      await baseline();
      await seedOrder(s, { owner: ALICE });
      const checksummed = "0x00000000000000000000000000000000000A11cE";
      const { status, body } = await call(r.orders, `/api/orders/list?address=${checksummed}`);
      assert.equal(status, 200);
      assert.equal((body.orders as unknown[]).length, 1);
    });

    test("no orders is an empty list", async () => {
      const { status, body } = await call(r.orders, `/api/orders/list?address=${ALICE}`);
      assert.equal(status, 200);
      assert.deepEqual(body.orders, []);
    });

    test("a Stellar or malformed address is 400", async () => {
      for (const a of ["GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H", "0x123", "0x00000000000000000000000000000000000A11CE"]) {
        assert.equal((await call(r.orders, `/api/orders/list?address=${a}`)).status, 400, a);
      }
    });
  });

  describe("GET /api/fills", () => {
    test("returns every status, labelled; pending has no txHash", async () => {
      await baseline();
      await seedFill(s, { status: "SETTLED", maker: ALICE, taker: BOB, takerIsBuy: true, blockNumber: 1n, logIndex: 0 });
      await seedFill(s, { maker: BOB, taker: ALICE, takerIsBuy: true });
      await seedFill(s, { maker: BOB, taker: addr(0xdead) }); // not Alice's

      const { status, body } = await call(r.fills, `/api/fills?address=${ALICE}`);
      assert.equal(status, 200);
      const fills = body as unknown as Record<string, unknown>[];
      assert.deepEqual(fills.map((f) => [f.status, f.isMaker, f.side]).sort(), [
        ["PENDING", false, "buy"],
        ["SETTLED", true, "sell"],
      ]);
      assert.equal(fills.find((f) => f.status === "PENDING")!.txHash, null);
      const settled = fills.find((f) => f.status === "SETTLED")!;
      assert.equal(typeof settled.priceRaw, "string");
      assert.match(String(settled.sizeRaw), /^\d+$/);
      assert.equal(settled.blockNumber, "1");
      assert.equal(fills.find((f) => f.status === "PENDING")!.blockNumber, null);
    });

    test("no fills is an empty list", async () => {
      const { status, body } = await call(r.fills, `/api/fills?address=${ALICE}`);
      assert.equal(status, 200);
      assert.deepEqual(body, []);
    });

    test("bad address or since is 400", async () => {
      assert.equal((await call(r.fills, `/api/fills?address=nope`)).status, 400);
      assert.equal((await call(r.fills, `/api/fills?address=${ALICE}&since=x`)).status, 400);
    });
  });

  describe("GET /api/positions", () => {
    test("open positions with signed size and derived entry price", async () => {
      await baseline();
      await seedMarket(s, { id: 3, symbol: "ETH-PERP" });
      await seedPosition(s, { size: -2n * E18, openNotional: -5_000n * E18, marketId: 3 });
      await seedPosition(s, { size: 0n, openNotional: 0n, marketId: 2 }); // flat

      const { status, body } = await call(r.positions, `/api/positions?address=${ALICE}`);
      assert.equal(status, 200);
      const p = (body.positions as Record<string, unknown>[])[0];
      assert.equal(body.count, 1);
      assert.equal(p.is_long, false);
      assert.equal(p.size, (-2n * E18).toString());
      assert.equal(p.entry_price, (2_500n * E18).toString());
    });

    test("no positions", async () => {
      const { status, body } = await call(r.positions, `/api/positions?address=${ALICE}`);
      assert.equal(status, 200);
      assert.deepEqual(body.positions, []);
    });

    test("bad market id is 400", async () => {
      assert.equal((await call(r.positions, `/api/positions?address=${ALICE}&market_id=x`)).status, 400);
    });
  });

  describe("GET /api/funding", () => {
    test("payments in USDC, signed", async () => {
      await seedRow(s, "FundingPayment", {
        network: TEST_NETWORK, address: ALICE, marketId: 2, amount: (-15n * E18) / 10n,
        blockNumber: 1n, txHash: b32(0xf00d), logIndex: 0,
      });
      const { status, body } = await call(r.funding, `/api/funding?address=${ALICE}`);
      assert.equal(status, 200);
      assert.deepEqual(
        (body as unknown as Record<string, unknown>[]).map((p) => [p.marketId, p.amount, p.amountRaw]),
        [[2, -1.5, ((-15n * E18) / 10n).toString()]]
      );
    });

    test("no payments", async () => {
      const { status, body } = await call(r.funding, `/api/funding?address=${ALICE}`);
      assert.equal(status, 200);
      assert.deepEqual(body, []);
    });

    test("bad limit is 400", async () => {
      assert.equal((await call(r.funding, `/api/funding?address=${ALICE}&limit=0`)).status, 400);
    });
  });

  describe("GET /api/portfolio/:address", () => {
    test("analytics at 1e6 and events at 1e18", async () => {
      await seedRow(s, "AccountAnalytics", {
        network: TEST_NETWORK, address: ALICE, realizedPnlAll: 1_500_000n, volumeAll: 250_000_000n,
        tradeCountAll: 3, updatedAt: new Date(),
      });
      await seedRow(s, "PnlEvent", {
        network: TEST_NETWORK, address: ALICE, marketId: 2, kind: "REALIZED_TRADE", amount: 2n * E18,
        blockNumber: 1n, txHash: b32(1), logIndex: 0,
      });
      await seedRow(s, "BalanceChange", {
        network: TEST_NETWORK, address: ALICE, kind: "DEPOSIT", amount: 100_000_000n, internalAmount: 100n * E18,
        blockNumber: 1n, txHash: b32(2), logIndex: 0,
      });
      await seedRow(s, "PortfolioSnapshot", { network: TEST_NETWORK, address: ALICE, equity: 42_000_000n });

      const { status, body } = await call(r.portfolio, `/api/portfolio/${ALICE}`, { address: ALICE });
      assert.equal(status, 200);
      const a = body.analytics as Record<string, unknown>;
      assert.deepEqual([a.realizedPnl, a.volume, a.tradeCount], [1.5, 250, 3]);
      assert.equal((body.pnlHistory as Record<string, unknown>[])[0].amount, 2);
      assert.deepEqual(
        (body.balanceHistory as Record<string, unknown>[]).map((b) => [b.kind, b.asset, b.amount, b.balanceAfter]),
        [["DEPOSIT", "USDC", 100, null]]
      );
      assert.equal((body.equityCurve as Record<string, unknown>[])[0].equity, 42);
    });

    test("unknown account has null analytics and empty history", async () => {
      const { status, body } = await call(r.portfolio, `/api/portfolio/${ALICE}`, { address: ALICE });
      assert.equal(status, 200);
      assert.equal(body.analytics, null);
      assert.deepEqual([body.pnlHistory, body.balanceHistory, body.fundingHistory, body.equityCurve], [[], [], [], []]);
    });

    test("bad address is 400", async () => {
      assert.equal((await call(r.portfolio, `/api/portfolio/G123`, { address: "G123" })).status, 400);
    });
  });

  describe("GET /api/leaderboard", () => {
    async function stat(address: string, realizedPnl: bigint, volume: bigint) {
      await seedRow(s, "TraderStat", {
        network: TEST_NETWORK, address, period: "MONTH", periodStart: new Date(), realizedPnl, volume,
        peakEquity: 1_000_000_000n, updatedAt: new Date(),
      });
    }

    test("ranks by metric at 1e6 scale; search keeps the real rank", async () => {
      await stat(ALICE, 5_000_000n, 1_000_000n);
      await stat(BOB, 9_000_000n, 500_000n);

      const { status, body } = await call(r.leaderboard, "/api/leaderboard?period=MONTH&metric=pnl");
      assert.equal(status, 200);
      const t = body.traders as Record<string, unknown>[];
      assert.deepEqual(t.map((x) => [x.rank, x.address, x.pnl]), [[1, BOB, 9], [2, ALICE, 5]]);
      assert.equal(t[0].accountValue, 1000);
      assert.equal(body.total, 2);

      const byVolume = await call(r.leaderboard, "/api/leaderboard?metric=volume");
      assert.equal((byVolume.body.traders as Record<string, unknown>[])[0].address, ALICE);

      const search = await call(r.leaderboard, "/api/leaderboard?search=A11CE");
      assert.deepEqual((search.body.traders as Record<string, unknown>[]).map((x) => x.rank), [2]);
      assert.equal(search.body.total, 1);
    });

    test("empty leaderboard", async () => {
      const { status, body } = await call(r.leaderboard, "/api/leaderboard");
      assert.equal(status, 200);
      assert.deepEqual([body.total, body.traders], [0, []]);
    });

    test("search is a literal, not a LIKE pattern", async () => {
      await stat(ALICE, 1n, 1n);
      const { body } = await call(r.leaderboard, "/api/leaderboard?search=%25");
      assert.equal(body.total, 0);
    });
  });

  // ── Probes ─────────────────────────────────────────────────────────────────

  describe("probes", () => {
    test("ready lists active markets on the caller's network", async () => {
      await baseline();
      await seedMarket(s, { id: 3, symbol: "ETH-PERP", active: false });
      const { status, body } = await call(r.ready, "/api/ready");
      assert.equal(status, 200);
      assert.deepEqual([body.network, body.markets], [TEST_NETWORK, ["BTC-PERP"]]);
    });

    test("ready with no markets is still ready", async () => {
      const { status, body } = await call(r.ready, "/api/ready");
      assert.equal(status, 200);
      assert.deepEqual(body.markets, []);
    });

    test("health and time need no database", async () => {
      assert.equal((await call(r.health, "/api/health")).body.ok, true);
      const t = await call(r.time, "/api/time");
      assert.ok(Math.abs((t.body.unix_seconds as number) - NOW()) <= 2);
      assert.equal(t.body.max_ttl_seconds, 7 * 24 * 3600);
    });
  });

  // ── Cancel helpers (their signed routes arrive with step 3) ────────────────

  describe("best-effort cancel helpers", () => {
    test("cancel by nonce moves only a live order and is not repeatable", async () => {
      const { cancelOrderByNonce } = await import("@/lib/queries/orders");
      await baseline();
      const o = await seedOrder(s, { owner: ALICE, nonce: 11n });
      await seedOrder(s, { owner: ALICE, nonce: 12n, filledSize: E18, status: "FILLED" });

      const first = await cancelOrderByNonce(s, TEST_NETWORK, ALICE, 11n);
      assert.deepEqual(first.map((c) => c.orderHash), [o[0].orderHash]);
      assert.deepEqual(await cancelOrderByNonce(s, TEST_NETWORK, ALICE, 11n), [], "already cancelled");
      assert.deepEqual(await cancelOrderByNonce(s, TEST_NETWORK, ALICE, 12n), [], "filled stays filled");
      assert.deepEqual(await cancelOrderByNonce(s, TEST_NETWORK, BOB, 11n), [], "owner-scoped");
    });

    test("cancel-all is owner-, market- and expiry-scoped", async () => {
      const { cancelAllOrders } = await import("@/lib/queries/orders");
      await baseline();
      await seedMarket(s, { id: 3, symbol: "ETH-PERP" });
      await seedOrder(s, { owner: ALICE, marketId: 2 });
      await seedOrder(s, { owner: ALICE, marketId: 3 });
      await seedOrder(s, { owner: ALICE, marketId: 2, expiry: BigInt(NOW() - 10) });
      await seedOrder(s, { owner: BOB, marketId: 2 });
      const nowSec = BigInt(NOW());

      assert.equal((await cancelAllOrders(s, TEST_NETWORK, ALICE, 3, nowSec)).length, 1);
      assert.equal((await cancelAllOrders(s, TEST_NETWORK, ALICE, null, nowSec)).length, 1);
      const bob = await s.query(`SELECT "status" FROM "Order" WHERE "owner" = $1`, [BOB]);
      assert.equal(bob[0].status, "OPEN");
    });
  });

  // ── The seam with the matcher ──────────────────────────────────────────────

  describe("remaining size", () => {
    test("the API and the matcher's book reader agree", async () => {
      const { loadOrders } = await import("@/lib/matcher/book");
      await baseline();
      const a = await seedOrder(s, { owner: ALICE, size: 5n * E18, filledSize: E18, status: "PARTIALLY_FILLED" });
      const b = await seedOrder(s, { owner: BOB, isLong: false, size: 3n * E18, limitPrice: 101n * E18 });
      await seedFill(s, { makerOrderHash: a[0].orderHash, takerOrderHash: b[0].orderHash, size: E18 });
      await seedFill(s, { makerOrderHash: a[0].orderHash, size: E18 / 2n, rejectReason: "PriceOutsideBand" });
      await seedFill(s, { status: "SETTLED", makerOrderHash: a[0].orderHash, size: E18, blockNumber: 1n, logIndex: 0 });

      const nowSec = BigInt(NOW());
      const engine = await loadOrders(s as unknown as Query, TEST_NETWORK, 2, nowSec);
      const api = await call(r.orders, `/api/orders/list?address=${ALICE}`);
      const apiBob = await call(r.orders, `/api/orders/list?address=${BOB}`);
      const apiRemaining = new Map(
        [...(api.body.orders as Record<string, string>[]), ...(apiBob.body.orders as Record<string, string>[])].map(
          (o) => [o.order_hash, BigInt(o.remaining_size)]
        )
      );
      assert.equal(engine.length, 2);
      for (const o of engine) {
        // The engine's `filledSize` is settled + reserved; its remaining is size − that.
        assert.equal(apiRemaining.get(o.orderHash), o.size - o.filledSize, o.orderHash);
      }
      assert.equal(apiRemaining.get(String(a[0].orderHash)), 3n * E18, "5 − 1 settled − 1 pending; rejected pending ignored");
    });
  });
});
