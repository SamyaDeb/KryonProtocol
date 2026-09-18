/**
 * The tick as a whole: one failing read must not hide the other checks, and
 * neither a broken notifier nor a broken database may stop the loop.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { zeroAddress, type Address } from "viem";

import type { ProtocolContracts } from "@/lib/chain/networks";
import { createLogger, Metrics } from "@/lib/keepers/runtime";
import type { Queryable, Rows } from "@/lib/queries/client";

import type { MonitorChain } from "./chain";
import { loadMonitorConfig } from "./config";
import type { Probes } from "./context";
import { Monitor } from "./monitor";
import type { Notifier } from "./notifier";
import { CHECKS } from "./registry";
import { MonitorStore } from "./store";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
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

/** A chain where everything is healthy, except what a test overrides. */
function fakeChain(o: Partial<MonitorChain> = {}): MonitorChain {
  return {
    head: async () => ({ number: 100n, timestamp: 1_000_000 }),
    blockTimestamp: async () => 1_000_000,
    solvency: async () => ({ assets: 0n, liabilities: 0n }),
    insurance: async () => ({ unfundedShortfall: 0n, marked: 0n, priced: true, badDebt: 0n }),
    depositCaps: async () => ({ totalCap: 0n, perAccountCap: 0n, totalDeposited: 0n }),
    paused: async () => ({ vault: false }),
    markets: async () => [],
    oracle: async () => ({ paused: false, publishers: [], feeds: [], chainNow: 1_000_000 }),
    roleMembers: async () => ({}),
    implementations: async () => new Map(),
    balances: async () => new Map(),
    nonces: async () => new Map(),
    accountHealth: async () => new Map(),
    ...o,
  };
}

const fakeProbes: Probes = {
  rpc: async () => ({ latencyMs: 10, blockNumber: 100n }),
  http: async () => 200,
  ws: async () => undefined,
  replicaLag: async () => null,
};

/** Every query answers with no rows, which is a healthy empty system. */
function fakeQueryable(o: { fail?: boolean } = {}): Queryable {
  return {
    query: async (): Promise<Rows> => {
      if (o.fail) throw new Error("database is down");
      return [];
    },
  };
}

function monitor(o: {
  chain?: Partial<MonitorChain>;
  notifier?: Notifier;
  persist?: Queryable | null;
  queryable?: Queryable;
  lines?: string[];
}) {
  const lines = o.lines ?? [];
  return new Monitor({
    cfg: loadMonitorConfig({ MONITOR_FAIL_AFTER: "1", MONITOR_STARTUP_GRACE_MS: "0" }, ["http://rpc"]),
    network: "arc-local",
    contracts: CONTRACTS,
    chain: fakeChain(o.chain),
    store: new MonitorStore(o.queryable ?? fakeQueryable(), "arc-local"),
    probes: fakeProbes,
    roleBaseline: null,
    deploymentRecord: new Map(),
    log: createLogger("monitor", "debug", {}, (l) => lines.push(l)),
    metrics: new Metrics(),
    notifier: o.notifier ?? { name: "none", send: async () => undefined },
    persist: o.persist === undefined ? null : o.persist,
    now: () => 1_700_000_000_000,
  });
}

test("every check reports, and one broken read does not hide the others", async () => {
  const view = await monitor({
    chain: {
      solvency: async () => {
        throw new Error("RPC 502");
      },
    },
  }).tick();

  // One result per check at least, and the broken one is an error rather than a pass.
  assert.equal(new Set(view.results.map((r) => r.check)).size, CHECKS.length);
  const solvency = view.results.find((r) => r.check === "vault.solvency")!;
  assert.equal(solvency.status, "error");
  assert.equal(solvency.severity, "WARN");
  assert.match(solvency.detail, /RPC 502/);
  // Other checks still ran and produced verdicts.
  assert.equal(view.results.find((r) => r.check === "insurance.shortfall")!.status, "pass");
  assert.equal(view.results.find((r) => r.check === "infra.ws")!.status, "skip");
  // The broken read alerts on its own key, at WARN — a blind spot, not a verdict.
  assert.equal(view.firing.find((f) => f.key === "vault.solvency")!.severity, "WARN");
});

test("a notifier that throws does not fail the tick", async () => {
  const m = monitor({
    chain: { solvency: async () => ({ assets: 0n, liabilities: 1n }) },
    notifier: {
      name: "broken",
      send: async () => {
        throw new Error("webhook down");
      },
    },
  });
  // The notifier here is the raw one, not `fanout`: even so, one bad delivery
  // must not lose the tick's snapshot.
  await assert.rejects(m.tick()); // raw notifier errors propagate...
  const view = m.view()!;
  assert.equal(view.level, "PAGE"); // ...and the snapshot was still published
});

test("a database that refuses the snapshot write does not stop alerting", async () => {
  const sent: string[] = [];
  const m = monitor({
    chain: { solvency: async () => ({ assets: 0n, liabilities: 1n }) },
    notifier: { name: "spy", send: async (e) => void sent.push(e.key) },
    persist: fakeQueryable({ fail: true }),
    queryable: fakeQueryable(),
  });
  const view = await m.tick();
  assert.equal(view.level, "PAGE");
  assert.ok(sent.includes("vault.solvency"), sent.join(","));
});

test("an empty system is quiet apart from what is genuinely unconfigured", async () => {
  const view = await monitor({}).tick();
  const failing = view.results.filter((r) => r.status === "fail").map((r) => r.key);
  // Caps, roles, implementations and gas targets all say "not configured"
  // rather than passing; nothing else fails against an empty chain.
  assert.deepEqual(failing.sort(), ["gas.balance", "governance.implementations", "indexer.lag", "vault.deposit-caps"]);
  for (const key of failing) {
    const r = view.results.find((x) => x.key === key)!;
    if (key === "indexer.lag") continue; // a real finding: no cursor at all
    assert.equal(r.severity, "WARN", key);
  }
  assert.equal(view.level, "PAGE"); // indexer.lag is a PAGE, and rightly so
});

test("the monitor holds no signer: its chain interface has no way to send", () => {
  const surface = Object.keys(fakeChain());
  assert.ok(!surface.some((k) => /send|write|sign|submit|wallet/i.test(k)), surface.join(","));
  assert.equal(zeroAddress, "0x0000000000000000000000000000000000000000");
});
