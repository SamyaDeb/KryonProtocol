import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";

import { ALL_ERRORS_ABI, oracleAdapterAbi } from "@/lib/chain/contracts";
import { oracleId } from "@/lib/chain/networks";
import type { TxJob } from "@/lib/chain/tx-store";
import type { TxOutcome, TxRequest } from "@/lib/chain/tx-sender";
import type { SqlClient } from "@/lib/sql";
import { KeeperActions, Metrics, createLogger } from "@/lib/keepers/runtime";

import type { FeedState, PolicyOptions } from "./guards";
import { OraclePublisher, classifyRevert, outcomesFromReceipt, symbolOf, type OracleState } from "./publisher";
import type { PriceSource } from "./sources";

const E18 = 10n ** 18n;
const ORACLE = "0x00000000000000000000000000000000000000cc" as Address;
const SELF = "0x000000000000000000000000000000000000000a" as Address;
const PEER = "0x000000000000000000000000000000000000000b" as Address;
const CHAIN_NOW = 2_000_000;
const WALL = CHAIN_NOW * 1000;

// ─── fakes ──────────────────────────────────────────────────────────────────

function feedState(symbol: string, over: Partial<FeedState["cfg"]> = {}): FeedState {
  return {
    id: oracleId(symbol) as Hex,
    symbol,
    cfg: { listed: true, active: true, minPublishers: 2, maxSpreadBps: 50, maxJumpBps: 2000, maxConfidenceBps: 100, maxAge: 15, ...over },
    snapshot: { price: 100n * E18, confidence: 0n, publishTime: CHAIN_NOW - 4, writeTime: CHAIN_NOW - 3, sourceCount: 2 },
    observations: new Map([
      [SELF.toLowerCase(), { price: 100n * E18, confidence: 0n, publishTime: CHAIN_NOW - 10 }],
      [PEER.toLowerCase(), { price: 100n * E18, confidence: 0n, publishTime: CHAIN_NOW - 4 }],
    ]),
    reference: { enabled: false, required: false, maxDivergenceBps: 150, ok: false, price: 0n },
  };
}

/** Two venues quoting every symbol at `prices[symbol]`, USDC at `usdc`. */
function venues(prices: Record<string, number>, usdc = 1): PriceSource[] {
  const mk = (name: string): PriceSource => ({
    name,
    supports: () => true,
    fetch: async (symbols) => ({
      quotes: symbols
        .filter((s) => s === "USDC" || s in prices)
        .map((s) => ({
          source: name,
          symbol: s,
          price: BigInt(Math.round((s === "USDC" ? usdc : prices[s]) * 1e6)) * 10n ** 12n,
          ts: WALL,
        })),
      errors: [],
    }),
  });
  return [mk("v1"), mk("v2")];
}

function revertError(errorName: string, args?: readonly unknown[]): Error {
  const data = encodeErrorResult({ abi: ALL_ERRORS_ABI, errorName, args } as never);
  return Object.assign(new Error(`reverted: ${errorName}`), { data });
}

function eventLog(eventName: string, args: Record<string, unknown>): Log {
  const abiEvent = oracleAdapterAbi.find((x) => x.type === "event" && x.name === eventName) as unknown as {
    inputs: { name: string; type: string; indexed?: boolean }[];
  };
  const topics = encodeEventTopics({ abi: oracleAdapterAbi, eventName, args } as never);
  const nonIndexed = abiEvent.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed as never, nonIndexed.map((i) => args[i.name]) as never);
  return { address: ORACLE, topics, data } as unknown as Log;
}

function receipt(logs: Log[], status: "success" | "reverted" = "success"): TransactionReceipt {
  return { status, logs, blockNumber: 42n, gasUsed: 50_000n, effectiveGasPrice: 20n } as unknown as TransactionReceipt;
}

class FakePusher {
  readonly address = SELF;
  submitted: TxRequest[] = [];
  submitError: Error | null = null;
  nextReceipt: TransactionReceipt = receipt([]);
  async submit(req: TxRequest): Promise<TxJob> {
    if (this.submitError) throw this.submitError;
    this.submitted.push(req);
    return { id: `job-${this.submitted.length}` } as TxJob;
  }
  async wait(job: TxJob): Promise<TxOutcome> {
    return { job, receipt: this.nextReceipt };
  }
}

