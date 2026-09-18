#!/usr/bin/env tsx
/**
 * monitor — the process that makes the rest safe to leave running.
 *
 * It reads the chain and the database every tick, runs every check in
 * lib/monitor/checks, and turns state changes into alerts. It holds NO private
 * key and sends NO transaction: every chain call it makes is a read.
 *
 * Environment:
 *   KRYON_NETWORK                     arc-mainnet | arc-testnet | arc-local
 *   DATABASE_URL                      Postgres (read; it writes only MonitorStatus / MonitorAlert)
 *   ARC_RPC_URLS                      comma-separated, paid providers first (optional)
 *   KRYON_DEPLOYMENT_FILE             deployment record, or all CONTRACT_* variables
 *   MONITOR_INTERVAL_MS               tick period (default 30000)
 *
 *   ALERT_WEBHOOK_URL                 Slack / Discord / Telegram / generic JSON webhook
 *   ALERT_WEBHOOK_FORMAT              slack | discord | telegram | generic (default: from the URL)
 *   ALERT_TELEGRAM_CHAT_ID            required for a Telegram webhook
 *   MONITOR_FAIL_AFTER                consecutive failing ticks before an alert fires (default 2)
 *   MONITOR_RESOLVE_AFTER             consecutive passing ticks before it resolves (default 2)
 *   MONITOR_RENOTIFY_MS               reminder interval while still failing (default 3600000)
 *   MONITOR_STARTUP_GRACE_MS          no notifications for this long after start (default 120000)
 *
 *   MONITOR_HTTP_HOST / _PORT         /healthz, /metrics, /status (default 127.0.0.1:9464; port 0 disables)
 *   MONITOR_SNAPSHOT                  "false" stops writing MonitorStatus / MonitorAlert
 *
 *   MONITOR_GAS_TARGETS               name:0xaddress,... (defaults to REFILL_TARGETS)
 *   MONITOR_GAS_WARN_USDC             default REFILL_FLOOR_USDC; MONITOR_GAS_PAGE_USDC default 1
 *   MONITOR_REFILL_FUNDER_ADDRESS     the refill funder to watch (address only, never a key)
 *   MONITOR_ROLE_BASELINE_FILE        expected role holders (see --print-role-baseline)
 *   MONITOR_EXPECTED_DEPOSIT_CAP_USDC / MONITOR_EXPECTED_ACCOUNT_CAP_USDC
 *   MONITOR_API_URL / MONITOR_WS_URL / MONITOR_REPLICA_DATABASE_URL
 *   ...and the thresholds in lib/monitor/config.ts, all of which have defaults.
 *
 * Usage:
 *   npm run dev:monitor
 *   npx tsx scripts/monitor.ts --once                  # one tick, then exit
 *   npx tsx scripts/monitor.ts --print-role-baseline    # run this after 99_VerifyDeployment passes
 *   npx tsx scripts/monitor.ts --print-checks           # the check table (id, severity, threshold, runbook)
 */

import { readFileSync } from "node:fs";

import { rpcUrlsFromEnv } from "@/lib/chain/clients";
import type { Env } from "@/lib/chain/networks";
import { bootstrap, runLoop, type Logger, type Metrics } from "@/lib/keepers/runtime";
import { viemMonitorChain } from "@/lib/monitor/chain";
import { loadMonitorConfig, type MonitorConfig } from "@/lib/monitor/config";
import { serveExposure } from "@/lib/monitor/exposition";
import { Monitor } from "@/lib/monitor/monitor";
import {
  detectFormat,
  fanout,
  stdoutNotifier,
  webhookNotifier,
  type Notifier,
  type WebhookFormat,
} from "@/lib/monitor/notifier";
import { realProbes } from "@/lib/monitor/probes";
import { CHECKS } from "@/lib/monitor/registry";
import {
  PROXY_KEYS,
  implementationsFromRecord,
  loadRoleBaseline,
  rolesFor,
  type RoleContractKey,
} from "@/lib/monitor/roles";
import { MonitorStore } from "@/lib/monitor/store";
import { neon } from "@/lib/sql";

const SERVICE = "monitor";
const ONCE = process.argv.includes("--once");
const PRINT_BASELINE = process.argv.includes("--print-role-baseline");
const PRINT_CHECKS = process.argv.includes("--print-checks");

