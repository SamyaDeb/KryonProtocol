import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type Address,
  type Log,
  type TransactionReceipt,
} from "viem";

import { ALL_ERRORS_ABI, engineAbi } from "@/lib/chain/contracts";
import type { TxJob } from "@/lib/chain/tx-store";
import type { TxOutcome, TxRequest } from "@/lib/chain/tx-sender";
import type { SqlClient } from "@/lib/sql";

import {
  FundingKeeper,
  classifyFundingRevert,
  orderDue,
  planFunding,
  type MarketFunding,
} from "./funding";
import { KeeperActions, Metrics, createLogger } from "./runtime";

const ENGINE = "0x00000000000000000000000000000000000000ee" as Address;
const SELF = "0x000000000000000000000000000000000000000f" as Address;
const NOW = 10_000_000;

const mkt = (marketId: number, lastUpdate: number, active = true): MarketFunding => ({
  marketId,
  active,
  lastUpdate,
  longIndex: 0n,
  shortIndex: 0n,
  ratePerHour: 0n,
});

describe("planFunding", () => {
  test("due at the threshold, not before", () => {
    const [a, b] = planFunding([mkt(1, NOW - 3300), mkt(2, NOW - 3299)], NOW, 3300);
    assert.equal(a.action, "update");
    assert.deepEqual(b, { marketId: 2, action: "skip", reason: "not-due" });
  });

  test("equal timestamps are skipped, never sent: a same-second call would consume the TWAP", () => {
    assert.deepEqual(planFunding([mkt(1, NOW)], NOW, 3300)[0], { marketId: 1, action: "skip", reason: "same-timestamp" });
    // A chain clock behind lastUpdate (a reorg, a lagging RPC) is the same case.
    assert.equal((planFunding([mkt(1, NOW + 5)], NOW, 3300)[0] as { reason: string }).reason, "same-timestamp");
  });

  test("a missed hour is one update with the shortfall reported, not a catch-up", () => {
    const [p] = planFunding([mkt(1, NOW - 9000)], NOW, 3300);
    assert.deepEqual(p, { marketId: 1, action: "update", elapsed: 9000, shortfallSecs: 5400, first: false });
  });

  test("an hour exactly is charged in full, with no shortfall", () => {
    assert.equal((planFunding([mkt(1, NOW - 3600)], NOW, 3300)[0] as { shortfallSecs: number }).shortfallSecs, 0);
  });

  test("the first update starts the clock", () => {
    assert.deepEqual(planFunding([mkt(1, 0)], NOW, 3300)[0], {
      marketId: 1,
      action: "update",
      elapsed: 0,
      shortfallSecs: 0,
      first: true,
    });
  });

  test("inactive markets are skipped", () => {
    assert.equal((planFunding([mkt(1, 0, false)], NOW, 3300)[0] as { reason: string }).reason, "inactive");
  });
});

describe("orderDue", () => {
  test("first-ever updates, then most overdue", () => {
    const order = orderDue(planFunding([mkt(1, NOW - 3400), mkt(2, 0), mkt(3, NOW - 7000), mkt(4, NOW - 10)], NOW, 3300));
    assert.deepEqual(order.map((p) => p.marketId), [2, 3, 1]);
  });
});

describe("classifyFundingRevert", () => {
  test("oracle, role, pause and config classes", () => {
    assert.equal(classifyFundingRevert("StaleOracle"), "oracle");
    assert.equal(classifyFundingRevert("OracleConfidenceTooWide"), "oracle");
    assert.equal(classifyFundingRevert("AccessControlUnauthorizedAccount"), "not-keeper");
    assert.equal(classifyFundingRevert("EnforcedPause"), "paused");
    assert.equal(classifyFundingRevert("InvalidConfig"), "config");
    assert.equal(classifyFundingRevert(null), "unknown");
  });
});

// ─── the keeper ─────────────────────────────────────────────────────────────

function fundingLog(marketId: number): Log {
  const args = { marketId, longIndex: 5n, shortIndex: -5n, ratePerHour: 7n, premium: 1n, mark: 2n, index: 3n };
  const topics = encodeEventTopics({ abi: engineAbi, eventName: "FundingUpdated", args } as never);
  const ev = engineAbi.find((x) => x.type === "event" && x.name === "FundingUpdated") as unknown as {
    inputs: { name: string; type: string; indexed?: boolean }[];
  };
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed as never, nonIndexed.map((i) => (args as Record<string, unknown>)[i.name]) as never);
  return { address: ENGINE, topics, data } as unknown as Log;
}

let markets: MarketFunding[];
let paused: boolean;
let hasRole: boolean;
let submitted: TxRequest[];
let submitError: Error | null;
let receiptLogs: Log[];
let receiptStatus: "success" | "reverted";
let statuses: string[];
let logs: { level: string; msg: string }[];
let stuck: boolean;

