import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { encodeErrorResult, type Address, type TransactionReceipt } from "viem";

import type { AccountHealth } from "@/lib/chain/collateral";
import { ALL_ERRORS_ABI } from "@/lib/chain/contracts";
import type { TxJob } from "@/lib/chain/tx-store";
import type { TxOutcome, TxRequest } from "@/lib/chain/tx-sender";
import type { SqlClient } from "@/lib/sql";

import {
  LiquidationKeeper,
  classifyLiquidationRevert,
  pickAdlCounterparty,
  pickLiquidationMarket,
  selectCandidates,
  unrealizedPnl,
  type LiquidationChain,
  type OpenPosition,
} from "./liquidation";
import { KeeperActions, Metrics, createLogger } from "./runtime";

const E18 = 10n ** 18n;
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const INSURANCE = a(0x1175);

function h(equity: bigint, mmr: bigint): AccountHealth {
  return {
    collateralValue: 0n,
    unrealizedPnl: 0n,
    equity,
    initialMarginRequired: mmr * 2n,
    maintenanceMarginRequired: mmr,
    freeCollateral: 0n,
    marginRatio: 0n,
    liquidatable: equity < mmr,
  };
}

describe("selectCandidates", () => {
  test("most under water first, blocked accounts separated, capped", () => {
    const m = new Map<Address, AccountHealth | null>([
      [a(1), h(50n, 80n)], // short 30
      [a(2), h(-40n, 80n)], // short 120
      [a(3), h(200n, 80n)], // healthy
      [a(4), null], // stale price
      [a(5), h(70n, 80n)], // short 10
    ]);
    const s = selectCandidates(m, 2);
    assert.deepEqual(s.liquidatable.map((c) => c.trader), [a(2), a(1)]);
    assert.deepEqual(s.blocked, [a(4)]);
    assert.equal(s.healthy, 1);
  });
});

describe("pnl and picks", () => {
  test("unrealizedPnl matches Liquidation.adl for both sides", () => {
    // long 1 @ 100, now 110: +10; short 1 @ 100 (openNotional -100), now 90: +10
    assert.equal(unrealizedPnl({ size: E18, openNotional: 100n * E18 }, 110n * E18), 10n * E18);
    assert.equal(unrealizedPnl({ size: -E18, openNotional: -100n * E18 }, 90n * E18), 10n * E18);
    assert.equal(unrealizedPnl({ size: -E18, openNotional: -100n * E18 }, 110n * E18), -10n * E18);
  });

  test("liquidate the largest notional first", () => {
    const pos: OpenPosition[] = [
      { marketId: 2, size: E18 / 100n, openNotional: 0n }, // 0.01 BTC @ 100k = 1000
      { marketId: 3, size: -E18, openNotional: 0n }, // 1 ETH @ 3k = 3000
    ];
    assert.equal(pickLiquidationMarket(pos, new Map([[2, 100_000n * E18], [3, 3_000n * E18]])), 3);
    assert.equal(pickLiquidationMarket([], new Map()), null);
  });

  test("ADL counterparty: opposite side, in profit, largest profit", () => {
    const cands = [
      { trader: a(1), size: -E18, openNotional: -100n * E18 }, // short, +10 at 90
      { trader: a(2), size: -2n * E18, openNotional: -200n * E18 }, // short, +20 at 90
      { trader: a(3), size: E18, openNotional: 80n * E18 }, // long, same side as backstop
      { trader: a(4), size: -E18, openNotional: -85n * E18 }, // short, losing at 90
    ];
    assert.deepEqual(pickAdlCounterparty(E18, cands, 90n * E18), { trader: a(2), upnl: 20n * E18 });
    assert.equal(pickAdlCounterparty(E18, cands.slice(2), 90n * E18), null);
  });
});

describe("classifyLiquidationRevert", () => {
  test("classes", () => {
    assert.equal(classifyLiquidationRevert("LiquidationWouldNotImproveHealth"), "healthy");
    assert.equal(classifyLiquidationRevert("InvalidAmount"), "healthy");
    assert.equal(classifyLiquidationRevert("StaleOracle"), "oracle");
    assert.equal(classifyLiquidationRevert("EnforcedPause"), "paused");
    assert.equal(classifyLiquidationRevert("NoBadDebtToOffset"), "no-shortfall");
    assert.equal(classifyLiquidationRevert("PositionNotInProfit"), "not-in-profit");
    assert.equal(classifyLiquidationRevert("HasOpenPositions"), "no-position");
    assert.equal(classifyLiquidationRevert(null), "unknown");
  });
});

// ─── the keeper, against a fake chain ───────────────────────────────────────

let paused: boolean;
let healthMap: Map<Address, AccountHealth | null>;
let positions: Map<Address, OpenPosition[]>;
let shortfall: bigint | null;
let submitted: TxRequest[];
let submitError: Error | null;
let inFlight: boolean;
let dbPositions: { trader: string; size: string; openNotional: string }[];

