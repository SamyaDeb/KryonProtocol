import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";

import { applyBps, decide, depegGuard, predictAggregate, ONE, type FeedState, type PolicyOptions } from "./guards";
import type { Aggregate } from "./aggregate";

const E18 = 10n ** 18n;
const A = "0x000000000000000000000000000000000000000a" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;
const NOW = 1_000_000;

function feed(over: Partial<FeedState> = {}, cfg: Partial<FeedState["cfg"]> = {}): FeedState {
  return {
    id: "0x4254430000000000000000000000000000000000000000000000000000000000" as Hex,
    symbol: "BTC",
    cfg: {
      listed: true,
      active: true,
      minPublishers: 2,
      maxSpreadBps: 50,
      maxJumpBps: 2000,
      maxConfidenceBps: 100,
      maxAge: 15,
      ...cfg,
    },
    snapshot: { price: 100_000n * E18, confidence: 0n, publishTime: NOW - 4, writeTime: NOW - 3, sourceCount: 2 },
    observations: new Map([
      [A.toLowerCase(), { price: 100_000n * E18, confidence: 0n, publishTime: NOW - 6 }],
      [B.toLowerCase(), { price: 100_000n * E18, confidence: 0n, publishTime: NOW - 4 }],
    ]),
    reference: { enabled: false, required: false, maxDivergenceBps: 150, ok: false, price: 0n },
    ...over,
  };
}

const ok = (usd: bigint, confidence = 0n): { ok: true; value: Aggregate } => ({
  ok: true,
  value: { symbol: "BTC", price: usd * E18, confidence, used: ["a", "b"], dropped: [], oldestTs: 0 },
});

const POLICY: PolicyOptions = { deviationBps: 5n, heartbeatSecs: 5, inclusionMarginSecs: 3, maxRefDivergenceBps: 0 };
const CTX = { self: A, publishers: [A, B], publishTime: NOW - 1, chainNow: NOW };

describe("applyBps mirrors KryonMath (truncating)", () => {
  test("rounds toward zero", () => {
    assert.equal(applyBps(19_999n, 1), 1n);
    assert.equal(applyBps(10_000n, 50), 50n);
  });
});

describe("predictAggregate (mirror of OracleAdapter._aggregate)", () => {
  const obs = (usd: bigint, t = NOW - 1) => ({ price: usd * E18, confidence: 0n, publishTime: t });

  test("both publishers fresh and agreeing: update", () => {
    const p = predictAggregate(feed(), [A, B], A, obs(100_010n), NOW + 1);
    assert.equal(p.outcome, "update");
    assert.equal(p.outcome === "update" && p.median, 100_005n * E18);
  });

  test("quorum-of-one: the peer's observation is past maxAge", () => {
    const f = feed();
    f.observations.set(B.toLowerCase(), { price: 100_000n * E18, confidence: 0n, publishTime: NOW - 30 });
    const p = predictAggregate(f, [A, B], A, obs(100_000n), NOW + 1);
    assert.deepEqual([p.outcome, p.outcome === "skip" && p.reason], ["skip", "quorum"]);
  });

  test("spread: the publishers disagree beyond maxSpreadBps", () => {
    const p = predictAggregate(feed(), [A, B], A, obs(101_500n), NOW + 1);
    assert.deepEqual([p.outcome, p.outcome === "skip" && p.reason], ["skip", "spread"]);
  });

  test("jump: a fresh stored price the median moves too far from", () => {
    const f = feed({}, { maxSpreadBps: 10_000, maxJumpBps: 100 });
    const p = predictAggregate(f, [A, B], A, obs(104_000n), NOW + 1);
    assert.deepEqual([p.outcome, p.outcome === "skip" && p.reason], ["skip", "jump"]);
  });

  test("re-anchor: the same move is accepted once the stored price is stale", () => {
    const f = feed({}, { maxSpreadBps: 10_000, maxJumpBps: 100 });
    f.snapshot = { ...f.snapshot, writeTime: NOW - 60, publishTime: NOW - 61 };
    f.observations.set(B.toLowerCase(), { price: 104_000n * E18, confidence: 0n, publishTime: NOW - 2 });
    const p = predictAggregate(f, [A, B], A, obs(104_000n), NOW + 1);
    assert.equal(p.outcome, "update");
    assert.equal(p.outcome === "update" && p.reanchor, true);
  });

  test("divergence from the reference", () => {
    const f = feed({ reference: { enabled: true, required: false, maxDivergenceBps: 150, ok: true, price: 97_000n * E18 } });
    const p = predictAggregate(f, [A, B], A, obs(100_000n), NOW + 1);
    assert.deepEqual([p.outcome, p.outcome === "skip" && p.reason], ["skip", "divergence"]);
  });

  test("reference unavailable blocks only when required", () => {
    const opt = feed({ reference: { enabled: true, required: false, maxDivergenceBps: 150, ok: false, price: 0n } });
    assert.equal(predictAggregate(opt, [A, B], A, obs(100_000n), NOW + 1).outcome, "update");
    const req = feed({ reference: { enabled: true, required: true, maxDivergenceBps: 150, ok: false, price: 0n } });
    const p = predictAggregate(req, [A, B], A, obs(100_000n), NOW + 1);
    assert.deepEqual([p.outcome, p.outcome === "skip" && p.reason], ["skip", "reference-unavailable"]);
  });

  test("not monotonic: an observation older than the stored publishTime", () => {
    const f = feed();
    f.snapshot = { ...f.snapshot, publishTime: NOW - 2 };
    const p = predictAggregate(f, [A, B], A, obs(100_000n), NOW + 1);
    assert.deepEqual([p.outcome, p.outcome === "skip" && p.reason], ["skip", "not-monotonic"]);
  });

  test("observations from removed publishers never count", () => {
    const f = feed();
    const p = predictAggregate(f, [A], A, obs(100_000n), NOW + 1);
    assert.deepEqual([p.outcome, p.outcome === "skip" && p.reason], ["skip", "quorum"]);
  });
});

