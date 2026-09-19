// Fee-tier bot: schedule parsing, tier mapping at the boundaries, the diff,
// the dry-run guard and the idle states. scripts/fee-tier-drill.ts proves the
// same against the real FeeRouter on arc-anvil.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type TransactionReceipt } from "viem";

import { feeRouterAbi } from "@/lib/chain/contracts";
import type { TxJob } from "@/lib/chain/tx-store";
import {
  FeeTierBot,
  SET_ACTION,
  diffTiers,
  parseSchedule,
  targetTier,
  type FeeTierChain,
  type FeeTierData,
  type FeeTierSender,
} from "./fee-tier";
import { Metrics, createLogger, type KeeperActions } from "./runtime";

const USD = (n: number) => BigInt(n) * 1_000_000n;
const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const C = "0x00000000000000000000000000000000000000c3" as Address;
const ROUTER = "0x00000000000000000000000000000000000000fe" as Address;
const SCHEDULE = parseSchedule("1:1000000, 2:10000000, 3:50000000");

test("schedule: parsed in USD, sorted, validated", () => {
  assert.deepEqual(parseSchedule("2:10,1:5"), [
    { tier: 1, minVolume: USD(5) },
    { tier: 2, minVolume: USD(10) },
  ]);
  assert.throws(() => parseSchedule(undefined), /not set/);
  assert.throws(() => parseSchedule("0:5"), /outside 1..16/);
  assert.throws(() => parseSchedule("17:5"), /outside 1..16/);
  assert.throws(() => parseSchedule("1:5,1:6"), /twice/);
  assert.throws(() => parseSchedule("1:10,2:10"), /more volume/);
  assert.throws(() => parseSchedule("1:0"), /positive/);
  assert.throws(() => parseSchedule("1=5"), /tier:minUsd/);
});

test("target tier at the boundaries: a threshold is met exactly at its value", () => {
  assert.equal(targetTier(0n, SCHEDULE), 0);
  assert.equal(targetTier(USD(1_000_000) - 1n, SCHEDULE), 0);
  assert.equal(targetTier(USD(1_000_000), SCHEDULE), 1);
  assert.equal(targetTier(USD(10_000_000) - 1n, SCHEDULE), 1);
  assert.equal(targetTier(USD(10_000_000), SCHEDULE), 2);
  assert.equal(targetTier(USD(50_000_000), SCHEDULE), 3);
  assert.equal(targetTier(USD(10) ** 12n, SCHEDULE), 3);
});

test("diff: only accounts whose on-chain tier differs, largest move first, capped", () => {
  const volumes = new Map<Address, bigint>([
    [A, USD(60_000_000)], // → 3
    [B, USD(2_000_000)], // → 1
    [C, 0n], // → 0
  ]);
  const onChain = new Map<Address, number>([
    [A, 0],
    [B, 1],
    [C, 2],
  ]);
  const { changes, deferred } = diffTiers(volumes, onChain, SCHEDULE, 10);
  assert.deepEqual(
    changes.map((c) => [c.account, c.from, c.to]),
    [
      [A, 0, 3],
      [C, 2, 0],
    ]
  );
  assert.equal(deferred, 0);
  const capped = diffTiers(volumes, onChain, SCHEDULE, 1);
  assert.equal(capped.changes.length, 1);
  assert.equal(capped.deferred, 1);
  // An account whose on-chain tier could not be read is left alone, not assumed 0.
  assert.equal(diffTiers(new Map([[A, USD(60_000_000)]]), new Map(), SCHEDULE, 10).changes.length, 0);
});

// ─── bot, with fakes ────────────────────────────────────────────────────────

function receiptWith(account: Address, tier: number): TransactionReceipt {
  const topics = encodeEventTopics({ abi: feeRouterAbi, eventName: "FeeTierSet", args: { account } }) as [Hex, ...Hex[]];
  return {
    status: "success",
    blockNumber: 10n,
    logs: [{ address: ROUTER, topics, data: encodeAbiParameters([{ type: "uint8" }], [tier]) }],
  } as unknown as TransactionReceipt;
}

