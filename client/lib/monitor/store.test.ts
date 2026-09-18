/**
 * The monitor's SQL against a real, migrated schema.
 *
 * The queries live in strings, so `tsc` cannot check them: the only proof they
 * match the schema — and that they classify rows the way the checks expect —
 * is running them. Needs `KRYON_TEST_DATABASE_URL`; skips itself without one,
 * as the other database suites do.
 */

import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import {
  E18,
  TEST_DATABASE_URL,
  TEST_NETWORK,
  addr,
  b32,
  createScratchDb,
  seedAccount,
  seedFill,
  seedMarket,
  seedOrder,
  seedPosition,
  seedRow,
  type ScratchDb,
} from "@/lib/test/pg";

import { evaluateFills, evaluateFunding, evaluateGas, evaluateNonceGaps, evaluateTxJobs } from "./checks/keepers";
import { evaluateFeesVsGas } from "./checks/infra";
import { loadMonitorConfig, usdcTo18 } from "./config";
import { MonitorStore, replicaLagSecs } from "./store";
import { writeAlert, writeStatus } from "./snapshot";
import type { MonitorSnapshotView } from "./exposition";

describe("monitor store", { skip: !TEST_DATABASE_URL }, () => {
  let db: ScratchDb;
  let store: MonitorStore;
  const cfg = loadMonitorConfig({}, []);
  const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);
  const ago = (secs: number) => new Date(NOW - secs * 1000);
  const MATCHER = addr(0x11);

  before(async () => {
    db = await createScratchDb("monitor");
    store = new MonitorStore(db, TEST_NETWORK);
  });
  after(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.reset();
  });

  const chainMarket = (marketId: number, symbol: string, fundingLastUpdate: number) => ({
    marketId,
    symbol,
    oracleId: b32(marketId) as `0x${string}`,
    active: true,
    listed: true,
    maxOracleAge: 120,
    longOi: E18,
    shortOi: E18,
    indexPrice: 100_000n * E18,
    fundingLastUpdate,
  });

  const txJob = (v: Record<string, unknown> = {}) =>
    seedRow(db, "TxJob", {
      id: `job-${Math.random().toString(36).slice(2, 10)}`,
      network: TEST_NETWORK,
      service: "matcher",
      label: "settleFills 3",
      fromAddress: MATCHER,
      toAddress: addr(0x3),
      nonce: 1,
      data: "0xabcd",
      value: 0n,
      gasLimit: 1_000_000n,
      maxFeePerGas: 100_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      rawTx: "0xdeadbeef",
      submittedHash: b32(Math.floor(Math.random() * 1e15)),
      status: "SUBMITTED",
      createdAt: ago(600),
      updatedAt: ago(600),
      ...v,
    });

  test("the indexer cursor round-trips", async () => {
    assert.equal(await store.cursor("protocol"), null);
    await seedRow(db, "BlockCursor", {
      network: TEST_NETWORK,
      stream: "protocol",
      blockNumber: 1_234n,
      blockHash: b32(1),
      updatedAt: ago(10),
    });
    const c = await store.cursor("protocol");
    assert.equal(c?.blockNumber, 1_234n);
  });

  test("a crossed book is found, with the moment both sides were on it", async () => {
    await seedMarket(db);
    await seedAccount(db);
    const nowSec = Math.floor(NOW / 1000);
    const expiry = BigInt(nowSec + 3_600);
    // Bid 100_001 arrives first, the 100_000 ask crosses it 30s later.
    await seedOrder(db, { isLong: true, limitPrice: 100_001n * E18, expiry, createdAt: ago(90) });
    await seedOrder(db, { isLong: false, limitPrice: 100_000n * E18, expiry, createdAt: ago(60) });
    const books = await store.crossedBooks(nowSec);
    assert.equal(books.length, 1);
    assert.equal(books[0].marketId, 2);
    assert.equal(books[0].bestBid, 100_001n * E18);
    assert.equal(books[0].bestAsk, 100_000n * E18);
    assert.equal(books[0].crossedSince.getTime(), ago(60).getTime());
  });

  test("an uncrossed, expired or fully filled book is not reported", async () => {
    await seedMarket(db);
    await seedAccount(db);
    const nowSec = Math.floor(NOW / 1000);
    const expiry = BigInt(nowSec + 3_600);
    await seedOrder(db, { isLong: true, limitPrice: 99_000n * E18, expiry });
    await seedOrder(db, { isLong: false, limitPrice: 100_000n * E18, expiry });
    assert.deepEqual(await store.crossedBooks(nowSec), []);

    // A crossing ask that has already expired cannot match.
    await seedOrder(db, { isLong: false, limitPrice: 98_000n * E18, expiry: BigInt(nowSec - 1) });
    assert.deepEqual(await store.crossedBooks(nowSec), []);

    // ...nor can one that is fully filled.
    await seedOrder(db, { isLong: false, limitPrice: 98_000n * E18, expiry, size: E18, filledSize: E18 });
    assert.deepEqual(await store.crossedBooks(nowSec), []);
  });

  test("pending fills are classified the way the reconciler classifies them", async () => {
    await seedMarket(db);
    await seedAccount(db);
    // A settled fill at block 50 marks how far the indexer has projected.
    await seedFill(db, { status: "SETTLED", blockNumber: 50n });

    const open = await txJob({ status: "SUBMITTED" });
    const confirmedOld = await txJob({ status: "CONFIRMED", blockNumber: 40n });
    const confirmedAhead = await txJob({ status: "CONFIRMED", blockNumber: 90n });
    const reverted = await txJob({ status: "REVERTED", blockNumber: 45n });

    await seedFill(db, { txJobId: open[0].id, createdAt: ago(600) });
    await seedFill(db, { txJobId: confirmedOld[0].id, createdAt: ago(600) });
    await seedFill(db, { txJobId: confirmedAhead[0].id, createdAt: ago(600) });
    await seedFill(db, { txJobId: reverted[0].id, createdAt: ago(600) });
    await seedFill(db, { txJobId: null, createdAt: ago(600) });
    // Too young to judge.
    await seedFill(db, { txJobId: null, createdAt: ago(5) });

    const fills = await store.pendingFills(ago(120));
    assert.equal(fills.length, 5);
    const kinds = fills.map((f) => f.kind).sort();
    assert.deepEqual(kinds, ["batch-failed", "in-flight", "indexer-lag", "never-submitted", "not-in-receipt"]);

    // The check turns those into one alert per kind, at the right severity.
    const results = evaluateFills(fills, NOW, 120);
    assert.equal(results.filter((r) => r.severity === "PAGE").length, 3);
    assert.equal(results.filter((r) => r.severity === "WARN").length, 2);
  });

  test("open transactions, their ages and nonce gaps come from TxJob", async () => {
    await txJob({ nonce: 5, status: "PENDING", createdAt: ago(600) });
    await txJob({ nonce: 7, status: "SUBMITTED", createdAt: ago(30) });
    await txJob({ nonce: 6, status: "CONFIRMED", createdAt: ago(600) }); // terminal: not open
    const jobs = await store.openJobs();
    assert.deepEqual(
      jobs.map((j) => j.nonce),
      [5, 7]
    );
    assert.equal(jobs[0].service, "matcher");
    assert.equal(jobs[0].fromAddress, MATCHER.toLowerCase());

    // Only the 600s-old one is past the 300s threshold.
    const stuck = evaluateTxJobs(jobs, NOW, 300);
    assert.equal(stuck.length, 1);
    assert.equal(stuck[0].values.oldestNonce, 5);

    // Nonce 6 is CONFIRMED but the chain has not mined past 5 yet: 6 is not a
    // gap, 5 is in flight. With the chain at 5, the open set {5,7} gaps at 6.
    const gaps = evaluateNonceGaps(jobs, new Map([[MATCHER.toLowerCase(), 5]]));
    assert.equal(gaps[0].status, "fail");
    assert.equal(gaps[0].values.gaps, 1);
  });

  test("fill outcomes over a window group rejections by reason class", async () => {
    await seedMarket(db);
    await seedAccount(db);
    await seedFill(db, { status: "SETTLED", blockNumber: 1n, updatedAt: ago(60) });
    await seedFill(db, { status: "REJECTED", rejectReason: "AccountInsolvent", updatedAt: ago(60) });
    await seedFill(db, { status: "REJECTED", rejectReason: "AccountInsolvent(0x01)", updatedAt: ago(60) });
    await seedFill(db, { status: "REJECTED", rejectReason: "OrderExpired", updatedAt: ago(60) });
    // Outside the window.
    await seedFill(db, { status: "REJECTED", rejectReason: "StaleOracle", updatedAt: ago(5_000) });

    const out = await store.fillOutcomes(ago(900));
    assert.equal(out.settled, 1);
    assert.deepEqual([...out.rejected.entries()].sort(), [
      ["AccountInsolvent", 2],
      ["OrderExpired", 1],
    ]);
  });

  test("funding freshness reads the block time of the latest FundingUpdate", async () => {
    await seedMarket(db, { id: 2, symbol: "BTC-PERP", active: true });
    await seedMarket(db, { id: 3, symbol: "ETH-PERP", active: true, oracleId: b32(0xe7c) });
    await seedMarket(db, { id: 4, symbol: "SOL-PERP", active: false, oracleId: b32(0x501) });

    const chainNow = Math.floor(NOW / 1000);
    const fundingAt = async (marketId: number, secsAgo: number, n: number) => {
      const txHash = b32(0xf0000 + n);
      await seedRow(db, "ProtocolEvent", {
        network: TEST_NETWORK,
        blockNumber: BigInt(100 + n),
        blockHash: b32(n),
        blockTimestamp: ago(secsAgo),
        txHash,
        logIndex: 0,
        contract: addr(0x2),
        eventName: "FundingUpdated",
        topic0: b32(0xabc),
        args: {},
      });
      await seedRow(db, "FundingUpdate", {
        network: TEST_NETWORK,
        marketId,
        longIndex: 0n,
        shortIndex: 0n,
        ratePerHour: 0n,
        premium: 0n,
        mark: 0n,
        index: 0n,
        blockNumber: BigInt(100 + n),
        txHash,
        logIndex: 0,
      });
    };
    // Block order and time order agree, as they do on a real chain: the
    // latest block for the market is the one that counts.
    await fundingAt(2, 5_000, 1);
    await fundingAt(2, 1_800, 2);
    await fundingAt(3, 4_000, 3);

    const rows = await store.funding();
    const byMarket = new Map(rows.map((x) => [x.marketId, x.lastAt]));
    // The latest row per market wins, and the join carries the block time.
    assert.equal(byMarket.get(2)!.getTime(), ago(1_800).getTime());
    assert.equal(byMarket.get(3)!.getTime(), ago(4_000).getTime());
    assert.equal(byMarket.get(4), null);

    // The verdict comes from chain state; the indexed row rides along as a value.
    const markets = [
      chainMarket(2, "BTC", chainNow - 1_800),
      chainMarket(3, "ETH", chainNow - 4_000),
    ];
    const results = evaluateFunding(markets, byMarket, chainNow, 3_600);
    assert.equal(results.find((r) => r.subject === "BTC")!.status, "pass");
    const eth = results.find((r) => r.subject === "ETH")!;
    assert.equal(eth.status, "fail");
    assert.equal(eth.values.ageSecs, 4_000);
    assert.equal(eth.values.indexedAgeSecs, 4_000);
  });

  test("position holders exclude the backstop, and the backstop's own legs are readable", async () => {
    await seedMarket(db);
    const insurance = addr(0x6);
    await seedAccount(db, { address: addr(0xa11ce) });
    await seedAccount(db, { address: insurance });
    await seedPosition(db, { trader: addr(0xa11ce), size: E18 });
    await seedPosition(db, { trader: insurance, size: -2n * E18, openNotional: 200_000n * E18 });

    assert.deepEqual(await store.positionHolders(insurance), [addr(0xa11ce)]);
    const legs = await store.positionsOf(insurance);
    assert.equal(legs.length, 1);
    assert.equal(legs[0].size, -2n * E18);
  });

  test("fees and gas are summed per UTC day and compared in the same units", async () => {
    await seedMarket(db);
    await seedRow(db, "FeeAccrual", {
      network: TEST_NETWORK,
      marketId: 2,
      payer: addr(0xa11ce),
      amount: 4n * E18,
      toTreasury: 0n,
      toInsurance: 0n,
      toReferral: 0n,
      blockNumber: 1n,
      txHash: b32(0xfee1),
      logIndex: 0,
      createdAt: ago(60),
    });
    await seedRow(db, "GasSpend", {
      network: TEST_NETWORK,
      day: "2026-09-19",
      service: "matcher",
      fromAddress: MATCHER,
      txCount: 3,
      gasUsed: 1n,
      costWei: 9n * E18,
      updatedAt: ago(60),
    });
    const days = await store.feesAndGas(["2026-09-18", "2026-09-19"]);
    assert.deepEqual(
      days.map((d) => [d.day, d.fees, d.gas]),
      [
        ["2026-09-18", 0n, 0n],
        ["2026-09-19", 4n * E18, 9n * E18],
      ]
    );
    const r = evaluateFeesVsGas(days, usdcTo18(1))[0];
    assert.equal(r.status, "fail");
    assert.match(r.detail, /gas \$9\.00 > fees \$4\.00/);
  });

  test("the cost of a key's next transaction comes from its recent jobs", async () => {
    await txJob({ gasLimit: 500_000n, maxFeePerGas: 100_000_000_000n }); // $0.05
    await txJob({ gasLimit: 2_000_000n, maxFeePerGas: 100_000_000_000n }); // $0.20 → the bound
    const costs = await store.nextTxCost([MATCHER]);
    assert.equal(costs.get(MATCHER.toLowerCase()), 2_000_000n * 100_000_000_000n);

    // A key holding less than that pages, whatever the floor says.
    const balances = new Map([[MATCHER.toLowerCase(), 100_000_000_000_000_000n]]); // $0.10
    const g = evaluateGas([{ name: "matcher", address: MATCHER as `0x${string}` }], balances, costs, cfg.gas);
    assert.equal(g[0].severity, "PAGE");
  });

  test("queued timelock operations and active deployment artifacts are read", async () => {
    await seedRow(db, "GovernanceOperation", {
      network: TEST_NETWORK,
      operationId: b32(0x0f1),
      predecessor: b32(0),
      salt: b32(0),
      calls: [{ target: addr(0x1), value: "0", data: "0x" }],
      delaySeconds: 172_800n,
      readyAt: new Date(NOW + 172_800_000),
      status: "SCHEDULED",
      scheduledTxHash: b32(0x51),
      updatedAt: ago(10),
    });
    await seedRow(db, "GovernanceOperation", {
      network: TEST_NETWORK,
      operationId: b32(0x0f2),
      predecessor: b32(0),
      salt: b32(0),
      calls: [],
      delaySeconds: 172_800n,
      readyAt: new Date(NOW),
      status: "EXECUTED",
      scheduledTxHash: b32(0x52),
      updatedAt: ago(10),
    });
    const ops = await store.pendingGovernance();
    assert.equal(ops.length, 1);
    assert.equal(ops[0].operationId, b32(0x0f1));

    const artifact = (v: Record<string, unknown>) =>
      seedRow(db, "DeploymentArtifact", {
        network: TEST_NETWORK,
        contractName: "Vault",
        proxy: addr(0x1),
        implementation: addr(0x11),
        codeHash: b32(0xc0de),
        gitCommit: "abc123",
        arcForgeVersion: "v0.8.0-1",
        deployBlock: 1n,
        txHash: b32(0xd1),
        manifest: {},
        active: true,
        ...v,
      });
    await artifact({ implementation: addr(0x10), active: false });
    await artifact({});
    const impls = await store.deploymentArtifacts();
    assert.equal(impls.get(addr(0x1).toLowerCase())?.implementation, addr(0x11).toLowerCase());
  });

  test("oracle runs report how long a price has been identical", async () => {
    const snap = (price: bigint, writeTime: number, n: number) =>
      seedRow(db, "OracleSnapshot", {
        network: TEST_NETWORK,
        oracleId: b32(0xb7c),
        price,
        confidence: 0n,
        publishTime: BigInt(writeTime),
        writeTime: BigInt(writeTime),
        sourceCount: 1,
        blockNumber: BigInt(n),
        txHash: b32(0x5a00 + n),
        logIndex: 0,
      });
    const t = Math.floor(NOW / 1000);
    await snap(100_000n * E18, t - 5_000, 1);
    await snap(101_000n * E18, t - 4_000, 2); // last change
    await snap(101_000n * E18, t - 3_000, 3);
    await snap(101_000n * E18, t - 100, 4);

    const runs = await store.oracleRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].price, 101_000n * E18);
    assert.equal(runs[0].updates, 3);
    // The run starts when the price first took this value, not at the last update.
    assert.equal(runs[0].flatSince, t - 4_000);
  });

  test("the status snapshot and the alert log are written", async () => {
    const view: MonitorSnapshotView = {
      network: TEST_NETWORK,
      level: "PAGE",
      tickAt: NOW,
      tickDurationMs: 120,
      results: [
        {
          key: "vault.solvency",
          check: "vault.solvency",
          subject: null,
          status: "fail",
          severity: "PAGE",
          detail: "INSOLVENT",
          values: { surplusUsd: -5 },
          runbook: "solvency.md",
        },
      ],
      firing: [
        {
          key: "vault.solvency",
          check: "vault.solvency",
          subject: null,
          severity: "PAGE",
          firing: true,
          failStreak: 2,
          passStreak: 0,
          firstFailedAt: NOW - 60_000,
          lastNotifiedAt: NOW,
          detail: "INSOLVENT",
        },
      ],
    };
    await writeStatus(db, view);
    await writeStatus(db, { ...view, level: "WARN" }); // upsert: still one row
    const rows = await db.query(`SELECT "network", "level"::text AS level, "firing", "tickDurationMs" FROM "MonitorStatus"`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].level, "WARN");
    assert.equal((rows[0].firing as { key: string }[])[0].key, "vault.solvency");

    await writeAlert(db, TEST_NETWORK, {
      kind: "firing",
      key: "oracle.freshness:BTC",
      check: "oracle.freshness",
      subject: "BTC",
      severity: "PAGE",
      detail: "BTC STALE",
      values: { ageSecs: 300 },
      runbook: "oracle-failure.md",
      since: NOW - 90_000,
      forSecs: 90,
    });
    const alerts = await db.query(`SELECT "alertKey", "event"::text AS event, "severity"::text AS severity, "forSecs" FROM "MonitorAlert"`);
    assert.deepEqual(alerts, [{ alertKey: "oracle.freshness:BTC", event: "FIRING", severity: "PAGE", forSecs: 90 }]);
  });

  test("replica lag reads as null on a primary", async () => {
    assert.equal(await replicaLagSecs(db), null);
  });
});
