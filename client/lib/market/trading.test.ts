// What the browser signs must be exactly what the intake verifies. The wallet
// is a local viem account; the checks use the server's own hash functions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { hashCancel, hashOrder, kryonDomain, type Order } from "@/lib/market/eip712";
import { CANCEL_ALL_TYPES as SERVER_CANCEL_ALL_TYPES, hashCancelAll } from "@/lib/validation";
import {
  CANCEL_ALL_TYPES,
  allocateNonce,
  cancelAllOrders,
  cancelOrder,
  orderExpiry,
  placeOrder,
  rejectionText,
  type Domain,
  type SignTypedData,
} from "./trading";

// anvil's first dev key: public knowledge, never funded anywhere real.
const wallet = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const GATEWAY = "0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1" as Address;
const domain = kryonDomain(5042002, GATEWAY) as Domain;
const sign: SignTypedData = (args) => wallet.signTypedData(args as Parameters<typeof wallet.signTypedData>[0]);

const order: Order = {
  owner: wallet.address,
  marketId: 2,
  isLong: true,
  size: 10n ** 17n,
  limitPrice: 60_000n * 10n ** 18n,
  reduceOnly: false,
  nonce: 1_800_000_000_000n,
  expiry: 1_800_000_600n,
  referrer: "0x0000000000000000000000000000000000000000",
};

function fakeFetch(reply: { status: number; body: unknown }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test("the cancel-all type is the server's", () => {
  assert.deepEqual(CANCEL_ALL_TYPES, SERVER_CANCEL_ALL_TYPES);
});

test("placeOrder signs the Order the intake hashes, and sends decimal strings", async () => {
  const { fetcher, calls } = fakeFetch({ status: 201, body: { ok: true, orderHash: "0xabc", status: "OPEN" } });
  const r = await placeOrder({ domain, order, sign, path: "/api/orders?network=arc-local", fetcher });
  assert.deepEqual(r, { ok: true, orderHash: "0xabc", duplicate: false });
  const body = calls[0].body;
  assert.equal(body.size, "100000000000000000");
  assert.equal(body.nonce, "1800000000000");
  assert.equal(body.chainId, 5042002);
  const signer = await recoverAddress({ hash: hashOrder(5042002, GATEWAY, order), signature: body.signature as `0x${string}` });
  assert.equal(signer, wallet.address);
});

test("placeOrder turns a rejection into plain language", async () => {
  const { fetcher } = fakeFetch({ status: 409, body: { ok: false, code: "market_inactive", error: "market 2 is not active" } });
  const r = await placeOrder({ domain, order, sign, path: "/x", fetcher });
  assert.deepEqual(r, { ok: false, code: "market_inactive", message: "This market is paused and accepts no new orders." });
  const limited = await placeOrder({ domain, order, sign, path: "/x", fetcher: fakeFetch({ status: 429, body: {} }).fetcher });
  assert.equal(limited.ok === false && limited.code, "rate_limited");
});

test("cancel and cancel-all sign what the server hashes, within its windows", async () => {
  const now = 1_800_000_000n;
  const one = fakeFetch({ status: 200, body: { ok: true, cancelled: 1 } });
  assert.deepEqual(await cancelOrder({ domain, owner: wallet.address, nonce: 7n, nowSec: now, sign, path: "/c", fetcher: one.fetcher }), { ok: true });
  const c = one.calls[0].body;
  assert.equal(BigInt(String(c.deadline)) - now, 300n);
  const h1 = hashCancel(5042002, GATEWAY, { owner: wallet.address, nonce: 7n, deadline: BigInt(String(c.deadline)) });
  assert.equal(await recoverAddress({ hash: h1, signature: c.signature as `0x${string}` }), wallet.address);

  const all = fakeFetch({ status: 200, body: { ok: true, cancelled: 3 } });
  assert.deepEqual(
    await cancelAllOrders({ domain, owner: wallet.address, marketId: 0, nowSec: now, sign, path: "/ca", fetcher: all.fetcher }),
    { ok: true, cancelled: 3 }
  );
  const a = all.calls[0].body;
  assert.ok(BigInt(String(a.deadline)) - now <= 300n, "inside MAX_CANCEL_ALL_WINDOW_SECONDS");
  const h2 = hashCancelAll(5042002, GATEWAY, { owner: wallet.address, marketId: 0, deadline: BigInt(String(a.deadline)) });
  assert.equal(await recoverAddress({ hash: h2, signature: a.signature as `0x${string}` }), wallet.address);
});

test("nonces: never below the floor, never repeated, time-ordered", () => {
  assert.equal(allocateNonce({ minNonce: 0n, last: 0n, nowMs: 1_000 }), 1_000n);
  assert.equal(allocateNonce({ minNonce: 0n, last: 1_000n, nowMs: 1_000 }), 1_001n, "same millisecond");
  assert.equal(allocateNonce({ minNonce: 5_000n, last: 0n, nowMs: 1_000 }), 5_000n, "cancelUpTo floor");
});

test("expiry is capped at seven days", () => {
  assert.equal(orderExpiry(100n, 60n), 160n);
  assert.equal(orderExpiry(100n, 30n * 24n * 3600n), 100n + 7n * 24n * 3600n);
});

test("unknown codes fall back to the server's text", () => {
  assert.equal(rejectionText("brand_new", "server says"), "server says");
  assert.equal(rejectionText("brand_new"), "The order was rejected.");
});
