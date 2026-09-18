// Order and cancel validation, without a database: field bounds, the OZ
// signature rules, ERC-1271 over a real HTTP JSON-RPC stub, and the
// accept/reject → contract-error map. The same checks through the route and a
// migrated Postgres are in lib/test/intake.test.ts.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEther, serializeSignature, parseSignature, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { cancelTypedData, hashOrder, orderTypedData, NO_REFERRER, type Order } from "@/lib/market/eip712";
import type { Queryable, Rows } from "@/lib/queries/client";
import {
  cancelAllTypedData,
  isErc1271Magic,
  MAX_TTL_SECONDS,
  parseOrder,
  recoverStrict,
  REJECTIONS,
  rpcErc1271Checker,
  validateCancel,
  validateCancelAll,
  validateOrderSubmission,
  type Erc1271Checker,
  type IntakeContext,
} from "./validation";

const GATEWAY = "0x0000000000000000000000000000000000C0FFEE" as Address;
const CHAIN_ID = 5042002;
const E18 = 10n ** 18n;
const NOW = 1_789_000_000n;
const MAGIC = ("0x1626ba7e" + "0".repeat(56)) as Hex;

/** The order `eip712.test.ts` pins against `OrderGateway.hashOrder`. */
const GOLDEN: Order = {
  owner: "0x1111111111111111111111111111111111111111",
  marketId: 2,
  isLong: true,
  size: parseEther("1.5"),
  limitPrice: parseEther("65000"),
  reduceOnly: false,
  nonce: 42n,
  expiry: 1790000000n,
  referrer: NO_REFERRER,
};
const GOLDEN_DIGEST = "0x3743031a08c230b780fb7de256d4133060df6d15605dd1d497e009f92b05895e";

const ALICE = privateKeyToAccount(`0x${"11".repeat(32)}`);
const MALLORY = privateKeyToAccount(`0x${"66".repeat(32)}`);