function fakeSql() {
  const queries: { text: string; params: unknown[] }[] = [];
  const sql = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      return text.startsWith("INSERT") ? [{ id: String(queries.length) }] : [];
    },
  } as unknown as SqlClient;
  return { sql, queries };
}

// ─── harness ────────────────────────────────────────────────────────────────

let state: OracleState;
let pusher: FakePusher;
let simulateFails: Set<string>;
let logs: { level: string; msg: string; fields: Record<string, unknown> }[];
let metrics: Metrics;
let actions: { sql: SqlClient; queries: { text: string; params: unknown[] }[] };
let prices: Record<string, number>;
let usdc: number;

function publisher(over: { idlePolicy?: PolicyOptions } = {}) {
  const log = createLogger("t", "debug", {}, (line) => {
    const { level, msg, ...fields } = JSON.parse(line);
    logs.push({ level, msg, fields });
  });
  return new OraclePublisher({
    chain: {
      readState: async () => state,
      readUsdcReference: async () => null,
      simulate: async (data) => {
        for (const sym of simulateFails) {
          if (data.toLowerCase().includes(oracleId(sym).slice(2).toLowerCase())) {
            return { ok: false, error: revertError("InvalidConfig") };
          }
        }
        return { ok: true };
      },
    },
    sender: pusher,
    oracle: ORACLE,
    sources: venues(prices, usdc),
    log,
    metrics,
    actions: new KeeperActions(actions.sql, "arc-local"),
    aggregate: { minSources: 2, maxSourceDeviationBps: 50n },
    policy: { deviationBps: 5n, heartbeatSecs: 5, inclusionMarginSecs: 3, maxRefDivergenceBps: 0 },
    ...over,
    maxQuoteAgeMs: 5_000,
    usdcDepegHaltBps: 100n,
    depegFailClosed: true,
    backdateSecs: 1,
    alertAfterSecs: 30,
    now: () => WALL,
  });
}

beforeEach(() => {
  state = { paused: false, publishers: [SELF, PEER], feeds: [feedState("BTC"), feedState("ETH")], chainNow: CHAIN_NOW };
  pusher = new FakePusher();
  simulateFails = new Set();
  logs = [];
  metrics = new Metrics();
  actions = fakeSql();
  prices = { BTC: 100, ETH: 100 };
  usdc = 1;
});

const alerts = () => logs.filter((l) => l.fields.alert === true).map((l) => l.fields.alertKey);

// ─── tests ──────────────────────────────────────────────────────────────────