function harness(over: { chain?: Partial<FeeTierChain>; data?: Partial<FeeTierData>; enabled?: boolean; onChain?: Map<Address, number> } = {}) {
  const onChain = over.onChain ?? new Map<Address, number>([[A, 0], [B, 2]]);
  const sent: { to: Address; data: Hex }[] = [];
  let pending: { account: Address; tier: number } | null = null;
  const sender: FeeTierSender = {
    address: "0x00000000000000000000000000000000000000bb",
    async submit(req) {
      sent.push({ to: req.to, data: req.data });
      // Decode setAccountTier(account, tier) from calldata: selector + 2 words.
      const account = `0x${req.data.slice(34, 74)}` as Address;
      const tier = Number(BigInt(`0x${req.data.slice(74, 138)}`));
      pending = { account, tier };
      return { id: `job${sent.length}` } as TxJob;
    },
    async wait(job) {
      const p = pending!;
      onChain.set(p.account, p.tier);
      return { job, receipt: receiptWith(p.account, p.tier) };
    },
    async openJobs() {
      return [];
    },
  };
  const chain: FeeTierChain = {
    paused: async () => false,
    hasRole: async () => true,
    definedTiers: async (t) => new Set(t),
    accountTiers: async (accts) => new Map(accts.filter((a) => onChain.has(a)).map((a) => [a, onChain.get(a)!])),
    ...over.chain,
  };
  const data: FeeTierData = {
    statsAgeMs: async () => 60_000,
    qualifying: async () => new Map([[A, USD(12_000_000)]]),
    tiered: async () => [B],
    volumes: async (accts) => new Map(accts.map((a) => [a, 0n])),
    ...over.data,
  };
  const rows: { id: bigint; kind: string; status: string }[] = [];
  const actions = {
    async record(i: { kind: string }) {
      rows.push({ id: BigInt(rows.length + 1), kind: i.kind, status: "PLANNED" });
      return BigInt(rows.length);
    },
    async update(id: bigint, p: { status?: string }) {
      if (p.status) rows[Number(id) - 1].status = p.status;
    },
  } as unknown as KeeperActions;
  const logs: string[] = [];
  const bot = new FeeTierBot({
    chain,
    data,
    sender,
    feeRouter: ROUTER,
    schedule: SCHEDULE,
    enabled: over.enabled ?? false,
    log: createLogger("fee-tier", "debug", {}, (l) => logs.push(JSON.parse(l).msg)),
    metrics: new Metrics(),
    actions,
  });
  return { bot, sent, rows, onChain, logs };
}

test("dry run (the default) proposes the diff and sends nothing", async () => {
  const h = harness();
  const r = await h.bot.tick();
  assert.equal(r.status, "ran");
  assert.equal((r as { dryRun: boolean }).dryRun, true);
  assert.deepEqual(
    (r as { changes: { account: Address; from: number; to: number }[] }).changes.map((c) => [c.account, c.from, c.to]),
    [
      [A, 0, 2],
      [B, 2, 0],
    ]
  );
  assert.equal(h.sent.length, 0);
  assert.equal(h.rows.length, 0, "a dry run writes no intents");
  assert.ok(h.logs.some((m) => m.includes("dry run")));
});

test("enabled: one setAccountTier per change, confirmed on FeeTierSet; the next tick has nothing to do", async () => {
  const h = harness({ enabled: true });
  const r = await h.bot.tick();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(
    (r as { applied: { outcome: string }[] }).applied.map((a) => a.outcome),
    ["confirmed", "confirmed"]
  );
  assert.deepEqual(h.rows.map((x) => [x.kind, x.status]), [
    [SET_ACTION, "CONFIRMED"],
    [SET_ACTION, "CONFIRMED"],
  ]);
  assert.equal(h.onChain.get(A), 2);
  assert.equal(h.onChain.get(B), 0);
  // Restart-safe: the diff is re-derived from chain state, so nothing repeats.
  const again = await h.bot.tick();
  assert.equal((again as { changes: unknown[] }).changes.length, 0);
  assert.equal(h.sent.length, 2);
});

test("idle: paused, stale or missing stats, undefined tier, missing role (enabled only)", async () => {
  const reason = async (h: ReturnType<typeof harness>) => ((await h.bot.tick()) as { reason?: string }).reason;
  assert.equal(await reason(harness({ chain: { paused: async () => true } })), "paused");
  assert.equal(await reason(harness({ data: { statsAgeMs: async () => 3 * 3_600_000 } })), "stats-stale");
  assert.equal(await reason(harness({ data: { statsAgeMs: async () => null } })), "stats-stale");
  assert.equal(await reason(harness({ chain: { definedTiers: async () => new Set([1, 2]) } })), "tier-undefined");
  assert.equal(await reason(harness({ enabled: true, chain: { hasRole: async () => false } })), "lacks-role");
  // A dry run does not need the role: it can be deployed before the grant.
  assert.equal((await harness({ chain: { hasRole: async () => false } }).bot.tick()).status, "ran");
});

test("stale stats never downgrade anyone", async () => {
  const h = harness({ enabled: true, data: { statsAgeMs: async () => 10 * 3_600_000, qualifying: async () => new Map() } });
  await h.bot.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.onChain.get(B), 2);
});