function keeper(maxPerTick = 5) {
  const sql = {
    query: async (text: string, params: unknown[] = []) => {
      if (text.startsWith("UPDATE")) statuses.push(String(params.find((p) => typeof p === "string" && /^[A-Z]+$/.test(p))));
      return text.startsWith("INSERT") ? [{ id: "1" }] : [];
    },
  } as unknown as SqlClient;
  return new FundingKeeper({
    chain: { read: async () => ({ chainNow: NOW, paused, hasRole, markets }) },
    sender: {
      address: SELF,
      submit: async (req) => {
        if (submitError) throw submitError;
        submitted.push(req);
        return { id: "job" } as TxJob;
      },
      wait: async (job): Promise<TxOutcome> => {
        if (stuck && job.id === "stuck") throw new Error("timeout");
        return { job, receipt: { status: receiptStatus, logs: receiptLogs, blockNumber: 9n } as unknown as TransactionReceipt };
      },
      openJobs: async () => (stuck ? [{ id: "stuck", nonce: 3, createdAt: new Date() } as TxJob] : []),
    },
    engine: ENGINE,
    log: createLogger("t", "debug", {}, (l) => logs.push(JSON.parse(l))),
    metrics: new Metrics(),
    actions: new KeeperActions(sql, "arc-local"),
    dueAfterSecs: 3300,
    maxPerTick,
  });
}

beforeEach(() => {
  markets = [mkt(1, NOW - 3400)];
  paused = false;
  hasRole = true;
  submitted = [];
  submitError = null;
  receiptLogs = [fundingLog(1)];
  receiptStatus = "success";
  statuses = [];
  logs = [];
  stuck = false;
});

describe("FundingKeeper.tick", () => {
  test("sends one updateFunding and confirms on the FundingUpdated event", async () => {
    const r = await keeper().tick();
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].to, ENGINE);
    assert.equal(r.results.get(1)?.outcome, "confirmed");
    assert.deepEqual(statuses, ["SUBMITTED", "CONFIRMED"]);
  });

  test("a successful receipt without the event is not a confirmation", async () => {
    receiptLogs = [fundingLog(2)];
    const r = await keeper().tick();
    assert.equal(r.results.get(1)?.outcome, "reverted");
    assert.equal(statuses.at(-1), "FAILED");
  });

  test("an on-chain revert fails the action", async () => {
    receiptStatus = "reverted";
    assert.equal((await keeper().tick()).results.get(1)?.outcome, "reverted");
    assert.equal(statuses.at(-1), "FAILED");
  });

  test("a stale oracle in pre-flight: reported, nothing sent, retried next tick", async () => {
    submitError = Object.assign(new Error("x"), { data: encodeErrorResult({ abi: ALL_ERRORS_ABI, errorName: "StaleOracle" } as never) });
    const k = keeper();
    const r = await k.tick();
    assert.deepEqual(r.results.get(1), { outcome: "preflight", detail: { errorName: "StaleOracle", cls: "oracle" } });
    assert.ok(logs.some((l) => l.msg.includes("stale oracle")));
    submitError = null;
    assert.equal((await k.tick()).results.get(1)?.outcome, "confirmed");
  });

  test("paused: idle", async () => {
    paused = true;
    assert.equal((await keeper().tick()).status, "paused");
    assert.equal(submitted.length, 0);
  });

  test("no KEEPER_ROLE: alert, nothing sent", async () => {
    hasRole = false;
    assert.equal((await keeper().tick()).status, "not-keeper");
    assert.equal(submitted.length, 0);
    assert.ok(logs.some((l) => l.level === "error"));
  });

  test("a pending update from an earlier tick blocks a new one", async () => {
    stuck = true;
    assert.equal((await keeper().tick()).status, "in-flight");
    assert.equal(submitted.length, 0);
    stuck = false;
    assert.equal((await keeper().tick()).status, "ran");
  });

  test("nothing due: idle", async () => {
    markets = [mkt(1, NOW - 60)];
    assert.equal((await keeper().tick()).status, "idle");
  });

  test("at most maxPerTick updates, most overdue first", async () => {
    markets = [mkt(1, NOW - 3400), mkt(2, NOW - 5000), mkt(3, NOW - 3500)];
    receiptLogs = [fundingLog(1), fundingLog(2), fundingLog(3)];
    await keeper(2).tick();
    assert.equal(submitted.length, 2);
  });

  test("a missed hour logs the shortfall", async () => {
    markets = [mkt(1, NOW - 9000)];
    await keeper().tick();
    assert.ok(logs.some((l) => l.level === "warn" && l.msg.startsWith("funding shortfall")));
  });

  test("refuses a due-age that would lose time on every update", () => {
    assert.throws(
      () =>
        new FundingKeeper({
          chain: { read: async () => ({ chainNow: 0, paused: false, hasRole: true, markets: [] }) },
          sender: { address: SELF, submit: async () => ({}) as TxJob, wait: async () => ({}) as TxOutcome, openJobs: async () => [] },
          engine: ENGINE,
          log: createLogger("t", "error", {}, () => {}),
          metrics: new Metrics(),
          actions: new KeeperActions({} as SqlClient, "x"),
          dueAfterSecs: 3600,
          maxPerTick: 1,
        })
    );
  });
});