describe("OraclePublisher.tick", () => {
  test("publishes every due feed in one batch, back-dated behind chain time", async () => {
    const r = await publisher().tick();
    assert.equal(r.status, "published");
    assert.equal(pusher.submitted.length, 1);
    assert.equal(pusher.submitted[0].to, ORACLE);
    const payload = actions.queries.find((q) => q.text.startsWith("INSERT"))!.params[4] as string;
    assert.equal(JSON.parse(payload).publishTime, CHAIN_NOW - 1);
    assert.deepEqual(JSON.parse(payload).updates.map((u: { symbol: string }) => u.symbol), ["BTC", "ETH"]);
  });

  test("paused: idle, nothing sent", async () => {
    state.paused = true;
    assert.equal((await publisher().tick()).status, "paused");
    assert.equal(pusher.submitted.length, 0);
  });

  test("not a publisher: alert, nothing sent", async () => {
    state.publishers = [PEER];
    assert.equal((await publisher().tick()).status, "not-a-publisher");
    assert.equal(pusher.submitted.length, 0);
    assert.deepEqual(alerts(), ["not-a-publisher"]);
  });

  test("USDC de-peg halts every feed", async () => {
    usdc = 0.98;
    assert.equal((await publisher().tick()).status, "depeg-halt");
    assert.equal(pusher.submitted.length, 0);
    assert.deepEqual(alerts(), ["depeg"]);
  });

  test("nothing due: no transaction", async () => {
    for (const f of state.feeds) f.observations.set(SELF.toLowerCase(), { price: 100n * E18, confidence: 0n, publishTime: CHAIN_NOW - 2 });
    assert.equal((await publisher().tick()).status, "nothing-due");
    assert.equal(pusher.submitted.length, 0);
  });

  test("records per-feed outcomes from the receipt: update, quorum skip and re-anchor", async () => {
    const [btc, eth] = state.feeds;
    pusher.nextReceipt = receipt([
      eventLog("ObservationPushed", { id: btc.id, publisher: SELF, price: 100n * E18, confidence: 0n, publishTime: 1n }),
      eventLog("PriceUpdated", { id: btc.id, price: 100n * E18, confidence: 0n, publishTime: 1n, writeTime: 2n, sourceCount: 2 }),
      eventLog("PriceReanchored", { id: btc.id, prevPrice: 90n * E18, newPrice: 100n * E18, staleFor: 60n }),
      eventLog("ObservationPushed", { id: eth.id, publisher: SELF, price: 100n * E18, confidence: 0n, publishTime: 1n }),
      eventLog("PriceUpdateSkipped", { id: eth.id, reason: 0, candidate: 1n }),
    ]);
    const r = await publisher().tick();
    assert.deepEqual(r.outcomes?.get("BTC"), { kind: "updated", price: 100n * E18, sourceCount: 2, reanchored: true });
    assert.deepEqual(r.outcomes?.get("ETH"), { kind: "skipped", reason: "quorum", candidate: 1n });
    const snap = metrics.snapshot().counters;
    assert.equal(snap["oracle_reanchor_total.BTC"], "1");
    assert.equal(snap["oracle_skipped_total.quorum"], "1");
    assert.ok(actions.queries.some((q) => q.text.startsWith("UPDATE") && q.params.includes("CONFIRMED")));
  });

  test("an on-chain revert marks the intent failed", async () => {
    pusher.nextReceipt = receipt([], "reverted");
    assert.equal((await publisher().tick()).status, "reverted");
    assert.ok(actions.queries.some((q) => q.params.includes("FAILED")));
  });

  for (const [errorName, cls] of [
    ["StaleOracle", "stale"],
    ["EnforcedPause", "paused"],
  ] as const) {
    test(`pre-flight ${errorName}: classified ${cls}, no feed backs off`, async () => {
      pusher.submitError = revertError(errorName);
      const p = publisher();
      const r = await p.tick();
      assert.equal(r.revert, cls);
      pusher.submitError = null;
      assert.equal((await p.tick()).status, "published");
      assert.equal(pusher.submitted[0].data.includes(oracleId("BTC").slice(2)), true);
    });
  }

  test("pre-flight AccessControl: not-a-publisher alert", async () => {
    pusher.submitError = revertError("AccessControlUnauthorizedAccount", [SELF, `0x${"11".repeat(32)}`]);
    const r = await publisher().tick();
    assert.equal(r.revert, "not-a-publisher");
    assert.deepEqual(alerts(), ["not-a-publisher"]);
  });

  test("pre-flight UnknownFeed backs off only the named feed", async () => {
    pusher.submitError = revertError("UnknownFeed", [oracleId("ETH")]);
    const p = publisher();
    assert.equal((await p.tick()).revert, "unknown-feed");
    pusher.submitError = null;
    await p.tick();
    const payload = JSON.parse(actions.queries.filter((q) => q.text.startsWith("INSERT")).at(-1)!.params[4] as string);
    assert.deepEqual(payload.updates.map((u: { symbol: string }) => u.symbol), ["BTC"]);
  });

  test("an unattributed pre-flight revert is isolated per feed with eth_call", async () => {
    pusher.submitError = revertError("InvalidConfig");
    simulateFails.add("BTC");
    const p = publisher();
    assert.equal((await p.tick()).revert, "inactive-feed");
    pusher.submitError = null;
    await p.tick();
    const payload = JSON.parse(actions.queries.filter((q) => q.text.startsWith("INSERT")).at(-1)!.params[4] as string);
    assert.deepEqual(payload.updates.map((u: { symbol: string }) => u.symbol), ["ETH"]);
    assert.equal(metrics.snapshot().counters["oracle_backoff_total.BTC"], "1");
  });

  test("a feed stale on-chain past the threshold raises an alert", async () => {
    state.feeds[0].snapshot = { ...state.feeds[0].snapshot, writeTime: CHAIN_NOW - 120 };
    await publisher().tick();
    assert.ok(alerts().includes("stale:BTC"));
    assert.equal(metrics.snapshot().gauges["oracle_feed_age_s.BTC"], 120);
  });

  test("one feed's sources failing holds that feed only", async () => {
    delete prices.ETH;
    const r = await publisher().tick();
    assert.equal(r.status, "published");
    assert.deepEqual(r.decisions.get("ETH"), {
      action: "hold",
      reason: "sources",
      detail: { kind: "insufficient-sources", live: 0, required: 2 },
    });
  });
});