function chain(): LiquidationChain {
  return {
    paused: async () => paused,
    health: async (accts) => new Map(accts.map((x) => [x, healthMap.get(x) ?? null])),
    positionsOf: async (t) => positions.get(t) ?? [],
    indexPrice: async () => 100n * E18,
    unfundedShortfall: async () => shortfall,
    badDebtState: async () => ({ positionCount: 0, balance: 0n, recordedDebt: 0n, operating: 0n }),
    solvency: async () => ({ assets: 1n, liabilities: 1n }),
  };
}

function keeper() {
  const sql = {
    query: async (text: string) => {
      if (text.startsWith("INSERT")) return [{ id: "1" }];
      if (text.includes('SELECT DISTINCT "trader" FROM "Position"')) return [...healthMap.keys()].map((trader) => ({ trader }));
      if (text.includes('FROM "Position" WHERE "network" = $1 AND "marketId"')) return dbPositions;
      return [];
    },
  } as unknown as SqlClient;
  return new LiquidationKeeper({
    chain: chain(),
    sender: {
      address: a(0xbeef),
      submit: async (req) => {
        if (submitError) throw submitError;
        submitted.push(req);
        // A successful liquidation restores health in this fake.
        for (const [k, v] of healthMap) if (v?.liquidatable) healthMap.set(k, h(100n, 80n));
        return { id: "j" } as TxJob;
      },
      wait: async (job): Promise<TxOutcome> => {
        if (inFlight && job.id === "stuck") throw new Error("timeout");
        return { job, receipt: { status: "success", logs: [], blockNumber: 1n, transactionHash: "0x01" } as unknown as TransactionReceipt };
      },
      openJobs: async () => (inFlight ? [{ id: "stuck", nonce: 1, createdAt: new Date() } as TxJob] : []),
    },
    sql,
    network: "arc-local",
    contracts: { engine: a(0xe), liquidation: a(0x1), insurance: INSURANCE },
    log: createLogger("t", "error", {}, () => {}),
    metrics: new Metrics(),
    actions: new KeeperActions(sql, "arc-local"),
    maxAccountsPerTick: 25,
    maxStepsPerAccount: 5,
    indexerGraceMs: 60_000,
    adlMinShortfall: E18,
  });
}

beforeEach(() => {
  paused = false;
  healthMap = new Map([[a(1), h(-10n, 80n)]]);
  positions = new Map([[a(1), [{ marketId: 2, size: E18, openNotional: 100n * E18 }]]]);
  shortfall = 0n;
  submitted = [];
  submitError = null;
  inFlight = false;
  dbPositions = [];
});

describe("LiquidationKeeper.tick", () => {
  test("liquidates, re-checks health, and stops once healthy", async () => {
    const r = await keeper().tick();
    assert.equal(submitted.length, 1);
    assert.deepEqual(r.liquidated, [{ trader: a(1), steps: 1, stillLiquidatable: false }]);
  });

  test("paused: nothing read, nothing sent", async () => {
    paused = true;
    assert.equal((await keeper().tick()).status, "paused");
    assert.equal(submitted.length, 0);
  });

  test("a stale price blocks the account instead of retrying it", async () => {
    healthMap = new Map([[a(1), null]]);
    const r = await keeper().tick();
    assert.deepEqual(r.blocked, [a(1)]);
    assert.equal(submitted.length, 0);
  });

  test("a transaction still in flight blocks every new decision", async () => {
    inFlight = true;
    assert.equal((await keeper().tick()).status, "in-flight");
    assert.equal(submitted.length, 0);
  });

  test("a raced liquidation (already healthy on-chain) stops quietly", async () => {
    submitError = Object.assign(new Error("x"), {
      data: encodeErrorResult({ abi: ALL_ERRORS_ABI, errorName: "LiquidationWouldNotImproveHealth" } as never),
    });
    const r = await keeper().tick();
    assert.deepEqual(r.liquidated, [{ trader: a(1), steps: 0, stillLiquidatable: true }]);
  });

  test("ADL: blocked when the shortfall is unreadable, skipped at dust, sent above it", async () => {
    healthMap = new Map();
    shortfall = null;
    assert.deepEqual((await keeper().tick()).adl, { skipped: "oracle" });
    shortfall = E18 - 1n;
    assert.deepEqual((await keeper().tick()).adl, { skipped: "dust" });
    shortfall = 50n * E18;
    positions.set(INSURANCE, [{ marketId: 2, size: E18, openNotional: 100n * E18 }]);
    dbPositions = [{ trader: a(7), size: String(-E18), openNotional: String(-150n * E18) }];
    const r = await keeper().tick();
    assert.equal((r.adl as { counterparty: Address }).counterparty, a(7));
    assert.equal(submitted.length, 1);
  });

  test("ADL with nobody in profit on the other side sends nothing", async () => {
    healthMap = new Map();
    shortfall = 50n * E18;
    positions.set(INSURANCE, [{ marketId: 2, size: E18, openNotional: 100n * E18 }]);
    dbPositions = [{ trader: a(7), size: String(-E18), openNotional: String(-50n * E18) }];
    assert.deepEqual((await keeper().tick()).adl, { skipped: "no-counterparty" });
    assert.equal(submitted.length, 0);
  });
});
