import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Address, TransactionReceipt } from "viem";

import type { TxJob } from "@/lib/chain/tx-store";
import type { TxOutcome, TxRequest } from "@/lib/chain/tx-sender";
import type { SqlClient } from "@/lib/sql";

import { USDC18, parseTargets, planRefills, refillOnce, type RefillPolicy } from "./refill";
import { KeeperActions, Metrics, createLogger } from "./runtime";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const U = (n: number) => BigInt(n) * USDC18;
const POLICY: RefillPolicy = { floor: U(5), target: U(25), maxPerRun: U(100), maxPerTargetPerDay: U(50), funderAlert: U(100) };
const t = (name: string, n: number, balance: bigint, spentToday = 0n) => ({ name, address: a(n), balance, spentToday });

describe("parseTargets", () => {
  test("name:address pairs", () => {
    assert.deepEqual(parseTargets(` oracle-1:${a(1)}, funding:${a(2)} `), [
      { name: "oracle-1", address: a(1) },
      { name: "funding", address: a(2) },
    ]);
    assert.deepEqual(parseTargets(undefined), []);
  });
  test("rejects malformed entries", () => {
    assert.throws(() => parseTargets("oracle-1"));
    assert.throws(() => parseTargets("oracle-1:0x123"));
  });
});

describe("planRefills", () => {
  test("above the floor costs nothing; below it tops up to the target", () => {
    const p = planRefills([t("ok", 1, U(10)), t("low", 2, U(2))], U(1_000), POLICY);
    assert.deepEqual(
      p.map((x) => [x.name, x.action, x.action === "top-up" ? x.amount : null]),
      [["low", "top-up", U(23)], ["ok", "ok", null]]
    );
  });

  test("most depleted first, then the per-run cap", () => {
    const p = planRefills([t("a", 1, U(4)), t("b", 2, 0n), t("c", 3, U(1))], U(1_000), { ...POLICY, maxPerRun: U(40) });
    assert.deepEqual(
      p.map((x) => [x.name, x.action, x.action === "top-up" ? x.amount : x.action === "capped" ? x.reason : null]),
      [["b", "top-up", U(25)], ["c", "top-up", U(15)], ["a", "capped", "run"]]
    );
  });

  test("a key that burned its daily allowance is capped, not refilled", () => {
    const [p] = planRefills([t("runaway", 1, 0n, U(50))], U(1_000), POLICY);
    assert.deepEqual([p.action, p.action === "capped" && p.reason], ["capped", "day"]);
    const [q] = planRefills([t("partial", 1, 0n, U(40))], U(1_000), POLICY);
    assert.equal(q.action === "top-up" && q.amount, U(10));
  });

  test("never spends the funder's own gas", () => {
    const [p] = planRefills([t("x", 1, 0n)], U(1), POLICY);
    assert.deepEqual([p.action, p.action === "capped" && p.reason], ["capped", "funder"]);
  });

  test("refuses a target at or below the floor", () => {
    assert.throws(() => planRefills([], U(1), { ...POLICY, target: U(5) }));
  });
});

describe("refillOnce", () => {
  let balances: Map<Address, bigint>;
  let sent: TxRequest[];
  let inFlight: boolean;
  let logs: { level: string; msg: string; alert?: boolean }[];

  function run(execute: boolean) {
    const sql = {
      query: async (text: string) => (text.startsWith("INSERT") ? [{ id: "1" }] : []),
    } as unknown as SqlClient;
    return refillOnce({
      client: { getBalance: async ({ address }: { address: Address }) => balances.get(address) ?? 0n } as never,
      sender: {
        address: a(0xf),
        submit: async (req) => {
          sent.push(req);
          return { id: "j" } as TxJob;
        },
        wait: async (job): Promise<TxOutcome> => {
          if (job.id === "stuck") throw new Error("timeout");
          return { job, receipt: { status: "success", blockNumber: 1n } as unknown as TransactionReceipt };
        },
        openJobs: async () => (inFlight ? [{ id: "stuck", nonce: 1, createdAt: new Date() } as TxJob] : []),
      },
      sql,
      network: "arc-local",
      targets: [{ name: "oracle-1", address: a(1) }],
      policy: POLICY,
      execute,
      log: createLogger("t", "debug", {}, (l) => logs.push(JSON.parse(l))),
      metrics: new Metrics(),
      actions: new KeeperActions(sql, "arc-local"),
    });
  }

  beforeEach(() => {
    balances = new Map([[a(0xf), U(1_000)], [a(1), U(1)]]);
    sent = [];
    inFlight = false;
    logs = [];
  });

  test("dry run plans but sends nothing", async () => {
    const r = await run(false);
    assert.equal(r.plans[0].action, "top-up");
    assert.equal(sent.length, 0);
  });

  test("execute sends a plain value transfer", async () => {
    const r = await run(true);
    assert.deepEqual(r.sent, ["oracle-1"]);
    assert.deepEqual([sent[0].to, sent[0].data, sent[0].value], [a(1), "0x", U(24)]);
  });

  test("a top-up still in flight blocks a second one", async () => {
    inFlight = true;
    const r = await run(true);
    assert.equal(sent.length, 0);
    assert.deepEqual(r.plans, []);
  });

  test("a low funder raises an alert", async () => {
    balances.set(a(0xf), U(50));
    await run(false);
    assert.ok(logs.some((l) => l.level === "error" && l.alert === true));
  });
});