describe("classifyRevert", () => {
  test("every revert class", () => {
    const table: [string | null, string][] = [
      ["StaleOracle", "stale"],
      ["AccessControlUnauthorizedAccount", "not-a-publisher"],
      ["NotPublisher", "not-a-publisher"],
      ["EnforcedPause", "paused"],
      ["ExecutionPaused", "paused"],
      ["UnknownFeed", "unknown-feed"],
      ["InvalidConfig", "inactive-feed"],
      ["InvalidPrice", "invalid-price"],
      ["MathOverflow", "invalid-price"],
      ["Something", "unknown"],
      [null, "unknown"],
    ];
    for (const [name, cls] of table) assert.equal(classifyRevert(name), cls, String(name));
  });
});

describe("helpers", () => {
  test("symbolOf inverts oracleId", () => {
    assert.equal(symbolOf(oracleId("BTC") as Hex), "BTC");
  });
  test("outcomesFromReceipt ignores other contracts' logs", () => {
    const l = eventLog("PriceUpdated", { id: oracleId("BTC"), price: 1n, confidence: 0n, publishTime: 1n, writeTime: 1n, sourceCount: 1 });
    const foreign = { ...l, address: "0x00000000000000000000000000000000000000dd" } as Log;
    assert.equal(outcomesFromReceipt(receipt([foreign]), ORACLE).size, 0);
  });
});

describe("the cadence a feed is worth", () => {
  const recent = (f: FeedState): FeedState => ({
    ...f,
    // Due under the trading heartbeat (5s), not under the idle one (60s), and
    // not moved far enough for either deviation threshold.
    observations: new Map([
      [SELF.toLowerCase(), { price: 100n * E18, confidence: 0n, publishTime: CHAIN_NOW - 6 }],
      [PEER.toLowerCase(), { price: 100n * E18, confidence: 0n, publishTime: CHAIN_NOW - 4 }],
    ]),
  });
  const IDLE: PolicyOptions = { deviationBps: 50n, heartbeatSecs: 60, inclusionMarginSecs: 3, maxRefDivergenceBps: 0 };

  test("a feed whose market is closed is not paid for at trading speed", async () => {
    state = {
      paused: false,
      publishers: [SELF, PEER],
      feeds: [recent(feedState("BTC")), recent(feedState("ETH"))],
      chainNow: CHAIN_NOW,
      // ETH is listed on the oracle but its market is shut: nobody can trade
      // against that price, so it does not earn a push every heartbeat.
      tradedFeedIds: new Set([oracleId("BTC") as Hex]),
    };
    const r = await publisher({ idlePolicy: IDLE }).tick();
    assert.equal(r.status, "published");
    const sent = pusher.submitted[0].data!.toLowerCase();
    assert.ok(sent.includes(oracleId("BTC").slice(2).toLowerCase()), "BTC is published");
    assert.ok(!sent.includes(oracleId("ETH").slice(2).toLowerCase()), "ETH is not");
  });

  test("an idle feed still publishes once its own heartbeat is due", async () => {
    const stale = (f: FeedState): FeedState => ({
      ...f,
      observations: new Map([
        [SELF.toLowerCase(), { price: 100n * E18, confidence: 0n, publishTime: CHAIN_NOW - 61 }],
        [PEER.toLowerCase(), { price: 100n * E18, confidence: 0n, publishTime: CHAIN_NOW - 4 }],
      ]),
    });
    state = {
      paused: false,
      publishers: [SELF, PEER],
      feeds: [stale(feedState("ETH"))],
      chainNow: CHAIN_NOW,
      tradedFeedIds: new Set<Hex>(),
    };
    const r = await publisher({ idlePolicy: IDLE }).tick();
    assert.equal(r.status, "published", "a closed market's price still has to be quotable");
  });

  test("without a market listing, every feed keeps the trading cadence", async () => {
    state = {
      paused: false,
      publishers: [SELF, PEER],
      feeds: [recent(feedState("BTC")), recent(feedState("ETH"))],
      chainNow: CHAIN_NOW,
      tradedFeedIds: null,
    };
    await publisher({ idlePolicy: IDLE }).tick();
    const sent = pusher.submitted[0].data!.toLowerCase();
    assert.ok(sent.includes(oracleId("ETH").slice(2).toLowerCase()), "ETH is published as before");
  });
});
