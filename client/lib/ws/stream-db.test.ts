// The streaming server against a Postgres migrated with the Arc baseline.
//
// The point: a subscriber's book must be exactly what
// `GET /api/markets/:id/orderbook` returns for the same database state —
// remaining size, PENDING reservations subtracted, the matcher's working-order
// filter applied. If the stream and the API ever disagree, one of them is
// showing size the matcher will not trade.
//
// Needs KRYON_TEST_DATABASE_URL pointing at a DISPOSABLE database; skips
// without it. Builds and drops its own schema (lib/test/pg.ts).

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { WebSocket } from "ws";

import { createLogger, Metrics } from "@/lib/keepers/runtime";
import {
  E18,
  TEST_DATABASE_URL,
  TEST_NETWORK,
  addr,
  closeRouteDb,
  createScratchDb,
  routeEnv,
  seedAccount,
  seedFill,
  seedMarket,
  seedOrder,
  type ScratchDb,
} from "@/lib/test/pg";
import type { StreamServer as StreamServerT } from "./server";

const ALICE = addr(0xa11ce);
const BOB = addr(0xb0b);
const NOW = () => Math.floor(Date.now() / 1000);

type Msg = Record<string, unknown>;
type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

function collector(ws: WebSocket) {
  const inbox: Msg[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d)) as Msg));
  return {
    inbox,
    async next(type: string, timeoutMs = 3_000): Promise<Msg> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return inbox.splice(i, 1)[0];
        if (Date.now() > deadline) throw new Error(`no ${type}; inbox ${JSON.stringify(inbox)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    drain(type: string): Msg[] {
      const out = inbox.filter((m) => m.type === type);
      for (const m of out) inbox.splice(inbox.indexOf(m), 1);
      return out;
    },
  };
}

describe("ws stream against the Arc schema", { skip: !TEST_DATABASE_URL }, () => {
  let s: ScratchDb;
  let orderbookRoute: Handler;
  let server: StreamServerT;
  let url: string;
  const sockets: WebSocket[] = [];

  before(async () => {
    s = await createScratchDb("ws_stream");
    routeEnv(s);
    // Imported only now: `@/lib/network` fixes the allowed networks at load.
    orderbookRoute = (await import("@/app/api/markets/[id]/orderbook/route")).GET as Handler;
  });

  beforeEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    if (server) await server.close();
    await s.reset();
    await seedMarket(s);
    await seedAccount(s, { address: ALICE });
    await seedAccount(s, { address: BOB });

    const { db } = await import("@/lib/db");
    const { StreamServer } = await import("./server");
    const { dbStreamSource } = await import("./source");
    server = new StreamServer({
      network: TEST_NETWORK,
      source: dbStreamSource(db(TEST_NETWORK), TEST_NETWORK),
      log: createLogger("ws-db-test", "error", {}, () => {}),
      metrics: new Metrics(),
      limits: { marketsPollMs: 0 },
    });
    url = `ws://127.0.0.1:${await server.listen(0, "127.0.0.1")}`;
  });

  after(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    if (server) await server.close();
    if (!s) return;
    await closeRouteDb();
    await s.drop();
  });

  async function subscribe(channels: string[]) {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const c = collector(ws);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "subscribe", channels }));
    assert.deepEqual((await c.next("subscribed")).channels, channels);
    return c;
  }

  async function restBook() {
    const req = new NextRequest(`http://localhost/api/markets/2/orderbook?network=${TEST_NETWORK}`);
    const res = await orderbookRoute(req, { params: Promise.resolve({ id: "2" }) });
    assert.equal(res.status, 200);
    return (await res.json()) as { bids: unknown[]; asks: unknown[] };
  }

  test("a book update reaches the subscriber and equals the REST orderbook", async () => {
    // The route test's state: remaining sizes, a PENDING reservation, and
    // every kind of order the matcher will not trade.
    await seedAccount(s, { address: addr(0xca401), minValidNonce: 100n });
    const bid = await seedOrder(s, { owner: ALICE, isLong: true, size: 3n * E18, limitPrice: 99n * E18 });
    await seedOrder(s, { owner: BOB, isLong: true, size: E18, limitPrice: 99n * E18, filledSize: E18 / 2n, status: "PARTIALLY_FILLED" });
    await seedOrder(s, { owner: BOB, isLong: false, size: 2n * E18, limitPrice: 101n * E18 });
    await seedOrder(s, { owner: ALICE, isLong: false, limitPrice: 100n * E18, status: "CANCELLED" });
    await seedOrder(s, { owner: ALICE, isLong: false, limitPrice: 100n * E18, expiry: BigInt(NOW() - 1) });
    await seedOrder(s, { owner: addr(0xca401), isLong: false, limitPrice: 100n * E18, nonce: 5n });
    await seedFill(s, { makerOrderHash: bid[0].orderHash, size: E18 });
    await seedFill(s, { makerOrderHash: bid[0].orderHash, size: E18, rejectReason: "OrderCancelled" });

    const c = await subscribe(["orderbook:2"]);
    await server.pollOnce();
    const first = await c.next("orderbook");
    const rest1 = await restBook();
    assert.deepEqual([first.bids, first.asks], [rest1.bids, rest1.asks]);
    const lv = (l: Msg) => [l.price, l.size, l.orders];
    assert.deepEqual((first.bids as Msg[]).map(lv), [["99.0000", "2.5000", 2]]);

    // The matcher reserves another 1.5 on Alice's bid and a new ask arrives.
    await seedFill(s, { makerOrderHash: bid[0].orderHash, size: (3n * E18) / 2n });
    await seedOrder(s, { owner: ALICE, isLong: false, size: E18, limitPrice: 102n * E18 });
    await server.pollOnce();
    const second = await c.next("orderbook");
    const rest2 = await restBook();
    assert.deepEqual([second.bids, second.asks], [rest2.bids, rest2.asks]);
    assert.deepEqual((second.bids as Msg[]).map(lv), [["99.0000", "1.0000", 2]]);
    assert.deepEqual((second.asks as Msg[]).map(lv), [["101.0000", "2.0000", 1], ["102.0000", "1.0000", 1]]);

    // Nothing changed → nothing sent.
    await server.pollOnce();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(c.drain("orderbook").length, 0);
  });

  test("the tape streams settled fills only; the account stream labels PENDING", async () => {
    const tape = await subscribe(["trades:2"]);
    const alice = await subscribe([`fills:${ALICE}`]);
    await server.pollOnce(); // tape cursor at the (empty) tip; fills cursor at now

    const pending = await seedFill(s, { taker: ALICE, maker: BOB, size: E18 / 4n, takerIsBuy: true });
    await server.pollOnce();
    const p = await alice.next("fill");
    assert.equal(p.status, "PENDING");
    assert.equal(p.fill_id, pending[0].fillId);
    assert.equal(p.side, "buy");
    assert.equal(p.role, "taker");
    assert.equal(tape.drain("trade").length, 0, "a PENDING fill is not a print");

    // The indexer confirms it.
    await s.query(
      `UPDATE "Fill" SET "status" = 'SETTLED', "blockNumber" = 50, "txHash" = $2, "logIndex" = 3, "updatedAt" = now()
       WHERE "fillId" = $1`,
      [pending[0].fillId, `0x${"cd".repeat(32)}`]
    );
    await server.pollOnce();
    const settled = await alice.next("fill");
    assert.equal(settled.status, "SETTLED");
    assert.equal(settled.block_number, "50");
    const print = await tape.next("trade");
    assert.equal(print.fill_id, pending[0].fillId);
    assert.equal(print.size, "0.2500");
    assert.equal(print.side, "buy");

    // A rejection reaches the account and never the tape.
    const doomed = await seedFill(s, { taker: ALICE, maker: BOB });
    await server.pollOnce();
    assert.equal((await alice.next("fill")).status, "PENDING");
    await s.query(
      `UPDATE "Fill" SET "status" = 'REJECTED', "rejectReason" = 'OrderExpired', "updatedAt" = now() WHERE "fillId" = $1`,
      [doomed[0].fillId]
    );
    await server.pollOnce();
    const rejected = await alice.next("fill");
    assert.equal(rejected.status, "REJECTED");
    assert.equal(rejected.reject_reason, "OrderExpired");
    await server.pollOnce();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(tape.drain("trade").length, 0);
    assert.equal(alice.drain("fill").length, 0, "each transition once");
  });

  test("the tape follows chain order past block 9, not lexical order", async () => {
    // `SELECT "blockNumber"::text AS "blockNumber" … ORDER BY "blockNumber"`
    // sorts by the TEXT alias, which puts "12" before "9" and strands the
    // cursor. Ordering is by the table's own column, so this must stream both.
    const tape = await subscribe(["trades:2"]);
    await server.pollOnce();
    for (const [block, logIndex] of [
      [9, 0],
      [12, 1],
    ] as const) {
      await seedFill(s, {
        status: "SETTLED",
        blockNumber: BigInt(block),
        logIndex,
        txHash: `0x${block.toString(16).padStart(2, "0").repeat(32)}`,
      });
    }
    await server.pollOnce();
    const first = await tape.next("trade");
    const second = await tape.next("trade");
    assert.deepEqual([first.block_number, second.block_number], ["9", "12"]);
    await server.pollOnce();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(tape.drain("trade").length, 0, "the cursor advanced past the highest block");
  });

  test("markets and /healthz read the real tables", async () => {
    const c = await subscribe(["markets"]);
    const m = await c.next("markets");
    const btc = (m.markets as Msg[]).find((x) => x.market_id === 2)!;
    assert.equal(btc.symbol, "BTC-PERP");
    assert.equal(btc.mark_price, "100000.0000");

    await server.pollOnce();
    const port = new URL(url).port;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Msg).network, TEST_NETWORK);
  });
});
