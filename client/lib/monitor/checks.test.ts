/**
 * Every check at both sides of its threshold, against fixed inputs.
 *
 * The clock is always injected. A check that read `Date.now()` would pass here
 * and then alert (or fail to) an hour later in production for reasons no test
 * could reproduce.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { zeroHash, type Address, type Hex } from "viem";

import type { AccountHealth } from "@/lib/chain/collateral";
import type { ProtocolContracts } from "@/lib/chain/networks";
import type { FeedState, OracleState } from "@/lib/oracle/publisher";

import type { InsuranceState, MarketState } from "./chain";
import { loadMonitorConfig, usdcTo18, type MonitorConfig } from "./config";
import {
  evaluateCrossed,
  evaluateFills,
  evaluateFunder,
  evaluateFunding,
  evaluateGas,
  evaluateIndexer,
  evaluateLiquidation,
  evaluateNonceGaps,
  evaluateRejections,
  evaluateTxJobs,
} from "./checks/keepers";
import {
  evaluateApi,
  evaluateDb,
  evaluateFeesVsGas,
  evaluateReplica,
  evaluateRpc,
  evaluateWs,
} from "./checks/infra";
import { evaluateDivergence, evaluateFlatline, evaluateFreshness, evaluateQuorum } from "./checks/oracle";
import {
  evaluateBackstop,
  evaluateCaps,
  evaluateCoverage,
  evaluateImplCheck,
  evaluatePaused,
  evaluateRoleCheck,
  evaluateShortfall,
  evaluateSolvency,
  evaluateTimelock,
  evaluateUtilization,
  openInterestNotional,
} from "./checks/protocol";
import { CHECKS } from "./registry";
import { invariantRoles, parseRoleBaseline, type RoleMembership } from "./roles";
import { reasonClass, type OpenJob, type PendingFill } from "./store";
import type { CheckResult } from "./types";

const E18 = 10n ** 18n;
const cfg: MonitorConfig = loadMonitorConfig({}, ["http://one", "http://two"]);
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const b32 = (s: string) => `0x${Buffer.from(s).toString("hex").padEnd(64, "0")}` as Hex;

const CONTRACTS: ProtocolContracts = {
  vault: addr(1),
  engine: addr(2),
  orderGateway: addr(3),
  oracleAdapter: addr(4),
  liquidation: addr(5),
  insurance: addr(6),
  riskParams: addr(7),
  feeRouter: addr(8),
  timelock: addr(9),
};

const only = (rs: CheckResult[], key: string) => rs.find((r) => r.key === key)!;
const statuses = (rs: CheckResult[]) => rs.map((r) => `${r.key}=${r.status}`).sort();

// ─── solvency and insurance ─────────────────────────────────────────────────

test("solvency is exact: one wei short is a failure", () => {
  assert.equal(evaluateSolvency({ assets: 1000n * E18, liabilities: 1000n * E18 })[0].status, "pass");
  const short = evaluateSolvency({ assets: 1000n * E18 - 1n, liabilities: 1000n * E18 })[0];
  assert.equal(short.status, "fail");
  assert.equal(short.severity, "PAGE");
  assert.match(short.detail, /INSOLVENT: liabilities exceed assets by 1 wei/);
});

const insurance = (o: Partial<InsuranceState> = {}): InsuranceState => ({
  unfundedShortfall: 0n,
  marked: 100_000n * E18,
  priced: true,
  badDebt: 0n,
  ...o,
});

test("an unfunded shortfall pages, and an unpriceable one is never read as zero", () => {
  assert.equal(evaluateShortfall(insurance())[0].status, "pass");
  assert.equal(evaluateShortfall(insurance({ unfundedShortfall: 1n }))[0].status, "fail");
  const blocked = evaluateShortfall(insurance({ unfundedShortfall: null }))[0];
  assert.equal(blocked.status, "fail");
  assert.match(blocked.detail, /cannot be priced/);
  assert.equal(blocked.values.shortfallUsd, null);
});

test("insurance coverage compares the operating balance with open-interest notional", () => {
  const markets = [market({ marketId: 2, symbol: "BTC", longOi: 10n * E18, shortOi: 10n * E18, indexPrice: 100_000n * E18 })];
  // $1m of OI. 20% floor → $200k.
  assert.equal(openInterestNotional(markets).total, 1_000_000n * E18);
  assert.equal(evaluateCoverage(insurance({ marked: 200_000n * E18 }), markets, 2_000)[0].status, "pass");
  const low = evaluateCoverage(insurance({ marked: 199_999n * E18 }), markets, 2_000)[0];
  assert.equal(low.status, "fail");
  assert.equal(low.severity, "WARN");
  assert.equal(evaluateCoverage(insurance(), [], 2_000)[0].status, "skip");
});

test("an unpriceable market is excluded from coverage, not counted as zero", () => {
  const markets = [
    market({ marketId: 2, symbol: "BTC", longOi: E18, shortOi: E18, indexPrice: null }),
    market({ marketId: 3, symbol: "ETH", longOi: E18, shortOi: E18, indexPrice: 1_000n * E18 }),
  ];
  const { total, unpriced } = openInterestNotional(markets);
  assert.deepEqual(unpriced, ["BTC"]);
  assert.equal(total, 1_000n * E18);
  assert.match(evaluateCoverage(insurance(), markets, 2_000)[0].detail, /unpriced: BTC/);
  // Nothing priceable at all is an error, not a pass.
  assert.equal(evaluateCoverage(insurance(), [markets[0]], 2_000)[0].status, "error");
});

test("backstop exposure warns above its threshold and prices each leg at the index", () => {
  const markets = [market({ marketId: 2, symbol: "BTC", indexPrice: 100_000n * E18 })];
  const pos = [{ marketId: 2, size: E18 / 10n, openNotional: 9_000n * E18 }];
  const ok = evaluateBackstop(pos, markets, usdcTo18(20_000));
  assert.equal(ok[0].status, "pass");
  assert.equal(ok[0].values.notionalUsd, 10_000);
  assert.equal(ok[0].values.unrealizedPnlUsd, 1_000);
  assert.equal(evaluateBackstop(pos, markets, usdcTo18(9_999))[0].status, "fail");
  assert.equal(evaluateBackstop([], markets, 0n)[0].status, "pass");
});

// ─── caps, pauses ───────────────────────────────────────────────────────────

const caps = { totalCap: 250_000_000_000n, perAccountCap: 10_000_000_000n, totalDeposited: 0n };

test("deposit caps: drift pages, and no configured expectation warns rather than passing", () => {
  const expected = { expectedTotalCap: 250_000_000_000n, expectedAccountCap: 10_000_000_000n, utilizationWarnBps: 9_000 };
  assert.equal(evaluateCaps(caps, expected)[0].status, "pass");
  const drifted = evaluateCaps({ ...caps, totalCap: 500_000_000_000n }, expected)[0];
  assert.equal(drifted.status, "fail");
  assert.equal(drifted.severity, "PAGE");
  const unset = evaluateCaps(caps, { expectedTotalCap: null, expectedAccountCap: null, utilizationWarnBps: 9_000 })[0];
  assert.equal(unset.status, "fail");
  assert.equal(unset.severity, "WARN");
  assert.match(unset.detail, /no expected caps are configured/);
});

test("cap utilization warns at the threshold and skips when uncapped or closed", () => {
  assert.equal(evaluateUtilization({ totalCap: 1_000n, totalDeposited: 899n }, 9_000)[0].status, "pass");
  assert.equal(evaluateUtilization({ totalCap: 1_000n, totalDeposited: 900n }, 9_000)[0].status, "fail");
  assert.equal(evaluateUtilization({ totalCap: 0n, totalDeposited: 0n }, 9_000)[0].status, "skip");
  assert.equal(evaluateUtilization({ totalCap: 1n << 255n, totalDeposited: 1n }, 9_000)[0].status, "skip");
});

test("a paused contract is named", () => {
  assert.equal(evaluatePaused({ vault: false, engine: false })[0].status, "pass");
  const p = evaluatePaused({ vault: false, engine: true, liquidation: true })[0];
  assert.equal(p.status, "fail");
  assert.match(p.detail, /paused: engine, liquidation/);
});

// ─── roles and implementations ──────────────────────────────────────────────

function fullMembership(o: Partial<RoleMembership> = {}): RoleMembership {
  const inv = invariantRoles(CONTRACTS);
  const out: RoleMembership = {};
  for (const [c, roles] of Object.entries(inv)) {
    out[c] = Object.fromEntries(Object.entries(roles).map(([r, m]) => [r, m.map((x) => x.toLowerCase())]));
  }
  for (const [c, roles] of Object.entries(o)) out[c] = { ...out[c], ...roles };
  return out;
}

test("role invariants hold without any configuration, and a grant is drift", () => {
  const clean = fullMembership();
  const passed = evaluateRoleCheck(clean, CONTRACTS, parseRoleBaseline(JSON.stringify(clean)))[0];
  assert.equal(passed.status, "pass");

  const granted = fullMembership({ vault: { UPGRADER_ROLE: [addr(0xbad).toLowerCase()] } });
  const drift = evaluateRoleCheck(granted, CONTRACTS, null)[0];
  assert.equal(drift.status, "fail");
  assert.equal(drift.severity, "PAGE");
  assert.match(drift.detail, /ROLE DRIFT/);
  assert.match(drift.detail, /vault\.UPGRADER_ROLE/);
});

test("an extra admin holder alongside the timelock is drift", () => {
  const two = fullMembership({ engine: { DEFAULT_ADMIN_ROLE: [CONTRACTS.timelock.toLowerCase(), addr(0xe0a).toLowerCase()] } });
  assert.equal(evaluateRoleCheck(two, CONTRACTS, null)[0].status, "fail");
});

test("service roles without a baseline warn rather than pass", () => {
  const withService = fullMembership({ oracleAdapter: { PUBLISHER_ROLE: [addr(0x5).toLowerCase()] } });
  const warn = evaluateRoleCheck(withService, CONTRACTS, null)[0];
  assert.equal(warn.status, "fail");
  assert.equal(warn.severity, "WARN");
  assert.match(warn.detail, /unverified/);

  // With the baseline, the same state passes; changing the key is drift.
  const baseline = parseRoleBaseline(JSON.stringify(withService));
  assert.equal(evaluateRoleCheck(withService, CONTRACTS, baseline)[0].status, "pass");
  const rotated = fullMembership({ oracleAdapter: { PUBLISHER_ROLE: [addr(0x6).toLowerCase()] } });
  const rotatedResult = evaluateRoleCheck(rotated, CONTRACTS, baseline)[0];
  assert.equal(rotatedResult.severity, "PAGE");
  assert.equal(rotatedResult.status, "fail");
});

test("implementation drift pages; a missing record only warns", () => {
  const actual = new Map([[CONTRACTS.vault.toLowerCase(), { implementation: addr(0x11).toLowerCase(), codeHash: zeroHash }]]);
  const artifacts = new Map([
    [CONTRACTS.vault.toLowerCase(), { implementation: addr(0x11).toLowerCase(), codeHash: zeroHash, source: "DeploymentArtifact" as const }],
  ]);
  assert.equal(evaluateImplCheck(CONTRACTS, actual, artifacts, new Map())[0].status, "pass");

  const upgraded = new Map([[CONTRACTS.vault.toLowerCase(), { implementation: addr(0x99).toLowerCase(), codeHash: zeroHash }]]);
  const drift = evaluateImplCheck(CONTRACTS, upgraded, artifacts, new Map())[0];
  assert.equal(drift.severity, "PAGE");
  assert.match(drift.detail, /IMPLEMENTATION DRIFT/);

  const none = evaluateImplCheck(CONTRACTS, actual, new Map(), new Map())[0];
  assert.equal(none.severity, "WARN");
  assert.match(none.detail, /no expected implementations/);
});

test("a changed code hash at the same address is drift", () => {
  const actual = new Map([[CONTRACTS.vault.toLowerCase(), { implementation: addr(0x11).toLowerCase(), codeHash: `0x${"11".repeat(32)}` }]]);
  const artifacts = new Map([
    [CONTRACTS.vault.toLowerCase(), { implementation: addr(0x11).toLowerCase(), codeHash: `0x${"22".repeat(32)}`, source: "DeploymentArtifact" as const }],
  ]);
  assert.match(evaluateImplCheck(CONTRACTS, actual, artifacts, new Map())[0].detail, /code hash/);
});

test("each queued timelock operation gets its own alert key", () => {
  const now = Date.UTC(2026, 8, 19, 12);
  assert.equal(evaluateTimelock([], now)[0].status, "pass");
  const ops = evaluateTimelock(
    [
      { operationId: `0x${"a".repeat(64)}`, readyAt: new Date(now + 48 * 3_600_000), delaySeconds: 172_800n, description: "raise cap" },
      { operationId: `0x${"b".repeat(64)}`, readyAt: new Date(now - 3_600_000), delaySeconds: 172_800n, description: null },
    ],
    now
  );
  assert.equal(ops.length, 2);
  assert.notEqual(ops[0].key, ops[1].key);
  assert.match(ops[0].detail, /executable in 48\.0h \(eta 2026-09-21T12:00:00\.000Z\): raise cap/);
  assert.match(ops[1].detail, /executable since 60m/);
});

// ─── oracle ─────────────────────────────────────────────────────────────────

function market(o: Partial<MarketState> = {}): MarketState {
  return {
    marketId: 2,
    symbol: "BTC",
    oracleId: b32(o.symbol ?? "BTC"),
    active: true,
    listed: true,
    maxOracleAge: 120,
    longOi: E18,
    shortOi: E18,
    indexPrice: 100_000n * E18,
    fundingLastUpdate: 999_000,
    ...o,
  };
}

function feed(symbol: string, o: { age?: number; minPublishers?: number; price?: bigint; ref?: Partial<FeedState["reference"]> } = {}): FeedState {
  const chainNow = 1_000_000;
  const age = o.age ?? 5;
  return {
    id: b32(symbol),
    symbol,
    cfg: { listed: true, active: true, minPublishers: o.minPublishers ?? 1, maxSpreadBps: 50, maxJumpBps: 2000, maxConfidenceBps: 100, maxAge: 120 },
    snapshot: { price: o.price ?? 100_000n * E18, confidence: 0n, publishTime: chainNow - age, writeTime: chainNow - age, sourceCount: 1 },
    observations: new Map([[addr(0x5a).toLowerCase(), { price: o.price ?? 100_000n * E18, confidence: 0n, publishTime: chainNow - age }]]),
    reference: { enabled: false, required: false, maxDivergenceBps: 150, ok: false, price: 0n, ...o.ref },
  };
}

function oracleState(feeds: FeedState[], o: Partial<OracleState> = {}): OracleState {
  return { paused: false, publishers: [addr(0x5a)], feeds, chainNow: 1_000_000, ...o };
}

test("oracle freshness alerts at half the market's bound and pages once past it", () => {
  const markets = [market({ symbol: "BTC", maxOracleAge: 120 })];
  // 59s of a 120s bound: under the 60s alert point.
  assert.equal(only(evaluateFreshness(markets, oracleState([feed("BTC", { age: 59 })]), 0.5), "oracle.freshness:BTC").status, "pass");
  const warning = only(evaluateFreshness(markets, oracleState([feed("BTC", { age: 61 })]), 0.5), "oracle.freshness:BTC");
  assert.equal(warning.status, "fail");
  assert.match(warning.detail, /before it blocks withdrawals/);
  const stale = only(evaluateFreshness(markets, oracleState([feed("BTC", { age: 121 })]), 0.5), "oracle.freshness:BTC");
  assert.match(stale.detail, /STALE/);
  assert.match(stale.detail, /withdrawals are blocked/);
});

test("freshness uses the older of publishTime and writeTime, like the adapter", () => {
  const f = feed("BTC", { age: 5 });
  f.snapshot.publishTime = f.snapshot.writeTime - 200; // published long before it landed
  const r = only(evaluateFreshness([market({ symbol: "BTC" })], oracleState([f]), 0.5), "oracle.freshness:BTC");
  assert.equal(r.status, "fail");
  assert.equal(r.values.ageSecs, 205);
});

test("one stale feed does not hide the other seven", () => {
  const symbols = ["BTC", "ETH", "SOL", "XRP", "ADA", "BNB", "TRX", "XLM"];
  const markets = symbols.map((s, i) => market({ marketId: i + 1, symbol: s }));
  const feeds = symbols.map((s) => feed(s, { age: s === "SOL" ? 300 : 5 }));
  const results = evaluateFreshness(markets, oracleState(feeds), 0.5);
  assert.equal(results.length, 8);
  assert.equal(results.filter((r) => r.status === "fail").length, 1);
  const bad = only(results, "oracle.freshness:SOL");
  assert.match(bad.detail, /SOL STALE/);
  // Each healthy feed keeps its own passing result, by name.
  for (const s of symbols.filter((x) => x !== "SOL")) {
    assert.equal(only(results, `oracle.freshness:${s}`).status, "pass", s);
  }
});

test("a market with no open interest is skipped, not passed", () => {
  const idle = evaluateFreshness([market({ symbol: "BTC", longOi: 0n, shortOi: 0n })], oracleState([feed("BTC", { age: 9_999 })]), 0.5);
  assert.equal(only(idle, "oracle.freshness:BTC").status, "skip");
});

test("a paused adapter fails freshness on its own subject", () => {
  const rs = evaluateFreshness([market({ symbol: "BTC" })], oracleState([feed("BTC")], { paused: true }), 0.5);
  assert.equal(only(rs, "oracle.freshness:adapter").status, "fail");
});

test("quorum counts only publishers whose observation is still fresh", () => {
  const f = feed("BTC", { minPublishers: 2 });
  f.observations.set(addr(0x5b).toLowerCase(), { price: 1n, confidence: 0n, publishTime: 1_000_000 - 5 });
  const state = oracleState([f], { publishers: [addr(0x5a), addr(0x5b)] });
  assert.equal(only(evaluateQuorum([market({ symbol: "BTC" })], state), "oracle.quorum:BTC").status, "pass");

  // The second publisher's observation expires: the next update cannot aggregate.
  f.observations.set(addr(0x5b).toLowerCase(), { price: 1n, confidence: 0n, publishTime: 1_000_000 - 500 });
  const short = only(evaluateQuorum([market({ symbol: "BTC" })], state), "oracle.quorum:BTC");
  assert.equal(short.status, "fail");
  assert.equal(short.values.freshPublishers, 1);
});

test("divergence alerts before the on-chain halt, and reports a required-but-absent reference", () => {
  const near = feed("BTC", { price: 101_200n * E18, ref: { enabled: true, ok: true, price: 100_000n * E18, maxDivergenceBps: 150 } });
  const r = only(evaluateDivergence([market({ symbol: "BTC" })], oracleState([near]), 0.75), "oracle.divergence:BTC");
  assert.equal(r.status, "fail"); // 120 bps ≥ 112 (0.75 × 150), and still below the 150 halt
  assert.equal(r.values.divergenceBps, 120);

  const ok = feed("BTC", { price: 100_500n * E18, ref: { enabled: true, ok: true, price: 100_000n * E18, maxDivergenceBps: 150 } });
  assert.equal(only(evaluateDivergence([market({ symbol: "BTC" })], oracleState([ok]), 0.75), "oracle.divergence:BTC").status, "pass");

  const required = feed("BTC", { ref: { enabled: true, required: true, ok: false } });
  assert.match(only(evaluateDivergence([market({ symbol: "BTC" })], oracleState([required]), 0.75), "oracle.divergence:BTC").detail, /will halt/);
  assert.equal(only(evaluateDivergence([market({ symbol: "BTC" })], oracleState([feed("BTC")]), 0.75), "oracle.divergence:BTC").status, "skip");
});

test("a price that has not moved for an implausible interval warns", () => {
  const state = oracleState([feed("BTC")]);
  const runs = [{ oracleId: b32("BTC").toLowerCase(), price: 100_000n * E18, flatSince: state.chainNow - 3_500, updates: 40 }];
  assert.equal(only(evaluateFlatline([market({ symbol: "BTC" })], state, runs, 3_600), "oracle.flatline:BTC").status, "pass");
  const flat = [{ ...runs[0], flatSince: state.chainNow - 3_601 }];
  assert.equal(only(evaluateFlatline([market({ symbol: "BTC" })], state, flat, 3_600), "oracle.flatline:BTC").status, "fail");
  // One update is not evidence of a stuck source.
  const single = [{ ...flat[0], updates: 1 }];
  assert.equal(only(evaluateFlatline([market({ symbol: "BTC" })], state, single, 3_600), "oracle.flatline:BTC").status, "pass");
});

// ─── keepers and settlement ─────────────────────────────────────────────────

test("indexer lag fails on either seconds or blocks, and on a missing cursor", () => {
  const head = { number: 1_000n, timestamp: 5_000 };
  assert.equal(evaluateIndexer({ blockNumber: 999n }, head, 4_990, cfg.indexer)[0].status, "pass");
  assert.equal(evaluateIndexer({ blockNumber: 999n }, head, 4_900, cfg.indexer)[0].status, "fail"); // 100s > 60s
  assert.equal(evaluateIndexer({ blockNumber: 800n }, head, 4_999, cfg.indexer)[0].status, "fail"); // 200 blocks > 120
  const missing = evaluateIndexer(null, head, null, cfg.indexer)[0];
  assert.equal(missing.status, "fail");
  assert.equal(missing.severity, "PAGE");
});

test("a book that stays crossed past the limit warns, per market", () => {
  const now = Date.UTC(2026, 8, 19, 12);
  const book = { marketId: 2, bestBid: 100_001n * E18, bestAsk: 100_000n * E18, crossedSince: new Date(now - 30_000) };
  assert.equal(only(evaluateCrossed([book], now, 60), "matcher.crossed-book:market-2").status, "pass");
  assert.equal(only(evaluateCrossed([{ ...book, crossedSince: new Date(now - 61_000) }], now, 60), "matcher.crossed-book:market-2").status, "fail");
  assert.equal(evaluateCrossed([], now, 60)[0].status, "pass");
});

test("pending fills: self-healing kinds warn, the rest page", () => {
  const now = Date.UTC(2026, 8, 19, 12);
  const fill = (kind: PendingFill["kind"], n: number): PendingFill => ({
    fillId: `0x${n.toString(16).padStart(64, "0")}`,
    marketId: 2,
    kind,
    createdAt: new Date(now - 300_000),
  });
  assert.equal(evaluateFills([], now, 120)[0].status, "pass");
  const rs = evaluateFills([fill("indexer-lag", 1), fill("batch-failed", 2), fill("not-in-receipt", 3), fill("in-flight", 4), fill("never-submitted", 5)], now, 120);
  assert.deepEqual(
    Object.fromEntries(rs.map((r) => [r.subject, r.severity])),
    { "indexer-lag": "WARN", "in-flight": "WARN", "batch-failed": "PAGE", "not-in-receipt": "PAGE", "never-submitted": "PAGE" }
  );
});

const job = (o: Partial<OpenJob> = {}): OpenJob => ({
  id: "job-1",
  service: "matcher",
  fromAddress: addr(0x11).toLowerCase(),
  nonce: 7,
  label: "settleFills 3",
  status: "SUBMITTED",
  createdAt: new Date(Date.UTC(2026, 8, 19, 11, 55)),
  ...o,
});

test("an unreconciled transaction pages once it is older than the threshold, per key", () => {
  const now = Date.UTC(2026, 8, 19, 12);
  assert.equal(evaluateTxJobs([job({ createdAt: new Date(now - 60_000) })], now, 300)[0].status, "pass");
  const stuck = evaluateTxJobs([job({ createdAt: new Date(now - 301_000) })], now, 300);
  assert.equal(stuck[0].status, "fail");
  assert.equal(stuck[0].severity, "PAGE");
  assert.match(stuck[0].detail, /nonce 7, "settleFills 3"/);
  // Two keys, two alerts.
  const two = evaluateTxJobs(
    [job({ createdAt: new Date(now - 400_000) }), job({ service: "oracle", fromAddress: addr(0x22).toLowerCase(), createdAt: new Date(now - 400_000) })],
    now,
    300
  );
  assert.equal(two.length, 2);
});

test("a nonce gap below an in-flight job pages", () => {
  const key = addr(0x11).toLowerCase();
  const jobs = [job({ nonce: 5 }), job({ nonce: 7 })];
  assert.equal(evaluateNonceGaps(jobs, new Map([[key, 5]]))[0].status, "fail"); // 6 missing
  assert.equal(evaluateNonceGaps([job({ nonce: 5 }), job({ nonce: 6 })], new Map([[key, 5]]))[0].status, "pass");
});

test("the rejection rate needs a sample before it fires", () => {
  const rejected = new Map([["AccountInsolvent", 3]]);
  assert.equal(evaluateRejections({ settled: 2, rejected }, cfg.rejections)[0].status, "pass"); // 5 < minSample 10
  const hot = evaluateRejections({ settled: 5, rejected: new Map([["AccountInsolvent", 5]]) }, cfg.rejections)[0];
  assert.equal(hot.status, "fail"); // 50% > 20%
  assert.equal(hot.values["reason.AccountInsolvent"], 5);
  assert.equal(evaluateRejections({ settled: 19, rejected: new Map([["OrderExpired", 1]]) }, cfg.rejections)[0].status, "pass");
  assert.equal(reasonClass("OrderExpired(0x1234)"), "OrderExpired");
  assert.equal(reasonClass(""), "unknown");
});

test("funding freshness is judged on chain state, in chain seconds, per market", () => {
  const chainNow = 1_000_000;
  const markets = [
    market({ marketId: 2, symbol: "BTC", fundingLastUpdate: chainNow - 3_500 }),
    market({ marketId: 3, symbol: "ETH", fundingLastUpdate: chainNow - 3_601 }),
    market({ marketId: 4, symbol: "SOL", fundingLastUpdate: 0 }),
    market({ marketId: 5, symbol: "XRP", active: false, fundingLastUpdate: 0 }),
  ];
  const rs = evaluateFunding(markets, new Map(), chainNow, 3_600);
  assert.equal(only(rs, "funding.freshness:BTC").status, "pass");
  assert.match(only(rs, "funding.freshness:ETH").detail, /funding is being lost/);
  assert.equal(only(rs, "funding.freshness:SOL").status, "fail");
  assert.match(only(rs, "funding.freshness:SOL").detail, /never been initialised.*holds open interest/);
  assert.equal(rs.length, 3, "an inactive market is not watched");
});

test("a freshly listed market that has never traded is skipped, not paged", () => {
  // Every new venue starts here: funding has no clock because nothing has been
  // charged, and there is no exposure to charge. Paging for that would page
  // on-call at the moment the market opens.
  const chainNow = 1_000_000;
  const rs = evaluateFunding(
    [market({ symbol: "SOL", fundingLastUpdate: 0, longOi: 0n, shortOi: 0n })],
    new Map(),
    chainNow,
    3_600
  );
  assert.equal(only(rs, "funding.freshness:SOL").status, "skip");
  assert.match(only(rs, "funding.freshness:SOL").detail, /never traded/);
});

test("a market whose funding clock started without an indexed event still passes", () => {
  // The first trade sets fundingState.lastUpdate with no FundingUpdated log,
  // which an indexer-only check reports as "never updated".
  const chainNow = 1_000_000;
  const rs = evaluateFunding([market({ symbol: "BTC", fundingLastUpdate: chainNow - 60 })], new Map([[2, null]]), chainNow, 3_600);
  assert.equal(only(rs, "funding.freshness:BTC").status, "pass");
  assert.equal(only(rs, "funding.freshness:BTC").values.indexedAgeSecs, null);
});

test("a liquidatable or unpriceable account pages; a healthy book passes", () => {
  const health = (o: Partial<AccountHealth>): AccountHealth => ({
    collateralValue: 0n,
    unrealizedPnl: 0n,
    equity: 100n * E18,
    initialMarginRequired: 0n,
    maintenanceMarginRequired: 50n * E18,
    freeCollateral: 0n,
    marginRatio: 0n,
    liquidatable: false,
    ...o,
  });
  assert.equal(evaluateLiquidation(new Map([[addr(0xa1), health({})]]))[0].status, "pass");
  const under = evaluateLiquidation(
    new Map([
      [addr(0xa1), health({})],
      [addr(0xa2), health({ liquidatable: true, equity: 10n * E18, maintenanceMarginRequired: 60n * E18 })],
    ])
  )[0];
  assert.equal(under.status, "fail");
  assert.equal(under.values.liquidatable, 1);
  assert.equal(under.values.worstShortfallUsd, 50);
  const blocked = evaluateLiquidation(new Map([[addr(0xa3), null]]))[0];
  assert.match(blocked.detail, /blocked on a stale price/);
});

test("gas: WARN under the refill floor, PAGE under the cost of the next transaction", () => {
  const targets = [{ name: "matcher", address: addr(0x11) }];
  const bal = (v: number) => new Map([[addr(0x11).toLowerCase(), usdcTo18(v)]]);
  const noCost = new Map<string, bigint>();
  assert.equal(only(evaluateGas(targets, bal(6), noCost, cfg.gas), "gas.balance:matcher").status, "pass");
  const warn = only(evaluateGas(targets, bal(4), noCost, cfg.gas), "gas.balance:matcher");
  assert.equal(warn.severity, "WARN");
  assert.match(warn.detail, /keeper-refill has not topped it up/);
  const page = only(evaluateGas(targets, bal(0.5), noCost, cfg.gas), "gas.balance:matcher");
  assert.equal(page.severity, "PAGE");

  // A key whose next transaction costs $3 pages at $3, not at the $1 floor.
  const costly = new Map([[addr(0x11).toLowerCase(), usdcTo18(3)]]);
  const byCost = only(evaluateGas(targets, bal(2), costly, cfg.gas), "gas.balance:matcher");
  assert.equal(byCost.severity, "PAGE");
  assert.equal(byCost.values.pageBelowUsd, 3);

  const none = evaluateGas([], new Map(), noCost, cfg.gas)[0];
  assert.equal(none.severity, "WARN");
  assert.match(none.detail, /no service keys configured/);
});

test("the refill funder is watched by address, and skipped when not configured", () => {
  assert.equal(evaluateFunder(null, null, usdcTo18(100))[0].status, "skip");
  assert.equal(evaluateFunder(addr(0x33), usdcTo18(100), usdcTo18(100))[0].status, "pass");
  assert.equal(evaluateFunder(addr(0x33), usdcTo18(99), usdcTo18(100))[0].status, "fail");
});

// ─── economics and infrastructure ───────────────────────────────────────────

test("fees versus gas ignores dust days and flags a below-cost day", () => {
  const min = usdcTo18(1);
  const days = [
    { day: "2026-09-18", fees: usdcTo18(10), gas: usdcTo18(4) },
    { day: "2026-09-19", fees: usdcTo18(1), gas: usdcTo18(2) },
  ];
  assert.equal(evaluateFeesVsGas(days, min)[0].status, "fail");
  assert.match(evaluateFeesVsGas(days, min)[0].detail, /2026-09-19/);
  // Gas below the floor is noise, not a finding.
  assert.equal(evaluateFeesVsGas([{ day: "2026-09-19", fees: 0n, gas: usdcTo18(0.5) }], min)[0].status, "pass");
});

test("RPC: the fallback being in use is itself the alert", () => {
  const ok = [{ url: "http://one", ok: true, latencyMs: 40 }];
  assert.equal(evaluateRpc(ok, 2_000)[0].status, "pass");
  const fallback = [
    { url: "http://one", ok: false, latencyMs: null, error: "ECONNREFUSED" },
    { url: "http://two", ok: true, latencyMs: 80 },
  ];
  const r = evaluateRpc(fallback, 2_000)[0];
  assert.equal(r.status, "fail");
  assert.match(r.detail, /serving from fallback/);
  assert.equal(r.values.servingIndex, 1);
  assert.match(evaluateRpc([{ url: "http://one", ok: false, latencyMs: null, error: "boom" }], 2_000)[0].detail, /every RPC endpoint is down/);
  assert.equal(evaluateRpc([{ url: "http://one", ok: true, latencyMs: 2_001 }], 2_000)[0].status, "fail");
});

test("database latency, replica lag, API and WS", () => {
  assert.equal(evaluateDb(1_999, 2_000)[0].status, "pass");
  assert.equal(evaluateDb(2_001, 2_000)[0].status, "fail");

  assert.equal(evaluateReplica(false, null, 30)[0].status, "skip");
  assert.equal(evaluateReplica(true, 29, 30)[0].status, "pass");
  assert.equal(evaluateReplica(true, 31, 30)[0].status, "fail");
  assert.match(evaluateReplica(true, null, 30)[0].detail, /not a replica/);

  assert.equal(evaluateApi(null, null, null)[0].status, "skip");
  assert.equal(evaluateApi("http://app", 200, null)[0].status, "pass");
  assert.equal(evaluateApi("http://app", 503, null)[0].severity, "PAGE");
  assert.equal(evaluateApi("http://app", null, "ECONNREFUSED")[0].status, "fail");

  // Unconfigured is a visible skip, never a silent pass.
  const unset = evaluateWs(null, null)[0];
  assert.equal(unset.status, "skip");
  assert.match(unset.detail, /not set/);
  assert.equal(evaluateWs("ws://localhost:8080", null)[0].status, "pass");
  assert.match(evaluateWs("ws://localhost:8080", "no pong within 5000ms")[0].detail, /did not answer a ping/);
});

// ─── configuration ──────────────────────────────────────────────────────────

test("the gas thresholds cannot be configured to contradict each other", () => {
  assert.throws(() => loadMonitorConfig({ MONITOR_GAS_PAGE_USDC: "10", MONITOR_GAS_WARN_USDC: "5" }, []), /must be below/);
  assert.throws(() => loadMonitorConfig({ MONITOR_FUNDING_STALE_SECS: "7200" }, []), /must be <= 3600/);
  assert.throws(() => loadMonitorConfig({ MONITOR_ORACLE_STALE_FRACTION: "2" }, []), /in \(0, 1]/);
  // The gas floor follows keeper-refill's floor unless told otherwise.
  assert.equal(loadMonitorConfig({ REFILL_FLOOR_USDC: "25" }, []).gas.warnBelow, usdcTo18(25));
  assert.deepEqual(loadMonitorConfig({ REFILL_TARGETS: "matcher:0x1111111111111111111111111111111111111111" }, []).gas.targets, [
    { name: "matcher", address: "0x1111111111111111111111111111111111111111" },
  ]);
});

test("every check result carries a runbook and a stable key", () => {
  const all: CheckResult[] = [
    ...evaluateSolvency({ assets: 0n, liabilities: 1n }),
    ...evaluateShortfall(insurance({ unfundedShortfall: 1n })),
    ...evaluateFreshness([market({ symbol: "BTC" })], oracleState([feed("BTC", { age: 999 })]), 0.5),
  ];
  for (const r of all) {
    assert.ok(r.runbook.endsWith(".md"), `${r.key} has no runbook`);
    assert.ok(r.key.startsWith(r.check), r.key);
  }
  assert.deepEqual(statuses(evaluateSolvency({ assets: 1n, liabilities: 1n })), ["vault.solvency=pass"]);
});

test("every check names a runbook that exists, and every PAGE check has one written for it", () => {
  const dir = join(process.cwd(), "..", "kryon-protocol", "infra", "deploy", "runbooks");
  const present = new Set(readdirSync(dir));
  assert.ok(present.size > 5, `no runbooks found in ${dir}`);
  for (const c of CHECKS) {
    assert.ok(c.runbook.endsWith(".md"), `${c.id} has no runbook`);
    assert.ok(existsSync(join(dir, c.runbook)), `${c.id} names a runbook that does not exist: ${c.runbook}`);
  }
  // Ids are unique, so alert keys cannot collide.
  assert.equal(new Set(CHECKS.map((c) => c.id)).size, CHECKS.length);
  // Every check describes its threshold for the registry table.
  for (const c of CHECKS) assert.ok(c.threshold(cfg).length > 0, c.id);
});