async function main() {
  const env = process.env;

  // Needs no network, database or key: it is the documentation of the rules.
  if (PRINT_CHECKS) {
    process.stdout.write(checkTable(loadMonitorConfig(env, [])));
    return;
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = neon(databaseUrl);
  const ctx = await bootstrap({ service: SERVICE, sql, env });
  const cfg = loadMonitorConfig(env, rpcUrlsFromEnv(ctx.network, env));
  const chain = viemMonitorChain(ctx.client, ctx.contracts);

  if (PRINT_BASELINE) {
    const members = await chain.roleMembers();
    const out: Record<string, unknown> = { _network: ctx.network.id, _generatedAt: new Date().toISOString() };
    for (const k of [...PROXY_KEYS, "timelock"] as RoleContractKey[]) {
      out[k] = Object.fromEntries(rolesFor(k).map((r) => [r, members[k]?.[r] ?? []]));
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    await sql.end();
    return;
  }

  const probes = realProbes({ replicaUrl: cfg.infra.replicaUrl });
  const monitor = new Monitor({
    cfg,
    network: ctx.network.id,
    contracts: ctx.contracts,
    chain,
    store: new MonitorStore(sql, ctx.network.id),
    probes,
    roleBaseline: loadRoleBaseline(cfg.roleBaselineFile),
    deploymentRecord: cfg.deploymentFile
      ? implementationsFromRecord(readFileSync(cfg.deploymentFile, "utf8"), ctx.contracts)
      : new Map(),
    log: ctx.log,
    metrics: ctx.metrics,
    notifier: notifiers(env, ctx.log, ctx.metrics),
    persist: cfg.snapshot ? sql : null,
  });

  const exposure = cfg.http
    ? serveExposure({
        ...cfg.http,
        metrics: ctx.metrics,
        view: () => monitor.view(),
        // Three missed ticks: enough that a slow tick is not a restart signal.
        stallAfterMs: cfg.intervalMs * 3,
      })
    : null;

  ctx.log.info("monitor starting", {
    tickMs: cfg.intervalMs,
    checks: CHECKS.length,
    http: cfg.http ? `${cfg.http.host}:${cfg.http.port}` : "disabled",
    snapshot: cfg.snapshot,
    gasTargets: cfg.gas.targets.map((t) => t.name),
    roleBaseline: cfg.roleBaselineFile ?? "none",
    alerting: cfg.alerting,
  });

  if (ONCE) {
    const view = await monitor.tick();
    process.stdout.write(
      `${JSON.stringify(
        {
          level: view.level,
          failing: view.results.filter((r) => r.status === "fail").map((r) => r.key),
          errors: view.results.filter((r) => r.status === "error").map((r) => r.key),
        },
        null,
        2
      )}\n`
    );
  } else {
    await runLoop({ tickMs: cfg.intervalMs, signal: ctx.shutdown.signal, log: ctx.log, metrics: ctx.metrics }, async () => {
      await monitor.tick();
    });
  }

  await exposure?.close();
  await probes.close();
  await sql.end();
  ctx.log.info("monitor stopped");
  process.exit(0);
}

function notifiers(env: Env, log: Logger, metrics: Metrics): Notifier {
  const list: Notifier[] = [stdoutNotifier(log)];
  const url = env.ALERT_WEBHOOK_URL;
  if (url) {
    const format = (env.ALERT_WEBHOOK_FORMAT as WebhookFormat | undefined) ?? detectFormat(url);
    list.push(webhookNotifier({ url, network: "", format, chatId: env.ALERT_TELEGRAM_CHAT_ID }));
  } else {
    // The 2026-07 outage went 21 days undetected because every failure was
    // logged to nowhere. Alerts still reach this log; nobody watches a log.
    log.error("ALERT_WEBHOOK_URL is not set: alerts will be logged and delivered NOWHERE");
  }
  return fanout(list, log, metrics);
}

function checkTable(cfg: MonitorConfig): string {
  const rows = CHECKS.map((c) => [c.id, c.severity, c.threshold(cfg), c.runbook, c.description]);
  const head = ["check", "severity", "threshold", "runbook", "protects"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: readonly string[]) => `| ${cells.map((c, i) => c.padEnd(w[i])).join(" | ")} |`;
  return `${[line(head), `|${w.map((n) => "-".repeat(n + 2)).join("|")}|`, ...rows.map(line)].join("\n")}\n`;
}

main().catch((err) => {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), level: "error", service: SERVICE, msg: "fatal", error: String(err) })
  );
  process.exit(1);
});
