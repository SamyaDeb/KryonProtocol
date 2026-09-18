// EIP-712 order intake end to end: the real POST /api/orders, /orders/cancel
// and /orders/cancel-all handlers, a Postgres migrated with the Arc baseline,
// a local JSON-RPC stub standing in for an ERC-1271 wallet, and the matcher's
// own book reader on the far side.
//
// The seam that matters is the last describe: an order accepted here must be
// exactly the order `lib/matcher/book.ts` loads, with the remaining size the
// matcher computes.
//
// Needs KRYON_TEST_DATABASE_URL pointing at a DISPOSABLE database (see
// lib/test/pg.ts). Run:
//   KRYON_TEST_DATABASE_URL=postgresql://localhost:5432/kryon_api_test npm test

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { Query } from "@/lib/indexer/db";
import { cancelTypedData, hashOrder, orderTypedData, NO_REFERRER, type Order } from "@/lib/market/eip712";
import {
  E18,
  TEST_DATABASE_URL,
  TEST_NETWORK,
  closeRouteDb,
  createScratchDb,
  routeEnv,
  seedAccount,
  seedFill,
  seedMarket,
  type ScratchDb,
} from "./pg";

const GATEWAY = "0x0000000000000000000000000000000000C0FFEE" as Address;
/** arc-local's chain id (lib/chain/networks.ts). */
const CHAIN_ID = 5042002;
const MARKET = 2;
// Fresh keys per test (see beforeEach): the per-owner rate limit is real and
// process-wide, so reusing one owner across tests would exhaust its bucket.
let ALICE = privateKeyToAccount(generatePrivateKey());
let BOB = privateKeyToAccount(generatePrivateKey());
let MALLORY = privateKeyToAccount(generatePrivateKey());
/** A contract wallet: no key; the RPC stub answers its isValidSignature. */
const WALLET = "0x000000000000000000000000000000000000c0de" as Address;
const WALLET_SIG = "0x5afe5afe" as Hex;
const MAGIC = "0x1626ba7e" + "0".repeat(56);

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
let ipSeq = 0;
/** A fresh client IP per call, so the per-IP limiter only bites where a test means it to. */
const nextIp = () => `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

type Handler = (req: NextRequest) => Promise<Response>;

async function post(h: Handler, path: string, body: unknown, opts: { ip?: string; raw?: string } = {}) {
  const req = new NextRequest(`http://localhost${path}?network=${TEST_NETWORK}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": opts.ip ?? nextIp() },
    body: opts.raw ?? JSON.stringify(body),
  });
  const res = await h(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function wire(o: Order, signature: Hex, extra: Record<string, unknown> = {}) {
  return {
    owner: o.owner,
    marketId: o.marketId,
    isLong: o.isLong,
    size: o.size.toString(),
    limitPrice: o.limitPrice.toString(),
    reduceOnly: o.reduceOnly,
    nonce: o.nonce.toString(),
    expiry: o.expiry.toString(),
    referrer: o.referrer,
    signature,
    ...extra,
  };
}

let nonceSeq = 100n;
function makeOrder(over: Partial<Order> = {}): Order {
  nonceSeq += 1n;
  return {
    owner: ALICE.address,
    marketId: MARKET,
    isLong: true,
    size: parseEther("1.5"),
    limitPrice: parseEther("65000"),
    reduceOnly: false,
    nonce: nonceSeq,
    expiry: nowSec() + 3600n,
    referrer: NO_REFERRER,
    ...over,
  };
}

async function sign(o: Order, signer = ALICE, chainId = CHAIN_ID): Promise<Hex> {
  return signer.signTypedData(orderTypedData(chainId, GATEWAY, o));
}

describe("EIP-712 order intake", { skip: !TEST_DATABASE_URL }, () => {
  let s: ScratchDb;
  let rpc: Server;
  let rpcMode: "wallet" | "down" = "wallet";
  let rpcCalls = 0;
  let submit: Handler;
  let cancel: Handler;
  let cancelAll: Handler;

  before(async () => {
    // The ERC-1271 wallet, reached through ARC_RPC_URLS exactly as in production.
    rpc = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        rpcCalls += 1;
        if (rpcMode === "down") {
          res.writeHead(502).end();
          return;
        }
        const msg = JSON.parse(raw);
        const call = msg.params?.[0] ?? {};
        // Only WALLET has code, and it accepts exactly WALLET_SIG (the last
        // bytes of the calldata). Every other address is code-less: "0x".
        const ok = call.to?.toLowerCase() === WALLET && String(call.data).includes(WALLET_SIG.slice(2));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: ok ? MAGIC : "0x" }));
      });
    });
    await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));

    s = await createScratchDb("intake");
    routeEnv(s);
    process.env.ARC_RPC_URLS = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
    delete process.env.KRYON_DEPLOYMENT_FILE;
    delete process.env.KRYON_DEPLOYMENT_FILE_ARC_LOCAL;
    const other = "0x00000000000000000000000000000000000000a1";
    for (const k of ["VAULT", "ENGINE", "ORACLE_ADAPTER", "LIQUIDATION", "INSURANCE", "RISK_PARAMS", "FEE_ROUTER", "TIMELOCK"]) {
      process.env[`CONTRACT_${k}`] = other;
    }
    process.env.CONTRACT_ORDER_GATEWAY = GATEWAY;

    submit = (await import("@/app/api/orders/route")).POST as Handler;
    cancel = (await import("@/app/api/orders/cancel/route")).POST as Handler;
    cancelAll = (await import("@/app/api/orders/cancel-all/route")).POST as Handler;
  });

  after(async () => {
    rpc?.closeAllConnections();
    rpc?.close();
    if (!s) return;
    await closeRouteDb();
    await s.drop();
  });

  beforeEach(async () => {
    await s.reset();
    await seedMarket(s, { id: MARKET });
    ALICE = privateKeyToAccount(generatePrivateKey());
    BOB = privateKeyToAccount(generatePrivateKey());
    MALLORY = privateKeyToAccount(generatePrivateKey());
    rpcMode = "wallet";
    rpcCalls = 0;
  });

  const orderRows = () => s.query(`SELECT * FROM "Order" ORDER BY "createdAt"`);

  // ── Acceptance ─────────────────────────────────────────────────────────────

  describe("accepts", () => {
    test("an order signed by a viem test account lands in Order as OPEN, filledSize 0", async () => {
      const o = makeOrder();
      const res = await post(submit, "/api/orders", wire(o, await sign(o)));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const hash = hashOrder(CHAIN_ID, GATEWAY, o).toLowerCase();
      assert.deepEqual(res.body, { ok: true, orderHash: hash, status: "OPEN" });

      const [row] = await orderRows();
      assert.equal(row.orderHash, hash);
      assert.equal(row.network, TEST_NETWORK);
      assert.equal(row.owner, ALICE.address.toLowerCase());
      assert.equal(row.status, "OPEN");
      assert.equal(row.filledSize, "0");
      assert.equal(row.size, o.size.toString());
      assert.equal(row.nonce, o.nonce.toString());
      assert.equal(row.referrer, null, "zero referrer stored as null");
      assert.match(String(row.signature), /^0x[0-9a-f]{130}$/);
      const acct = await s.query(`SELECT * FROM "Account" WHERE "address" = $1`, [ALICE.address.toLowerCase()]);
      assert.equal(acct.length, 1, "Account created in the same statement");
      assert.equal(rpcCalls, 0, "an EOA never costs an RPC call");
    });

    test("a replayed identical order is an idempotent no-op", async () => {
      const o = makeOrder();
      const body = wire(o, await sign(o));
      assert.equal((await post(submit, "/api/orders", body)).status, 201);
      const again = await post(submit, "/api/orders", body);
      assert.equal(again.status, 200);
      assert.equal(again.body.duplicate, true);
      assert.equal((await orderRows()).length, 1);
    });

    test("a replay does not resurrect a cancelled order", async () => {
      const o = makeOrder();
      const body = wire(o, await sign(o));
      await post(submit, "/api/orders", body);
      await s.query(`UPDATE "Order" SET "status" = 'CANCELLED'`);
      assert.equal((await post(submit, "/api/orders", body)).body.duplicate, true);
      assert.equal((await orderRows())[0].status, "CANCELLED");
    });

    test("an existing account is reused, and a referrer is stored lowercase", async () => {
      await seedAccount(s, { address: ALICE.address.toLowerCase(), feeTier: 2 });
      const o = makeOrder({ referrer: BOB.address });
      assert.equal((await post(submit, "/api/orders", wire(o, await sign(o)))).status, 201);
      const [row] = await orderRows();
      assert.equal(row.referrer, BOB.address.toLowerCase());
      const [acct] = await s.query(`SELECT "feeTier" FROM "Account"`);
      assert.equal(acct.feeTier, 2, "upsert did not overwrite the account");
    });

    test("an ERC-1271 wallet is accepted after exactly one RPC call", async () => {
      const o = makeOrder({ owner: WALLET });
      const res = await post(submit, "/api/orders", wire(o, WALLET_SIG));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(rpcCalls, 1);
    });
  });

  // ── Rejections ─────────────────────────────────────────────────────────────

  describe("rejects", () => {
    async function expectReject(body: unknown, status: number, code: string, opts: { ip?: string; raw?: string } = {}) {
      const res = await post(submit, "/api/orders", body, opts);
      assert.equal(res.status, status, JSON.stringify(res.body));
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, code);
      assert.equal((await orderRows()).length, 0, "nothing stored");
      return res.body;
    }

    test("bad signature, wrong signer, wrong chain", async () => {
      const o = makeOrder();
      const sig = await sign(o);
      await expectReject(wire({ ...o, size: o.size * 2n }, sig), 401, "bad_signature");
      await expectReject(wire(o, await sign(o, MALLORY)), 401, "bad_signature");
      const foreign = await sign(o, ALICE, 5042);
      await expectReject(wire(o, foreign, { chainId: 5042 }), 400, "wrong_chain");
      await expectReject(wire(o, foreign), 401, "bad_signature");
    });

    test("expired and past the expiry cap", async () => {
      const past = makeOrder({ expiry: nowSec() - 1n });
      await expectReject(wire(past, await sign(past)), 400, "expired");
      const far = makeOrder({ expiry: nowSec() + 8n * 24n * 3600n });
      const body = await expectReject(wire(far, await sign(far)), 400, "expiry_too_far");
      assert.match(String(body.contractError), /OrderExpired/);
    });

    test("nonce below the on-chain cancelUpTo floor", async () => {
      await seedAccount(s, { address: ALICE.address.toLowerCase(), minValidNonce: 1_000_000n });
      const o = makeOrder();
      const body = await expectReject(wire(o, await sign(o)), 400, "nonce_cancelled");
      assert.match(String(body.contractError), /OrderCancelled/);
    });

    test("a different order under a used nonce", async () => {
      const o = makeOrder();
      assert.equal((await post(submit, "/api/orders", wire(o, await sign(o)))).status, 201);
      const twin = { ...o, limitPrice: o.limitPrice + 1n };
      const res = await post(submit, "/api/orders", wire(twin, await sign(twin)));
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "nonce_reused");
      assert.equal(res.body.contractError, "NonceReused");
      assert.equal((await orderRows()).length, 1);
    });

    test("unknown or inactive market", async () => {
      const unknown = makeOrder({ marketId: 9 });
      await expectReject(wire(unknown, await sign(unknown)), 400, "unknown_market");
      await s.query(`UPDATE "Market" SET "active" = false`);
      const o = makeOrder();
      await expectReject(wire(o, await sign(o)), 400, "market_inactive");
    });

    test("zero size or price", async () => {
      const o = makeOrder();
      const sig = await sign(o);
      await expectReject(wire({ ...o, size: 0n }, sig), 400, "invalid_field");
      await expectReject(wire({ ...o, limitPrice: 0n }, sig), 400, "invalid_field");
    });

    test("below the market's minFillNotional", async () => {
      const o = makeOrder({ size: E18 / 100_000n }); // 0.00001 × 65k = 0.65 < 10
      const body = await expectReject(wire(o, await sign(o)), 400, "below_min_notional");
      assert.equal(body.contractError, "FillBelowMinNotional");
    });

    test("oversized body, declared or not", async () => {
      const big = JSON.stringify({ pad: "x".repeat(5000) });
      await expectReject(null, 413, "body_too_large", { raw: big });
    });

    test("malformed JSON", async () => {
      await expectReject(null, 400, "invalid_body", { raw: "{not json" });
    });

    test("ERC-1271 RPC failure rejects with 503 and stores nothing", async () => {
      rpcMode = "down";
      const o = makeOrder({ owner: WALLET });
      await expectReject(wire(o, WALLET_SIG), 503, "signature_unverifiable");
    });

    test("rate limit: 30 a minute per owner, and per IP, before any signature work", async () => {
      const ip = "10.99.0.1";
      for (let i = 0; i < 30; i++) {
        const res = await post(submit, "/api/orders", { owner: BOB.address, junk: i }, { ip });
        assert.notEqual(res.status, 429, `request ${i + 1} limited too early`);
      }
      const limited = await post(submit, "/api/orders", { owner: BOB.address }, { ip: "10.99.0.2" });
      assert.equal(limited.status, 429, "per-owner bucket, from a fresh IP");
      const byIp = await post(submit, "/api/orders", { owner: MALLORY.address }, { ip });
      assert.equal(byIp.status, 429, "per-IP bucket, with a fresh owner");
      assert.equal(rpcCalls, 0);
    });

    test("fuzzed junk never 500s", async () => {
      let seed = 42;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const atoms = [null, 0, -1, 1e308, "", "0x", "0x00", "💥", [], {}, true, "9".repeat(80), ALICE.address];
      const keys = ["owner", "marketId", "isLong", "size", "limitPrice", "reduceOnly", "nonce", "expiry", "signature", "referrer", "chainId"];
      const o = makeOrder();
      const valid = wire(o, await sign(o)) as Record<string, unknown>;
      for (let i = 0; i < 150; i++) {
        const body: Record<string, unknown> = { ...valid };
        body[keys[Math.floor(rnd() * keys.length)]] = atoms[Math.floor(rnd() * atoms.length)];
        const raw = rnd() < 0.15 ? String(atoms[Math.floor(rnd() * atoms.length)]) : undefined;
        for (const h of [submit, cancel, cancelAll]) {
          const res = await post(h, "/api/orders", body, { raw });
          assert.ok(res.status < 500, `${res.status} for ${raw ?? JSON.stringify(body)}: ${JSON.stringify(res.body)}`);
        }
      }
    });
  });

  // ── Cancels ────────────────────────────────────────────────────────────────

  describe("signed cancels (best-effort)", () => {
    test("a signed Cancel takes the order off the book and says it is not final on chain", async () => {
      const o = makeOrder();
      await post(submit, "/api/orders", wire(o, await sign(o)));
      const c = { owner: ALICE.address, nonce: o.nonce, deadline: nowSec() + 60n };
      const signature = await ALICE.signTypedData(cancelTypedData(CHAIN_ID, GATEWAY, c));
      const body = { owner: c.owner, nonce: c.nonce.toString(), deadline: c.deadline.toString(), signature };

      const res = await post(cancel, "/api/orders/cancel", body);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.cancelled, 1);
      assert.equal(res.body.onChainFinal, false);
      assert.match(String(res.body.note), /on chain/);
      assert.equal((await orderRows())[0].status, "CANCELLED");

      const forged = await post(cancel, "/api/orders/cancel", { ...body, owner: BOB.address });
      assert.equal(forged.status, 401);
    });

    test("a Cancel signed by someone else cancels nothing", async () => {
      const o = makeOrder();
      await post(submit, "/api/orders", wire(o, await sign(o)));
      const c = { owner: ALICE.address, nonce: o.nonce, deadline: nowSec() + 60n };
      const signature = await MALLORY.signTypedData(cancelTypedData(CHAIN_ID, GATEWAY, c));
      const res = await post(cancel, "/api/orders/cancel", {
        owner: c.owner, nonce: c.nonce.toString(), deadline: c.deadline.toString(), signature,
      });
      assert.equal(res.status, 401);
      assert.equal((await orderRows())[0].status, "OPEN");
    });

    test("cancel-all, scoped by the signed marketId", async () => {
      const { cancelAllTypedData } = await import("@/lib/validation");
      await seedMarket(s, { id: 3, symbol: "ETH-PERP" });
      for (const marketId of [MARKET, MARKET, 3]) {
        const o = makeOrder({ marketId });
        assert.equal((await post(submit, "/api/orders", wire(o, await sign(o)))).status, 201);
      }
      const ca = { owner: ALICE.address, marketId: MARKET, deadline: nowSec() + 60n };
      const signature = await ALICE.signTypedData(cancelAllTypedData(CHAIN_ID, GATEWAY, ca));
      const res = await post(cancelAll, "/api/orders/cancel-all", {
        owner: ca.owner, marketId: ca.marketId, deadline: ca.deadline.toString(), signature,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.cancelled, 2);
      const open = await s.query(`SELECT "marketId" FROM "Order" WHERE "status" = 'OPEN'`);
      assert.deepEqual(open.map((r) => r.marketId), [3]);
    });
  });

  // ── The seam ───────────────────────────────────────────────────────────────

  describe("through the matcher's reader", () => {
    test("an accepted order is in loadBook with the remaining size the API reports", async () => {
      const { loadBook } = await import("@/lib/matcher/book");
      const { GET: listOrders } = await import("@/app/api/orders/list/route");

      const bid = makeOrder({ size: parseEther("2"), limitPrice: parseEther("65000") });
      const ask = makeOrder({ owner: BOB.address, isLong: false, size: parseEther("3"), limitPrice: parseEther("65100") });
      const r1 = await post(submit, "/api/orders", wire(bid, await sign(bid)));
      const r2 = await post(submit, "/api/orders", wire(ask, await sign(ask, BOB)));
      assert.deepEqual([r1.status, r2.status], [201, 201]);

      // The matcher commits 0.5 of the bid (PENDING, not yet settled).
      await seedFill(s, {
        makerOrderHash: r1.body.orderHash,
        takerOrderHash: r2.body.orderHash,
        maker: ALICE.address.toLowerCase(),
        taker: BOB.address.toLowerCase(),
        size: E18 / 2n,
      });

      const book = await loadBook(s as unknown as Query, TEST_NETWORK, MARKET, nowSec());
      const engine = new Map(book.orders.map((o) => [o.orderHash.toLowerCase(), o]));
      const b = engine.get(String(r1.body.orderHash));
      assert.ok(b, "the intake's order is in the matcher's book");
      assert.equal(b.owner, ALICE.address.toLowerCase());
      assert.equal(b.size, bid.size);
      assert.equal(b.limitPrice, bid.limitPrice);
      assert.equal(b.nonce, bid.nonce);
      assert.equal(b.size - b.filledSize, parseEther("1.5"), "matcher: 2 − 0.5 pending");

      const listed = await listOrders(
        new NextRequest(`http://localhost/api/orders/list?address=${ALICE.address}&network=${TEST_NETWORK}`)
      );
      const [apiOrder] = ((await listed.json()) as { orders: Record<string, string>[] }).orders;
      assert.equal(BigInt(apiOrder.remaining_size), b.size - b.filledSize, "API and matcher agree");

      // And the matcher can settle what the intake stored: the signed row
      // round-trips to the exact struct and digest the gateway verifies.
      const { loadSignedOrders } = await import("@/lib/matcher/book");
      const signedRows = await loadSignedOrders(s as unknown as Query, TEST_NETWORK, [r1.body.orderHash as Hex]);
      const row = signedRows.get(r1.body.orderHash as Hex)!;
      const { signature, orderHash, ...struct } = row;
      assert.equal(hashOrder(CHAIN_ID, GATEWAY, struct).toLowerCase(), orderHash);
      assert.equal(signature, (await sign(bid)).toLowerCase());
    });
  });
});