describe("decide", () => {
  test("publishes on a deviation", () => {
    const d = decide(feed(), ok(100_100n), CTX, POLICY);
    assert.equal(d.action, "publish");
    assert.equal(d.action === "publish" && d.why, "deviation");
  });

  test("idle when neither moved nor due", () => {
    const f = feed();
    f.observations.set(A.toLowerCase(), { price: 100_000n * E18, confidence: 0n, publishTime: NOW - 2 });
    assert.deepEqual(decide(f, ok(100_001n), CTX, POLICY), { action: "idle", reason: "not-due" });
  });

  test("heartbeat publishes an unchanged price", () => {
    const d = decide(feed(), ok(100_000n), CTX, POLICY);
    assert.equal(d.action === "publish" && d.why, "heartbeat");
  });

  test("first observation is always due", () => {
    const f = feed();
    f.observations.delete(A.toLowerCase());
    assert.equal(decide(f, ok(100_000n), CTX, POLICY).action, "publish");
  });

  test("an inactive feed is idle, not held", () => {
    assert.deepEqual(decide(feed({}, { active: false }), ok(1n), CTX, POLICY), { action: "idle", reason: "inactive" });
  });

  test("source failures hold", () => {
    const d = decide(feed(), { ok: false, error: { kind: "insufficient-sources", live: 1, required: 2 } }, CTX, POLICY);
    assert.deepEqual([d.action, d.action === "hold" && d.reason], ["hold", "sources"]);
    const e = decide(feed(), { ok: false, error: { kind: "disagreement" } }, CTX, POLICY);
    assert.equal(e.action === "hold" && e.reason, "disagreement");
  });

  test("confidence wider than getPrice would accept holds", () => {
    const d = decide(feed(), ok(100_000n, 1_001n * E18), CTX, POLICY);
    assert.equal(d.action === "hold" && d.reason, "confidence");
    assert.equal(decide(feed(), ok(100_100n, 1_000n * E18), CTX, POLICY).action, "publish");
  });

  test("divergence from Chainlink holds, using the stricter of chain and local bounds", () => {
    const ref = { enabled: true, required: false, maxDivergenceBps: 150, ok: true, price: 100_000n * E18 };
    assert.equal(decide(feed({ reference: ref }), ok(100_100n), CTX, POLICY).action, "publish");
    const strict = decide(feed({ reference: ref }), ok(100_100n), CTX, { ...POLICY, maxRefDivergenceBps: 5 });
    assert.equal(strict.action === "hold" && strict.reason, "divergence");
    const far = decide(feed({ reference: ref }), ok(102_000n), CTX, POLICY);
    assert.equal(far.action === "hold" && far.reason, "divergence");
  });

  test("publishTime: never in the future, never too close to expiry, always newer than ours", () => {
    const future = decide(feed(), ok(100_100n), { ...CTX, publishTime: NOW + 1 }, POLICY);
    assert.equal(future.action === "hold" && future.reason, "publish-time");
    const late = decide(feed(), ok(100_100n), { ...CTX, publishTime: NOW - 13 }, POLICY);
    assert.equal(late.action === "hold" && late.reason, "publish-time");
    const f = feed();
    f.observations.set(A.toLowerCase(), { price: 1n, confidence: 0n, publishTime: NOW - 1 });
    const dup = decide(f, ok(100_100n), CTX, POLICY);
    assert.equal(dup.action === "hold" && dup.reason, "publish-time");
  });

  test("a predicted quorum skip is still sent: our observation is what lets the peer reach quorum", () => {
    const f = feed();
    f.observations.set(B.toLowerCase(), { price: 100_000n * E18, confidence: 0n, publishTime: NOW - 60 });
    const d = decide(f, ok(100_100n), CTX, POLICY);
    assert.equal(d.action, "publish");
    assert.equal(d.action === "publish" && d.prediction.outcome, "skip");
  });

  test("a predicted spread skip is still sent: the peer converges on our observation", () => {
    const d = decide(feed(), ok(101_500n), CTX, POLICY);
    assert.equal(d.action, "publish");
    assert.equal(d.action === "publish" && d.prediction.outcome === "skip" && d.prediction.reason, "spread");
  });

  test("a predicted jump skip is held", () => {
    const f = feed({}, { maxSpreadBps: 10_000, maxJumpBps: 100 });
    assert.equal((d => d.action === "hold" && d.reason)(decide(f, ok(104_000n), CTX, POLICY)), "jump");
  });
});

describe("depegGuard", () => {
  const usd = (v: number) => BigInt(Math.round(v * 1e6)) * 10n ** 12n;
  test("on peg: publish", () => {
    assert.equal(depegGuard([usd(1.0001), usd(0.9999)], 100n, true).halt, false);
  });
  test("beyond the threshold: halt", () => {
    const v = depegGuard([usd(0.985), usd(0.986)], 100n, true);
    assert.equal(v.halt && v.reason, "depeg");
  });
  test("one glitching venue cannot halt on its own", () => {
    assert.equal(depegGuard([usd(1.0), usd(0.9), usd(1.0)], 100n, true).halt, false);
  });
  test("no reading at all fails closed unless told otherwise", () => {
    assert.equal((v => v.halt && v.reason)(depegGuard([], 100n, true)), "no-reading");
    assert.equal(depegGuard([], 100n, false).halt, false);
  });
  test("ONE is 1e18", () => {
    assert.equal(ONE, E18);
  });
});
