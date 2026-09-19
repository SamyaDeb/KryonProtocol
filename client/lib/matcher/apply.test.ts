// Reject classification, blame and the database writes an applied receipt
// makes. The Query is a recorder, so this checks what the matcher writes as
// well as what it decides. No network except viem's local signing.
// Run: npm test

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeErrorResult, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ALL_ERRORS_ABI } from "@/lib/chain/contracts";
import { decodeRevert, type BatchResult } from "@/lib/chain/settlement";
import { orderTypedData } from "@/lib/market/eip712";
import { PRECISION } from "@/lib/market/matching-engine";
import { applyBatchResult, blameForPoison, classifyRejection, type RejectionAction } from "./apply";
import type { PlannedFill } from "./batch";
import type { Query, Row } from "./db";

const E18 = PRECISION;
const NETWORK = "arc-local";
const CHAIN_ID = 5042002;
const GATEWAY = getAddress("0x00000000000000000000000000000000000000a3");
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const NOW = 1_800_000_000n;

const MAKER_KEY = `0x${"11".repeat(32)}` as Hex;
const TAKER_KEY = `0x${"22".repeat(32)}` as Hex;
const maker = privateKeyToAccount(MAKER_KEY);
const taker = privateKeyToAccount(TAKER_KEY);

const revertOf = (name: string) => encodeErrorResult({ abi: ALL_ERRORS_ABI, errorName: name });

/** Records every statement, and answers UPDATE ... RETURNING as a hit. */
function recorder(): Query & { calls: { text: string; params: unknown[] }[] } {
  const calls: { text: string; params: unknown[] }[] = [];
  return {
    calls,
    async query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
      calls.push({ text, params });
      return (text.includes("RETURNING") ? [{ orderHash: "0x" }] : []) as unknown as T[];
    },
  };
}

function order(account: typeof maker, isLong: boolean, nonce: bigint, expiry = NOW + 3600n) {
  return {
    owner: account.address,
    marketId: 2,
    isLong,
    size: 10n * E18,
    limitPrice: 100n * E18,
    reduceOnly: false,
    nonce,
    expiry,
    referrer: ZERO,
  };
}

async function fill(
  overrides: { makerExpiry?: bigint; makerSignature?: Hex; takerSignature?: Hex; makerNonce?: bigint } = {}
) {
  const m = order(maker, false, overrides.makerNonce ?? 1n, overrides.makerExpiry ?? NOW + 3600n);
  const t = order(taker, true, 2n);
  const sign = (account: typeof maker, o: typeof m) =>
    account.signTypedData(orderTypedData(CHAIN_ID, GATEWAY, o));

  const planned: PlannedFill = {
    fillId: keccak256(toHex("fill-1")),
    maker: m,
    makerSignature: overrides.makerSignature ?? (await sign(maker, m)),
    taker: t,
    takerSignature: overrides.takerSignature ?? (await sign(taker, t)),
    size: E18,
    price: 100n * E18,
    marketId: 2,
    makerOrderHash: keccak256(toHex("maker-order")),
    takerOrderHash: keccak256(toHex("taker-order")),
    takerIsBuy: true,
    notional: 100n * E18,
  };
  return planned;
}

describe("classifyRejection", () => {
  test("a bad signature retires the order", () => {
    const action = classifyRejection("InvalidSignature", "0x");
    assert.equal(action.kind, "poison");
    assert.equal((action as Extract<RejectionAction, { kind: "poison" }>).status, "CANCELLED");
  });

  test("a lapsed expiry retires the order as EXPIRED", () => {
    const action = classifyRejection("OrderExpired", "0x");
    assert.equal((action as Extract<RejectionAction, { kind: "poison" }>).status, "EXPIRED");
  });

  test("a cancelled nonce retires the order", () => {
    assert.equal(classifyRejection("OrderCancelled", "0x").kind, "poison");
    assert.equal(classifyRejection("NonceReused", "0x").kind, "poison");
  });

  test("insufficient collateral is retryable: the trader may top up", () => {
    assert.equal(classifyRejection("InsufficientCollateral", "0x").kind, "retryable");
  });

  test("a price outside the band is retryable: the oracle moves", () => {
    assert.equal(classifyRejection("PriceOutsideBand", "0x").kind, "retryable");
  });

  test("overfilling is retryable, not poison", () => {
    // It means this matcher's accounting is behind the chain's, which the
    // indexer corrects. Retiring the order would cancel a live order over a lag.
    assert.equal(classifyRejection("OrderOverfilled", "0x").kind, "retryable");
  });

  test("a self-trade or a direction mismatch can only be a matcher bug", () => {
    assert.equal(classifyRejection("SelfTrade", "0x").kind, "matcher-bug");
    assert.equal(classifyRejection("DirectionMismatch", "0x").kind, "matcher-bug");
    assert.equal(classifyRejection("FillBelowMinNotional", "0x").kind, "matcher-bug");
  });

  test("an undecodable revert is retryable and keeps the raw data in the reason", () => {
    const action = classifyRejection(null, "0xdeadbeef");
    assert.equal(action.kind, "retryable");
    assert.match(action.reason, /0xdeadbeef/);
  });

  test("the real encoded reverts decode to the names it classifies on", () => {
    for (const name of ["InvalidSignature", "OrderExpired", "InsufficientCollateral"]) {
      assert.equal(decodeRevert(revertOf(name)).errorName, name);
    }
  });
});

