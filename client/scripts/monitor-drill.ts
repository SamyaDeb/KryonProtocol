#!/usr/bin/env tsx
/**
 * Monitor drill: the real monitor against a real deployment on a local
 * arc-anvil, with the real matcher, indexer and funding keeper making the
 * system healthy first — and then every fault class induced in turn, each one
 * expected to fire its alert.
 *
 * A monitor that has never been watched failing is not a monitor; it is a
 * dashboard. Phase 5's exit gate wants an alert-fire drill for every rule, and
 * this is that drill, running locally now.
 *
 * The scenario:
 *   0. boot, deploy, trade, fund, and record the role baseline — all green
 *   1. the publisher stops: the feed goes stale (PAGE), by name, while the
 *      other feed stays green
 *   2. a signer's gas is drained (PAGE), then refilled: the alert resolves
 *   3. the indexer stalls behind the head (PAGE)
 *   4. a transaction is left open past the threshold, with a nonce gap (PAGE)
 *   5. an account is pushed below maintenance margin (PAGE)
 *   6. a role is granted through the timelock (PAGE)
 *   7. the deposit caps are changed (PAGE)
 *   8. the oracle adapter is paused (WARN)
 * ...and, throughout: an alert fires only after N failing ticks, never twice,
 * and a broken webhook never stops the loop.
 *
 * LOCAL ONLY. Environment: KRYON_E2E_DATABASE_URL (required, migrated and
 * disposable), KRYON_E2E_RPC_PORT, KRYON_E2E_VERBOSE.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { encodeFunctionData, keccak256, toHex, type Address } from "viem";

import { insuranceAbi, oracleAdapterAbi, vaultAbi } from "@/lib/chain/contracts";
import { TxSender } from "@/lib/chain/tx-sender";
import { MemoryTxJobStore } from "@/lib/chain/tx-store";
import { FundingKeeper, viemFundingChain } from "@/lib/keepers/funding";
import { KeeperActions, Metrics, createLogger } from "@/lib/keepers/runtime";
import {
  NETWORK,
  ROLES,
  account,
  depositUsdc,
  reporter,
  roleId,
  startLocalChain,
  type LocalChain,
} from "@/lib/keepers/testkit/localchain";
import { EVM_DIR, FEES } from "@/lib/keepers/testkit/localchain";
import { E18, startTrading } from "@/lib/keepers/testkit/trading";
import { viemMonitorChain } from "@/lib/monitor/chain";
import { loadMonitorConfig } from "@/lib/monitor/config";
import { Monitor } from "@/lib/monitor/monitor";
import { fanout, type Notifier } from "@/lib/monitor/notifier";
import { realProbes } from "@/lib/monitor/probes";
import { MonitorStore } from "@/lib/monitor/store";
import {
  implementationsFromRecord,
  parseRoleBaseline,
  PROXY_KEYS,
  rolesFor,
  type RoleContractKey,
} from "@/lib/monitor/roles";
import type { AlertEvent } from "@/lib/monitor/alerting";
import type { CheckResult } from "@/lib/monitor/types";
import { neon } from "@/lib/sql";

const r = reporter();
const BTC = 2;
const INDEX = 100_000n * E18;

async function main() {
  const dbUrl = process.env.KRYON_E2E_DATABASE_URL;
  if (!dbUrl) throw new Error("KRYON_E2E_DATABASE_URL is required (a migrated, disposable Postgres)");
  const sql = neon(dbUrl);

  r.step("0. boot arc-anvil, deploy, trade, accrue funding");
  const lc = await startLocalChain({ log: r.note });
  const trading = await startTrading(lc, dbUrl, [BTC]);
  try {
    await sql.query(`DELETE FROM "MonitorAlert" WHERE "network" = $1`, [NETWORK.id]);
    await sql.query(`DELETE FROM "MonitorStatus" WHERE "network" = $1`, [NETWORK.id]);

    const alice = account(31);
    const bob = account(32);
    const matcherKey = ROLES.operator.address;
    for (const a of [alice, bob]) await lc.setBalance(a.address, 20_000n * E18);
    await depositUsdc(lc, alice, 2_000_000_000n);
    await depositUsdc(lc, bob, 5_000_000_000n);
    // A guarded launch seeds the insurance fund before it opens (see
    // scripts/mainnet-seed-insurance.ts); without it, coverage is 0% of open
    // interest and the fund cannot absorb a liquidation.
    await seedInsurance(lc, 5_000_000_000n); // $5,000, a third of the open interest below
    await trading.pushIndex({ BTC: INDEX, ETH: 3_000n * E18 });
    // Alice long 0.15 BTC ($15,000) on $2,000 of collateral: 7.5x, so a 13%
    // drop takes her equity below the market's 1% maintenance margin.
    await trading.trade({ marketId: BTC, long: alice, short: bob, size: 15n * 10n ** 16n, price: INDEX });
    r.check("Alice is long 0.15 BTC against Bob", (await trading.position(alice.address, BTC)).size > 0n);

    // Funding must have been accrued once, or funding.freshness fails on its own.
    const fundingKeeper = new FundingKeeper({
      chain: viemFundingChain({
        client: lc.client,
        engine: lc.contracts.engine,
        riskParams: lc.contracts.riskParams,
        self: ROLES.fundingKeeper.address,
      }),
      sender: new TxSender({
        network: NETWORK,
        service: "funding",
        chain: lc.client,
        signer: ROLES.fundingKeeper,
        store: new MemoryTxJobStore(),
        pollMs: 100,
      }),
      engine: lc.contracts.engine,
      log: createLogger("funding", "error", {}, () => {}),
      metrics: new Metrics(),
      actions: new KeeperActions(sql, NETWORK.id),
      dueAfterSecs: 1,
      maxPerTick: 10,
    });
    await fundingKeeper.tick();
    await trading.index();
    const funded = (await sql.query(`SELECT count(*)::int AS n FROM "FundingUpdate"`)) as { n: number }[];
    r.check("funding accrued and indexed", funded[0].n > 0, String(funded[0].n));

    // ── the monitor, configured as a deployment would be ──────────────────
    const chain = viemMonitorChain(lc.client, lc.contracts);
    const baselineJson = await roleBaseline(chain);
    const caps = await chain.depositCaps();
    const env = {
      MONITOR_FAIL_AFTER: "2",
      MONITOR_RESOLVE_AFTER: "1",
      MONITOR_STARTUP_GRACE_MS: "0",
      MONITOR_HTTP_PORT: "0",
      MONITOR_GAS_TARGETS: [
        `matcher:${matcherKey}`,
        `publisher:${ROLES.publisher.address}`,
        `funding:${ROLES.fundingKeeper.address}`,
      ].join(","),
      MONITOR_EXPECTED_DEPOSIT_CAP_USDC: String(Number(caps.totalCap) / 1e6),
      MONITOR_EXPECTED_ACCOUNT_CAP_USDC: String(Number(caps.perAccountCap) / 1e6),
      // The local oracle publishes every few seconds with a 15s bound; the
      // drill's own pushes are seconds apart, so the default 0.5 fraction
      // would flag a healthy feed. Half a bound of 15s is 7s.
      MONITOR_ORACLE_STALE_FRACTION: "0.9",
    };
    const events: AlertEvent[] = [];
    const spy: Notifier = { name: "spy", send: async (e) => void events.push(e) };
    // A webhook that always fails, alongside it: the loop must not care.
    const broken: Notifier = {
      name: "broken-webhook",
      send: async () => {
        throw new Error("502 from the webhook");
      },
    };
    const metrics = new Metrics();
    const log = createLogger("monitor", process.env.KRYON_E2E_VERBOSE ? "debug" : "error", {}, (line) => {
      if (process.env.KRYON_E2E_VERBOSE) process.stdout.write(`    · ${line}\n`);
    });
    const probes = realProbes({ replicaUrl: null });
    const monitor = new Monitor({
      cfg: loadMonitorConfig(env, [lc.rpc]),
      network: NETWORK.id,
      contracts: lc.contracts,
      chain,
      store: new MonitorStore(sql, NETWORK.id),
      probes,
      roleBaseline: parseRoleBaseline(baselineJson),
      // What KRYON_DEPLOYMENT_FILE gives a deployment: the implementation each
      // proxy is meant to point at.
      deploymentRecord: implementationsFromRecord(
        readFileSync(resolve(EVM_DIR, `deployments/${NETWORK.id}.json`), "utf8"),
        lc.contracts
      ),
      log,
      metrics,
      notifier: fanout([spy, broken], log, metrics),
      persist: sql,
    });

    /** One tick; returns the results by key, and the alerts this tick delivered. */
    const tick = async () => {
      const before = events.length;
      const view = await monitor.tick();
      return {
        view,
        by: new Map(view.results.map((x) => [x.key, x])),
        fired: events.slice(before),
      };
    };
    const firedKeys = (fired: AlertEvent[], kind: AlertEvent["kind"] = "firing") =>
      fired.filter((e) => e.kind === kind).map((e) => e.key);
    /** Tick twice (MONITOR_FAIL_AFTER = 2) and report what fired on each. */
    const twice = async () => {
      const first = await tick();
      const second = await tick();
      return { first, second };
    };
    const bad = (rs: Map<string, CheckResult>) =>
      [...rs.values()].filter((x) => x.status === "fail" || x.status === "error").map((x) => `${x.key} (${x.detail})`);

    r.step("0b. a healthy system reports all green");
    const healthy = await tick();
    r.check(
      `${healthy.view.results.length} checks, none failing`,
      bad(healthy.by).length === 0,
      bad(healthy.by).join(" | ")
    );
    r.check("level OK", healthy.view.level === "OK", healthy.view.level);
    r.check("no alert delivered", healthy.fired.length === 0, JSON.stringify(firedKeys(healthy.fired)));
    r.note(
      `skipped (nothing to check yet): ${[...healthy.by.values()]
        .filter((x) => x.status === "skip")
        .map((x) => x.key)
        .join(", ")}`
    );

    // ── 1. stale feed ────────────────────────────────────────────────────
    r.step("1. the publisher stops: the BTC feed goes stale");
    await lc.warp(20); // arc-local maxOracleAge is 15s
    const stale = await twice();
    r.check("first failing tick does not alert yet (fires after 2)", firedKeys(stale.first.fired).length === 0, JSON.stringify(firedKeys(stale.first.fired)));
    r.check("oracle.freshness:BTC fires on the second", firedKeys(stale.second.fired).includes("oracle.freshness:BTC"));
    r.check(
      "it is a PAGE and says withdrawals are blocked",
      stale.second.by.get("oracle.freshness:BTC")?.severity === "PAGE" &&
        /withdrawals are blocked/.test(stale.second.by.get("oracle.freshness:BTC")?.detail ?? "")
    );
    r.check(
      "ETH, which has no open interest, is skipped rather than alerted",
      stale.second.by.get("oracle.freshness:ETH")?.status === "skip",
      stale.second.by.get("oracle.freshness:ETH")?.detail
    );
    const third = await tick();
    r.check("it does not alert again on the next tick", firedKeys(third.fired).length === 0, JSON.stringify(firedKeys(third.fired)));

    r.step("1b. the publisher resumes: the alert resolves");
    await trading.pushIndex({ BTC: INDEX, ETH: 3_000n * E18 });
    const recovered = await tick();
    r.check("oracle.freshness:BTC resolves", firedKeys(recovered.fired, "resolved").includes("oracle.freshness:BTC"));
    r.check("the feed reads fresh again", recovered.by.get("oracle.freshness:BTC")?.status === "pass");

    // ── 2. gas ───────────────────────────────────────────────────────────
    r.step("2. the matcher's gas is drained");
    const matcherBalance = await lc.client.getBalance({ address: matcherKey });
    await lc.setBalance(matcherKey, 0n);
    const drained = await twice();
    r.check("gas.balance:matcher fires as a PAGE", firedKeys(drained.second.fired).includes("gas.balance:matcher"));
    r.check(
      "the detail says its next transaction can fail",
      /next transaction can fail/.test(drained.second.by.get("gas.balance:matcher")?.detail ?? ""),
      drained.second.by.get("gas.balance:matcher")?.detail
    );
    r.check(
      "the other keys are unaffected",
      drained.second.by.get("gas.balance:publisher")?.status === "pass" &&
        drained.second.by.get("gas.balance:funding")?.status === "pass"
    );

    r.step("2b. refilled: the gas alert resolves");
    await lc.setBalance(matcherKey, matcherBalance);
    const refilled = await tick();
    r.check("gas.balance:matcher resolves", firedKeys(refilled.fired, "resolved").includes("gas.balance:matcher"));

    // ── 3. indexer ───────────────────────────────────────────────────────
    r.step("3. the indexer stalls behind the head");
    await lc.warp(120);
    await trading.pushIndex({ BTC: INDEX, ETH: 3_000n * E18 }); // moves the head, not the cursor
    const stalled = await twice();
    r.check("indexer.lag fires as a PAGE", firedKeys(stalled.second.fired).includes("indexer.lag"));
    r.note(String(stalled.second.by.get("indexer.lag")?.detail));

    r.step("3b. the indexer catches up");
    await trading.index();
    const caught = await tick();
    r.check("indexer.lag resolves", firedKeys(caught.fired, "resolved").includes("indexer.lag"));

    // ── 4. an unreconciled transaction, with a nonce gap ─────────────────
    r.step("4. a transaction is left open past the threshold, leaving a nonce gap");
    const mined = await lc.client.getTransactionCount({ address: matcherKey });
    await openJob(sql, { service: "matcher", from: matcherKey, nonce: mined, ageSecs: 900, id: "drill-open-1" });
    await openJob(sql, { service: "matcher", from: matcherKey, nonce: mined + 2, ageSecs: 900, id: "drill-open-2" });
    const stuck = await twice();
    r.check("settlement.txjobs fires as a PAGE", firedKeys(stuck.second.fired).some((k) => k.startsWith("settlement.txjobs:")));
    r.check("settlement.nonce-gap fires as a PAGE", firedKeys(stuck.second.fired).some((k) => k.startsWith("settlement.nonce-gap:")));
    r.note(String([...stuck.second.by.values()].find((x) => x.check === "settlement.nonce-gap" && x.status === "fail")?.detail));

    r.step("4b. the reconciler finishes them");
    await sql.query(`UPDATE "TxJob" SET "status" = 'DROPPED' WHERE "id" IN ('drill-open-1', 'drill-open-2')`);
    const drained2 = await tick();
    r.check(
      "both settlement alerts resolve",
      firedKeys(drained2.fired, "resolved").filter((k) => k.startsWith("settlement.")).length === 2,
      JSON.stringify(firedKeys(drained2.fired, "resolved"))
    );

    // ── 5. an account below maintenance margin ───────────────────────────
    r.step("5. a 13% drop pushes Alice below maintenance margin");
    await trading.pushIndex({ BTC: 87_000n * E18, ETH: 3_000n * E18 });
    const under = await twice();
    r.check("liquidation.backlog fires as a PAGE", firedKeys(under.second.fired).includes("liquidation.backlog"));
    r.check(
      "it names how far under water the account is",
      (under.second.by.get("liquidation.backlog")?.values.liquidatable ?? 0) === 1,
      under.second.by.get("liquidation.backlog")?.detail
    );
    await trading.pushIndex({ BTC: INDEX, ETH: 3_000n * E18 });
    const restored = await tick();
    r.check("it resolves once the price recovers", firedKeys(restored.fired, "resolved").includes("liquidation.backlog"));

    // ── 6. role drift ────────────────────────────────────────────────────
    r.step("6. a role is granted through the timelock");
    const timelock = await lc.timelock();
    const intruder = account(33).address;
    await lc.asAddress(timelock, {
      to: lc.contracts.oracleAdapter,
      data: encodeFunctionData({ abi: oracleAdapterAbi, functionName: "grantRole", args: [roleId("PUBLISHER_ROLE"), intruder] }),
    });
    const granted = await twice();
    r.check("governance.roles fires as a PAGE", firedKeys(granted.second.fired).includes("governance.roles"));
    r.check(
      "the drift names the contract, the role and the new holder",
      /oracleAdapter\.PUBLISHER_ROLE/.test(granted.second.by.get("governance.roles")?.detail ?? "") &&
        (granted.second.by.get("governance.roles")?.detail ?? "").includes(intruder.toLowerCase())
    );
    await lc.asAddress(timelock, {
      to: lc.contracts.oracleAdapter,
      data: encodeFunctionData({ abi: oracleAdapterAbi, functionName: "revokeRole", args: [roleId("PUBLISHER_ROLE"), intruder] }),
    });
    const revoked = await tick();
    r.check("it resolves when the grant is reverted", firedKeys(revoked.fired, "resolved").includes("governance.roles"));

    // ── 7. deposit caps ──────────────────────────────────────────────────
    r.step("7. the deposit caps are changed");
    await lc.asAddress(timelock, {
      to: lc.contracts.vault,
      data: encodeFunctionData({ abi: vaultAbi, functionName: "setDepositCaps", args: [caps.totalCap * 2n, caps.perAccountCap] }),
    });
    const capped = await twice();
    r.check("vault.deposit-caps fires as a PAGE", firedKeys(capped.second.fired).includes("vault.deposit-caps"));
    r.note(String(capped.second.by.get("vault.deposit-caps")?.detail));

    // ── 8. a pause ───────────────────────────────────────────────────────
    r.step("8. the oracle adapter is paused");
    await lc.asAddress(await guardian(lc), {
      to: lc.contracts.oracleAdapter,
      data: encodeFunctionData({ abi: oracleAdapterAbi, functionName: "pause" }),
    });
    const paused = await twice();
    r.check("protocol.paused fires as a WARN", firedKeys(paused.second.fired).includes("protocol.paused"));
    r.check("its severity is WARN, not PAGE", paused.second.by.get("protocol.paused")?.severity === "WARN");

    // ── the record ───────────────────────────────────────────────────────
    r.step("9. what the monitor recorded");
    const status = (await sql.query(
      `SELECT "level"::text AS level, jsonb_array_length("firing") AS firing FROM "MonitorStatus" WHERE "network" = $1`,
      [NETWORK.id]
    )) as { level: string; firing: number }[];
    r.check("MonitorStatus holds exactly one row for this network", status.length === 1);
    r.check(`its level is PAGE with ${status[0]?.firing} alert(s) firing`, status[0]?.level === "PAGE");
    const written = (await sql.query(
      `SELECT "event"::text AS event, count(*)::int AS n FROM "MonitorAlert" WHERE "network" = $1 GROUP BY 1 ORDER BY 1`,
      [NETWORK.id]
    )) as { event: string; n: number }[];
    r.note(`MonitorAlert rows: ${written.map((x) => `${x.event} ×${x.n}`).join(", ")}`);
    const fires = written.find((x) => x.event === "FIRING")?.n ?? 0;
    const resolves = written.find((x) => x.event === "RESOLVED")?.n ?? 0;
    r.check("every fire and resolve was persisted", fires >= 8 && resolves >= 6, `${fires} fired, ${resolves} resolved`);

    const snap = metrics.snapshot();
    r.check(
      "the broken webhook failed on every delivery and never stopped the loop",
      Number(snap.counters["monitor_alert_delivery_failures_total.broken-webhook"] ?? "0") === events.length,
      `${snap.counters["monitor_alert_delivery_failures_total.broken-webhook"]} failures, ${events.length} alerts`
    );
    r.check("no tick threw", Number(snap.counters.tick_errors_total ?? "0") === 0);

    await probes.close();
  } finally {
    await trading.end();
    lc.stop();
    await sql.end();
  }
  process.stdout.write(`\n${r.failures === 0 ? "✓ monitor drill passed" : `✗ monitor drill: ${r.failures} check(s) failed`}\n`);
  process.exit(r.failures === 0 ? 0 : 1);
}