/** A `Queryable` answering the two state reads the validator makes. */
function stubDb(opts: { market?: Rows[number] | null; minValidNonce?: string } = {}): Queryable {
  const market =
    opts.market === undefined
      ? { active: true, params: { minFillNotional: (10n * E18).toString() }, configured: true }
      : opts.market;
  return {
    async query(text: string): Promise<Rows> {
      if (text.includes(`FROM "Market"`)) return market ? [market] : [];
      if (text.includes(`FROM "Account"`)) return opts.minValidNonce ? [{ minValidNonce: opts.minValidNonce }] : [];
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

const neverCalled: Erc1271Checker = async () => {
  throw new Error("ERC-1271 must not be consulted for a valid EOA signature");
};
const eoaOnly: Erc1271Checker = async () => false; // what a code-less owner answers

function ctx(over: Partial<IntakeContext> = {}): IntakeContext {
  return { network: "arc-local", chainId: CHAIN_ID, gateway: GATEWAY, nowSec: NOW, erc1271: eoaOnly, q: stubDb(), ...over };
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

async function signed(over: Partial<Order> = {}, signer = ALICE, chainId = CHAIN_ID) {
  const order: Order = { ...GOLDEN, owner: ALICE.address, expiry: NOW + 3600n, ...over };
  const signature = await signer.signTypedData(orderTypedData(chainId, GATEWAY, order));
  return { order, signature, body: wire(order, signature) };
}

// ── The golden fixture ───────────────────────────────────────────────────────

describe("golden signed order", () => {
  test("validation stores the Solidity digest from eip712.test.ts as the order hash", async () => {
    // 0x1111… has no key, so it signs as a contract wallet: the stub stands in
    // for its `isValidSignature`, and checks it is asked about the right digest.
    let askedDigest: Hex | null = null;
    const wallet: Erc1271Checker = async (owner, digest) => {
      askedDigest = digest;
      return owner === GOLDEN.owner;
    };
    const r = await validateOrderSubmission(wire(GOLDEN, "0xc0de"), ctx({ erc1271: wallet, nowSec: 1789990000n }));
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.orderHash, GOLDEN_DIGEST);
    assert.equal(askedDigest, GOLDEN_DIGEST);
    assert.equal(hashOrder(CHAIN_ID, GATEWAY, GOLDEN), GOLDEN_DIGEST, "fixture drifted from eip712.test.ts");
  });

  test("an EOA-signed order is accepted without any RPC", async () => {
    const { body, order } = await signed();
    const r = await validateOrderSubmission(body, ctx({ erc1271: neverCalled }));
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.orderHash, hashOrder(CHAIN_ID, GATEWAY, order).toLowerCase());
    assert.equal(r.order.owner, ALICE.address.toLowerCase());
  });
});

// ── Rejections, each mapped to the contract error it prevents ───────────────

describe("rejections", () => {
  async function expectCode(body: unknown, code: keyof typeof REJECTIONS, c: IntakeContext = ctx()) {
    const r = await validateOrderSubmission(body, c);
    assert.equal(r.ok, false, `expected ${code}, got acceptance`);
    if (!r.ok) {
      assert.equal(r.code, code, r.error);
      assert.equal(r.status, REJECTIONS[code].status);
      assert.equal(r.contractError, REJECTIONS[code].contractError);
    }
  }

  test("bad signature (tampered order)", async () => {
    const { order, signature } = await signed();
    await expectCode(wire({ ...order, size: order.size + 1n }, signature), "bad_signature");
  });

  test("wrong signer", async () => {
    const { order } = await signed();
    const sig = await MALLORY.signTypedData(orderTypedData(CHAIN_ID, GATEWAY, order));
    await expectCode(wire(order, sig), "bad_signature");
  });

  test("wrong chain id: explicit, and implicit through the digest", async () => {
    const { order, signature } = await signed({}, ALICE, 5042);
    await expectCode(wire(order, signature, { chainId: 5042 }), "wrong_chain");
    await expectCode(wire(order, signature), "bad_signature");
  });

  test("expired, too soon, and past the 7-day cap", async () => {
    await expectCode((await signed({ expiry: NOW - 1n })).body, "expired");
    await expectCode((await signed({ expiry: NOW + 5n })).body, "expired");
    await expectCode((await signed({ expiry: NOW + MAX_TTL_SECONDS + 1n })).body, "expiry_too_far");
    const ok = await validateOrderSubmission((await signed({ expiry: NOW + MAX_TTL_SECONDS })).body, ctx());
    assert.ok(ok.ok, "exactly MAX_ORDER_TTL is allowed");
  });

  test("nonce below Account.minValidNonce", async () => {
    await expectCode((await signed({ nonce: 9n })).body, "nonce_cancelled", ctx({ q: stubDb({ minValidNonce: "10" }) }));
    const ok = await validateOrderSubmission((await signed({ nonce: 10n })).body, ctx({ q: stubDb({ minValidNonce: "10" }) }));
    assert.ok(ok.ok, "nonce == minValidNonce is valid, as in `_consume`");
  });

  test("unknown, inactive and unparameterised markets", async () => {
    const { body } = await signed();
    await expectCode(body, "unknown_market", ctx({ q: stubDb({ market: null }) }));
    await expectCode(body, "market_inactive", ctx({ q: stubDb({ market: { active: false, params: {}, configured: true } }) }));
    await expectCode(body, "market_not_configured", ctx({ q: stubDb({ market: { active: true, params: {}, configured: false } }) }));
  });

  test("zero size or price", async () => {
    const { order, signature } = await signed();
    await expectCode(wire({ ...order, size: 0n }, signature), "invalid_field");
    await expectCode(wire({ ...order, limitPrice: 0n }, signature), "invalid_field");
  });

  test("below minFillNotional", async () => {
    // 0.0001 × 65,000 = 6.5 USDC < 10.
    await expectCode((await signed({ size: E18 / 10_000n })).body, "below_min_notional");
  });

  test("int128 overflow", async () => {
    await expectCode((await signed({ size: 2n ** 127n })).body, "overflow");
  });

  test("field bounds follow the Solidity types", () => {
    const base = wire(GOLDEN, "0x00");
    const bad: Record<string, unknown>[] = [
      { owner: zeroAddress },
      { owner: "0x123" },
      { marketId: 0 },
      { marketId: 2 ** 32 },
      { marketId: "2.5" },
      { isLong: "true" },
      { reduceOnly: 1 },
      { size: "-1" },
      { size: "1e18" },
      { size: 1.5 },
      { size: (2n ** 256n).toString() },
      { nonce: (2n ** 256n).toString() },
      { expiry: (2n ** 64n).toString() },
      { referrer: "nope" },
      { signature: "abc" },
      { signature: "0x" + "00".repeat(1025) },
      { chainId: "x" },
    ];
    for (const b of bad) {
      const r = parseOrder({ ...base, ...b });
      assert.equal(r.ok, false, JSON.stringify(b));
    }
    assert.equal(parseOrder({ ...base, referrer: undefined }).ok, true, "referrer is optional");
    assert.equal(parseOrder({ ...base, nonce: 42 }).ok, true, "safe JSON integers are accepted");
  });

  test("every rejection code has a status and a documented contract mapping", () => {
    for (const [code, row] of Object.entries(REJECTIONS)) {
      assert.ok([400, 401, 409, 413, 429, 503].includes(row.status), code);
    }
  });
});

// ── ECDSA exactly as OpenZeppelin 5.7 ─────────────────────────────────────────

describe("recoverStrict", () => {
  const digest = GOLDEN_DIGEST as Hex;

  test("recovers a canonical signature", async () => {
    const sig = await ALICE.sign({ hash: digest });
    assert.equal(await recoverStrict(digest, sig), ALICE.address.toLowerCase());
  });

  test("rejects the high-s twin (OZ InvalidSignatureS)", async () => {
    const sig = parseSignature(await ALICE.sign({ hash: digest }));
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = serializeSignature({
      r: sig.r,
      s: `0x${(N - BigInt(sig.s)).toString(16).padStart(64, "0")}`,
      yParity: sig.yParity === 0 ? 1 : 0,
    });
    assert.equal(await recoverStrict(digest, highS), null);
  });

  test("rejects v ∉ {27, 28} and non-65-byte signatures", async () => {
    const sig = await ALICE.sign({ hash: digest });
    const v01 = (sig.slice(0, 130) + (parseInt(sig.slice(130), 16) - 27).toString(16).padStart(2, "0")) as Hex;
    assert.equal(await recoverStrict(digest, v01), null);
    assert.equal(await recoverStrict(digest, sig.slice(0, 130) as Hex), null, "64-byte compact");
    assert.equal(await recoverStrict(digest, (sig + "00") as Hex), null);
  });
});

// ── ERC-1271 ────────────────────────────────────────────────────────────────

describe("ERC-1271", () => {
  const WALLET = "0x00000000000000000000000000000000000c0de1" as Address;

  test("a contract wallet is accepted when isValidSignature says so, and only then", async () => {
    const { order } = await signed({ owner: WALLET });
    const body = wire(order, "0xabcdef");
    const yes = await validateOrderSubmission(body, ctx({ erc1271: async (o) => o === WALLET }));
    assert.ok(yes.ok);
    const no = await validateOrderSubmission(body, ctx({ erc1271: async () => false }));
    assert.equal(!no.ok && no.code, "bad_signature");
  });

  test("an RPC failure rejects, never accepts", async () => {
    const { order } = await signed({ owner: WALLET });
    const r = await validateOrderSubmission(
      wire(order, "0xabcdef"),
      ctx({
        erc1271: async () => {
          throw new Error("ECONNREFUSED");
        },
      })
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "signature_unverifiable");
      assert.equal(r.status, 503);
    }
  });

  test("the magic value must fill the whole first word", () => {
    assert.equal(isErc1271Magic(MAGIC), true);
    assert.equal(isErc1271Magic("0x1626ba7e"), false, "short return data");
    assert.equal(isErc1271Magic(("0x1626ba7e" + "0".repeat(55) + "1") as Hex), false);
    assert.equal(isErc1271Magic("0x"), false);
  });

  describe("rpcErc1271Checker over HTTP", () => {
    let server: Server;
    let url = "";
    let mode: "magic" | "empty" | "revert" | "hang" | "http500" = "magic";
    let calls = 0;
    let lastGas: string | undefined;

    before(async () => {
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          calls += 1;
          const rpc = JSON.parse(raw);
          lastGas = rpc.params?.[0]?.gas;
          if (mode === "hang") return; // never answer
          if (mode === "http500") {
            res.writeHead(500).end("boom");
            return;
          }
          res.setHeader("content-type", "application/json");
          const reply =
            mode === "revert"
              ? { jsonrpc: "2.0", id: rpc.id, error: { code: 3, message: "execution reverted", data: "0x" } }
              : { jsonrpc: "2.0", id: rpc.id, result: mode === "magic" ? MAGIC : "0x" };
          res.end(JSON.stringify(reply));
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => {
      server.closeAllConnections();
      server.close();
    });

    const ask = (timeoutMs = 3000) => rpcErc1271Checker(url, timeoutMs)(WALLET, GOLDEN_DIGEST as Hex, "0xabcdef");

    test("magic → valid; empty (no code) → invalid; revert → invalid; one call each, contract gas cap", async () => {
      for (const [m, want] of [["magic", true], ["empty", false], ["revert", false]] as const) {
        mode = m;
        calls = 0;
        assert.equal(await ask(), want, m);
        assert.equal(calls, 1, `${m}: exactly one RPC call`);
        assert.equal(BigInt(lastGas!), 100_000n, "OrderLib.ERC1271_GAS_LIMIT");
      }
    });

    test("a hung or failing RPC throws within the timeout, after one call", async () => {
      for (const m of ["hang", "http500"] as const) {
        mode = m;
        calls = 0;
        const t0 = Date.now();
        await assert.rejects(ask(300), m);
        assert.ok(Date.now() - t0 < 2000, `${m} bounded by the timeout`);
        assert.equal(calls, 1, `${m}: no retries`);
      }
    });

    test("an unreachable RPC throws", async () => {
      await assert.rejects(rpcErc1271Checker("http://127.0.0.1:1", 300)(WALLET, GOLDEN_DIGEST as Hex, "0x00"));
    });
  });
});

// ── Cancels ─────────────────────────────────────────────────────────────────

describe("cancels", () => {
  const c = () => ({ network: "arc-local" as const, chainId: CHAIN_ID, gateway: GATEWAY, nowSec: NOW, erc1271: eoaOnly });

  test("a signed Cancel verifies; tampered, stale or foreign ones do not", async () => {
    const cancel = { owner: ALICE.address, nonce: 7n, deadline: NOW + 60n };
    const signature = await ALICE.signTypedData(cancelTypedData(CHAIN_ID, GATEWAY, cancel));
    const body = { owner: cancel.owner, nonce: "7", deadline: cancel.deadline.toString(), signature };

    const ok = await validateCancel(body, c());
    assert.ok(ok.ok);
    assert.equal(ok.cancel.nonce, 7n);

    const tampered = await validateCancel({ ...body, nonce: "8" }, c());
    assert.equal(!tampered.ok && tampered.code, "bad_signature");
    const stale = await validateCancel(body, { ...c(), nowSec: NOW + 61n });
    assert.equal(!stale.ok && stale.code, "expired");
    const foreign = await validateCancel({ ...body, owner: MALLORY.address }, c());
    assert.equal(!foreign.ok && foreign.code, "bad_signature");
  });

  test("CancelAll verifies within its short window only", async () => {
    const ca = { owner: ALICE.address, marketId: 0, deadline: NOW + 60n };
    const signature = await ALICE.signTypedData(cancelAllTypedData(CHAIN_ID, GATEWAY, ca));
    const body = { owner: ca.owner, marketId: 0, deadline: ca.deadline.toString(), signature };
    assert.ok((await validateCancelAll(body, c())).ok);

    const scoped = await validateCancelAll({ ...body, marketId: 2 }, c());
    assert.equal(!scoped.ok && scoped.code, "bad_signature", "marketId is signed");

    const far = { owner: ca.owner, marketId: 0, deadline: NOW + 301n };
    const farSig = await ALICE.signTypedData(cancelAllTypedData(CHAIN_ID, GATEWAY, far));
    const r = await validateCancelAll({ ...body, deadline: far.deadline.toString(), signature: farSig }, c());
    assert.equal(!r.ok && r.code, "expiry_too_far");
  });

  test("a Cancel signature is not a CancelAll signature", async () => {
    const cancel = { owner: ALICE.address, nonce: 0n, deadline: NOW + 60n };
    const signature = await ALICE.signTypedData(cancelTypedData(CHAIN_ID, GATEWAY, cancel));
    const r = await validateCancelAll({ owner: ALICE.address, marketId: 0, deadline: cancel.deadline.toString(), signature }, c());
    assert.equal(!r.ok && r.code, "bad_signature");
  });
});

// ── Junk ────────────────────────────────────────────────────────────────────

describe("fuzzed junk", () => {
  test("never throws, always a typed rejection", async () => {
    // Deterministic PRNG so a failure reproduces.
    let seed = 0x5eed;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const atoms: unknown[] = [
      null, true, false, 0, -1, 1.5, NaN, 2 ** 53, "", "0x", "0x" + "f".repeat(40), "1".repeat(100),
      "-5", "1e18", [], {}, [1, 2], { a: 1 }, " ", "𝔘", ALICE.address, "0x" + "ab".repeat(65),
    ];
    const keys = ["owner", "marketId", "isLong", "size", "limitPrice", "reduceOnly", "nonce", "expiry", "referrer", "signature", "chainId", "__proto__", "constructor"];
    const valid = (await signed()).body as Record<string, unknown>;
    for (let i = 0; i < 400; i++) {
      const body: Record<string, unknown> = rnd() < 0.5 ? { ...valid } : {};
      const n = 1 + Math.floor(rnd() * 5);
      for (let k = 0; k < n; k++) body[keys[Math.floor(rnd() * keys.length)]] = atoms[Math.floor(rnd() * atoms.length)];
      const payload = rnd() < 0.1 ? atoms[Math.floor(rnd() * atoms.length)] : body;
      const r = await validateOrderSubmission(payload, ctx());
      if (!r.ok) assert.ok(r.status < 500 || r.code === "signature_unverifiable", JSON.stringify(r));
      await validateCancel(payload, ctx());
      await validateCancelAll(payload, ctx());
    }
  });
});