describe("blameForPoison", () => {
  // A plain EOA owner has no code, so the gateway's ERC-1271 fallback answers
  // "not valid" — the default here. Contract-wallet cases override it.
  const noCode = async () => false;
  const ctx = {
    nowSec: NOW,
    chainId: CHAIN_ID,
    gateway: GATEWAY,
    minValidNonce: new Map<string, bigint>(),
    erc1271: noCode,
  };

  test("an expiry rejection blames only the lapsed side", async () => {
    const f = await fill({ makerExpiry: NOW - 1n });
    const blamed = await blameForPoison(f, { kind: "poison", reason: "OrderExpired", status: "EXPIRED" }, ctx);
    assert.deepEqual(blamed, [f.makerOrderHash]);
  });

  test("a cancel rejection blames the side below its minValidNonce", async () => {
    const f = await fill({ makerNonce: 4n });
    const blamed = await blameForPoison(
      f,
      { kind: "poison", reason: "OrderCancelled", status: "CANCELLED" },
      { ...ctx, minValidNonce: new Map([[maker.address.toLowerCase(), 5n]]) }
    );
    assert.deepEqual(blamed, [f.makerOrderHash]);
  });

  test("a signature rejection blames only the side that fails recovery", async () => {
    const f = await fill({ takerSignature: `0x${"ab".repeat(65)}` });
    const blamed = await blameForPoison(
      f,
      { kind: "poison", reason: "InvalidSignature", status: "CANCELLED" },
      ctx
    );
    assert.deepEqual(blamed, [f.takerOrderHash], "the maker's valid signature must not be blamed");
  });

  test("two valid signatures blame nobody rather than guessing", async () => {
    // ERC-1271 wallets: recovery cannot clear or convict either side.
    const f = await fill();
    const blamed = await blameForPoison(
      f,
      { kind: "poison", reason: "InvalidSignature", status: "CANCELLED" },
      ctx
    );
    assert.deepEqual(blamed, []);
  });

  test("a contract wallet whose ERC-1271 accepts its signature is not blamed for the other side", async () => {
    // The Insurance backstop's unwind orders look like this: a blob signature
    // that never recovers to the owner, but which the owner validates. Blaming
    // on recovery alone retired it whenever the counterparty was the bad one.
    const f = await fill({ makerSignature: `0x${"cd".repeat(200)}`, takerSignature: `0x${"ab".repeat(65)}` });
    const asked: Address[] = [];
    const blamed = await blameForPoison(
      f,
      { kind: "poison", reason: "InvalidSignature", status: "CANCELLED" },
      {
        ...ctx,
        // Valid for the maker (a contract wallet), not for the taker.
        erc1271: async (owner) => {
          asked.push(owner);
          return owner.toLowerCase() === f.maker.owner.toLowerCase();
        },
      }
    );
    assert.deepEqual(blamed, [f.takerOrderHash], "only the side the owner refuses is retired");
    assert.equal(asked.length, 2, "both sides that failed recovery were checked");
  });

  test("an ERC-1271 check that cannot be completed blames nobody", async () => {
    const f = await fill({ takerSignature: `0x${"ab".repeat(65)}` });
    const blamed = await blameForPoison(
      f,
      { kind: "poison", reason: "InvalidSignature", status: "CANCELLED" },
      {
        ...ctx,
        erc1271: async () => {
          throw new Error("timeout");
        },
      }
    );
    assert.deepEqual(blamed, [], "an unanswerable question must not cancel an order");
  });

  test("with no checker configured, a signature rejection blames nobody", async () => {
    const f = await fill({ takerSignature: `0x${"ab".repeat(65)}` });
    const blamed = await blameForPoison(
      f,
      { kind: "poison", reason: "InvalidSignature", status: "CANCELLED" },
      { nowSec: NOW, chainId: CHAIN_ID, gateway: GATEWAY, minValidNonce: new Map<string, bigint>() }
    );
    assert.deepEqual(blamed, []);
  });

  test("a reused nonce blames nobody: both orders look valid on their own", async () => {
    const f = await fill();
    const blamed = await blameForPoison(f, { kind: "poison", reason: "NonceReused", status: "CANCELLED" }, ctx);
    assert.deepEqual(blamed, []);
  });
});