/** Donate USDC into the insurance fund's operating balance, as a launch would. */
async function seedInsurance(lc: LocalChain, usdc6: bigint): Promise<void> {
  const who = ROLES.deployer;
  const w = lc.wallet(who);
  const approve = await w.writeContract({
    address: NETWORK.usdc,
    abi: [
      { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
    ] as const,
    functionName: "approve",
    args: [lc.contracts.insurance, usdc6],
    chain: lc.chain,
    account: who,
    ...FEES,
  });
  await lc.client.waitForTransactionReceipt({ hash: approve });
  const donate = await w.writeContract({
    address: lc.contracts.insurance,
    abi: insuranceAbi,
    functionName: "donate",
    args: [usdc6],
    chain: lc.chain,
    account: who,
    ...FEES,
  });
  const receipt = await lc.client.waitForTransactionReceipt({ hash: donate });
  if (receipt.status !== "success") throw new Error("seeding the insurance fund reverted");
}

/** The baseline an operator would write after 99_VerifyDeployment passes. */
async function roleBaseline(chain: ReturnType<typeof viemMonitorChain>): Promise<string> {
  const members = await chain.roleMembers();
  const out: Record<string, unknown> = { _network: NETWORK.id, _generatedAt: new Date().toISOString() };
  for (const k of [...PROXY_KEYS, "timelock"] as RoleContractKey[]) {
    out[k] = Object.fromEntries(rolesFor(k).map((role) => [role, members[k]?.[role] ?? []]));
  }
  return JSON.stringify(out);
}

async function guardian(lc: LocalChain): Promise<Address> {
  return (await lc.client.readContract({
    address: lc.contracts.oracleAdapter,
    abi: oracleAdapterAbi,
    functionName: "getRoleMember",
    args: [roleId("PAUSER_ROLE"), 0n],
  })) as Address;
}

/**
 * A TxJob the owning service left behind. Injected rather than provoked: on
 * anvil every transaction mines at once, so the only way to reproduce "signed,
 * broadcast, never mined" is to write the row the TxSender would have written
 * before it broadcast.
 */
async function openJob(
  sql: ReturnType<typeof neon>,
  o: { service: string; from: Address; nonce: number; ageSecs: number; id: string }
): Promise<void> {
  const created = new Date(Date.now() - o.ageSecs * 1000);
  const hash = keccak256(toHex(o.id));
  await sql.query(
    `INSERT INTO "TxJob" ("id", "network", "service", "label", "fromAddress", "toAddress", "nonce", "data", "value",
                          "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "rawTx", "submittedHash", "status",
                          "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, '0x', 0, 1000000, 100000000000, 1000000000, '0x', $8, 'SUBMITTED', $9, $9)`,
    [o.id, NETWORK.id, o.service, "settleFills (drill)", o.from.toLowerCase(), o.from.toLowerCase(), o.nonce, hash, created]
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