describe("applyBatchResult", () => {
  const ctxFor = (q: Query) => ({
    q,
    network: NETWORK,
    chainId: CHAIN_ID,
    gateway: GATEWAY,
    nowSec: NOW,
    minValidNonce: new Map<string, bigint>(),
    erc1271: async () => false,
  });

  test("a settled fill is left entirely to the indexer", async () => {
    const f = await fill();
    const q = recorder();
    const result: BatchResult = {
      settled: [{ fillId: f.fillId } as never],
      rejected: [],
    };
    const applied = await applyBatchResult(ctxFor(q), [f], result);

    assert.deepEqual(applied.settled, [f.fillId]);
    assert.equal(q.calls.length, 0, "the matcher writes nothing for a settled fill");
  });

  test("a rejection records the reason without touching the fill's status", async () => {
    const f = await fill();
    const q = recorder();
    const result: BatchResult = {
      settled: [],
      rejected: [
        { fillId: f.fillId, reason: "0x", errorName: "InsufficientCollateral", errorArgs: [], logIndex: 0 },
      ],
    };
    const applied = await applyBatchResult(ctxFor(q), [f], result);

    assert.deepEqual(applied.rejected, [
      { fillId: f.fillId, reason: "InsufficientCollateral", kind: "retryable" },
    ]);
    assert.equal(q.calls.length, 1);
    assert.match(q.calls[0].text, /UPDATE "Fill" SET "rejectReason"/);
    const setClause = q.calls[0].text.slice(q.calls[0].text.indexOf("SET"), q.calls[0].text.indexOf("WHERE"));
    assert.ok(!setClause.includes('"status"'), "the matcher never writes a Fill status");
    assert.match(q.calls[0].text, /"status" = 'PENDING'/, "and only touches a row still pending");
  });

  test("a poison rejection retires the order it can blame", async () => {
    const f = await fill({ makerExpiry: NOW - 1n });
    const q = recorder();
    const result: BatchResult = {
      settled: [],
      rejected: [{ fillId: f.fillId, reason: "0x", errorName: "OrderExpired", errorArgs: [], logIndex: 0 }],
    };
    const applied = await applyBatchResult(ctxFor(q), [f], result);

    assert.deepEqual(applied.retired, [{ orderHash: f.makerOrderHash, status: "EXPIRED" }]);
    const update = q.calls.find((c) => c.text.includes('UPDATE "Order"'));
    assert.ok(update, "expected the order to be retired");
    assert.equal(update!.params[2], "EXPIRED");
  });

  test("an unblamable signature rejection retires nothing and is reported", async () => {
    const f = await fill();
    const q = recorder();
    const result: BatchResult = {
      settled: [],
      rejected: [{ fillId: f.fillId, reason: "0x", errorName: "InvalidSignature", errorArgs: [], logIndex: 0 }],
    };
    const applied = await applyBatchResult(ctxFor(q), [f], result);

    assert.deepEqual(applied.retired, []);
    assert.deepEqual(applied.unblamed, [f.fillId]);
  });

  test("a matcher-bug rejection is reported and retires nothing", async () => {
    const f = await fill();
    const q = recorder();
    const result: BatchResult = {
      settled: [],
      rejected: [{ fillId: f.fillId, reason: "0x", errorName: "SelfTrade", errorArgs: [], logIndex: 0 }],
    };
    const applied = await applyBatchResult(ctxFor(q), [f], result);

    assert.deepEqual(applied.matcherBugs, [{ fillId: f.fillId, reason: "SelfTrade" }]);
    assert.deepEqual(applied.retired, []);
  });

  test("a fill the receipt accounts for neither way is reported, not acted on", async () => {
    const f = await fill();
    const q = recorder();
    const applied = await applyBatchResult(ctxFor(q), [f], { settled: [], rejected: [] });

    assert.deepEqual(applied.unaccounted, [f.fillId]);
    assert.equal(q.calls.length, 0, "an unaccounted fill is left exactly as it is");
  });

  test("settled and rejected fills in one batch are handled independently", async () => {
    const good = await fill();
    const bad = { ...(await fill()), fillId: keccak256(toHex("fill-2")) };
    const q = recorder();
    const result: BatchResult = {
      settled: [{ fillId: good.fillId } as never],
      rejected: [
        { fillId: bad.fillId, reason: "0x", errorName: "InsufficientCollateral", errorArgs: [], logIndex: 1 },
      ],
    };
    const applied = await applyBatchResult(ctxFor(q), [good, bad], result);

    assert.deepEqual(applied.settled, [good.fillId]);
    assert.equal(applied.rejected.length, 1);
    assert.deepEqual(applied.unaccounted, []);
  });
});
