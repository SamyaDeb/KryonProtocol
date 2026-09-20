#!/usr/bin/env tsx
/**
 * venue-gate — is this venue ready to open, and does it agree with itself?
 *
 *   npm run gate:venue              # exits 1 if a check fails
 *   npm run gate:venue -- --strict  # a check that could not run also fails
 *   npm run gate:venue -- --json    # machine-readable, for a deploy workflow
 *
 * Three questions, in order:
 *
 *   1. Consistency (this script). Do the deployment record, the chain, the
 *      app's API and the indexed database describe the same venue? A testnet
 *      goes quietly wrong here: an app on yesterday's addresses, a database
 *      indexed from another deployment, or markets the index calls inactive
 *      while the chain has them live — which rejects every order.
 *   2. Health (the monitor's own checks, run once here): oracle freshness,
 *      RPC, database, indexer lag, settlement, keeper gas, solvency, roles,
 *      implementation drift. No alert is sent: a gate must not page anyone.
 *   3. Contracts — NOT here. `arc-forge script script/99_VerifyDeployment.s.sol`
 *      verifies roles, wiring, fees and risk parameters against the
 *      environment TOML, and is read-only. Run it first.
 *
 * Read-only: no key, no transaction, no write. Safe against any network.
 *
 * Environment: the monitor's (KRYON_NETWORK, ARC_RPC_URLS, DATABASE_URL,
 * KRYON_DEPLOYMENT_FILE, MONITOR_*), plus KRYON_APP_URL for the app to probe
 * (default http://localhost:3000).
 */

import { readFileSync } from "node:fs";

import { rpcUrlsFromEnv } from "@/lib/chain/clients";
import { riskParamsAbi, vaultAbi } from "@/lib/chain/contracts";
import { assertServiceConfig } from "@/lib/config-check";
import { bootstrap } from "@/lib/keepers/runtime";
import { viemMonitorChain } from "@/lib/monitor/chain";
import { loadMonitorConfig } from "@/lib/monitor/config";
import { Monitor } from "@/lib/monitor/monitor";
import { stdoutNotifier } from "@/lib/monitor/notifier";
import { realProbes } from "@/lib/monitor/probes";
import { implementationsFromRecord, loadRoleBaseline } from "@/lib/monitor/roles";
import { MonitorStore } from "@/lib/monitor/store";
import {
  checkApiConfig,
  checkApiMarkets,
  checkDeploymentCode,
  checkMarketParity,
  checkReady,
  describeCaps,
  renderChecks,
  summarise,
  type GateCheck,
  type MarketRow,
} from "@/lib/ops/venue-gate";
import { neon } from "@/lib/sql";

const JSON_OUT = process.argv.includes("--json");
/** Treat "could not run" as a failure too: what a go-live gate wants. */
const STRICT = process.argv.includes("--strict");
const APP = (process.env.KRYON_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { cache: "no-store" });
  try {
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } catch {
    return { status: res.status, body: {} };
  }
}

async function main() {
  // The gate reads the chain and the database, so it needs the monitor's config.
  assertServiceConfig("monitor");
  const env = process.env;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = neon(databaseUrl);
  const ctx = await bootstrap({ service: "venue-gate", sql, env });
  const network = ctx.network.id;
  const checks: GateCheck[] = [];

  // ── 1. Consistency ────────────────────────────────────────────────────────
  const codes = await Promise.all(
    Object.values(ctx.contracts).map((address) => ctx.client.getCode({ address }).catch(() => undefined))
  );
  const withCode = new Set(
    Object.values(ctx.contracts).filter((_, i) => (codes[i]?.length ?? 0) > 2)
  );
  checks.push(checkDeploymentCode(ctx.contracts, (a) => withCode.has(a)));

  const ids = (await ctx.client.readContract({
    address: ctx.contracts.riskParams,
    abi: riskParamsAbi,
    functionName: "marketIds",
  })) as readonly number[];
  const onChain: MarketRow[] = [];
  for (const id of ids) {
    const m = await ctx.client.readContract({
      address: ctx.contracts.riskParams,
      abi: riskParamsAbi,
      functionName: "market",
      args: [id],
    });
    onChain.push({ id: Number(id), active: m.active });
  }

  const rows = await sql.query<{ id: number; active: boolean }[]>(
    `SELECT "id", "active" FROM "Market" WHERE "network" = $1 ORDER BY "id"`,
    [network]
  );
  checks.push(checkMarketParity(rows.map((r) => ({ id: Number(r.id), active: r.active })), onChain));

  const [caps, deposited] = await Promise.all([
    ctx.client.readContract({ address: ctx.contracts.vault, abi: vaultAbi, functionName: "depositCaps" }),
    ctx.client.readContract({ address: ctx.contracts.vault, abi: vaultAbi, functionName: "totalDeposited" }),
  ]);
  checks.push(describeCaps(caps[0], caps[1], deposited));

  // The app: its own config, readiness and market list.
  try {
    const cfg = await getJson(`${APP}/api/config?network=${network}`);
    checks.push(
      cfg.status === 200
        ? checkApiConfig(cfg.body as never, ctx.contracts, ctx.network.chainId, network)
        : { id: "api.config", status: "fail" as const, detail: `GET /api/config returned ${cfg.status}` }
    );
    const ready = await getJson(`${APP}/api/ready?network=${network}`);
    checks.push(checkReady(ready.status, ready.body));
    const markets = await getJson(`${APP}/api/markets?network=${network}`);
    const served = (markets.body.markets as { market_id: number; active: boolean }[] | undefined) ?? [];
    checks.push(
      markets.status === 200
        ? checkApiMarkets(served.map((m) => ({ id: m.market_id, active: m.active })), onChain)
        : { id: "api.markets", status: "fail" as const, detail: `GET /api/markets returned ${markets.status}` }
    );
  } catch (e) {
    checks.push({ id: "api.reachable", status: "fail", detail: `${APP} is not reachable: ${(e as Error).message}` });
  }

  // ── 2. Health: the monitor's checks, once, silently ───────────────────────
  const cfg = loadMonitorConfig(env, rpcUrlsFromEnv(ctx.network, env));
  const probes = realProbes({ replicaUrl: cfg.infra.replicaUrl });
  const monitor = new Monitor({
    cfg,
    network,
    contracts: ctx.contracts,
    chain: viemMonitorChain(ctx.client, ctx.contracts),
    store: new MonitorStore(sql, network),
    probes,
    roleBaseline: loadRoleBaseline(cfg.roleBaselineFile),
    deploymentRecord: cfg.deploymentFile
      ? implementationsFromRecord(readFileSync(cfg.deploymentFile, "utf8"), ctx.contracts)
      : new Map(),
    log: ctx.log,
    metrics: ctx.metrics,
    // Log only: a gate that pages on-call every time CI runs is a gate nobody keeps.
    notifier: stdoutNotifier(ctx.log),
    persist: null,
  });
  const view = await monitor.tick();
  for (const r of view.results) {
    // A skipped check did not run (not configured, or nothing to measure on an
    // empty venue): a warning, not a failure. Everything else is a failure.
    const status = r.status === "pass" ? "ok" : r.status === "skip" ? "warn" : "fail";
    checks.push({
      id: `monitor.${r.key}`,
      status,
      detail: status === "ok" ? (r.detail ?? "pass") : `${r.status}: ${r.detail ?? "no detail"}`,
    });
  }
  await probes.close();
  await sql.end();

  const { ok, failed, warned } = summarise(checks, { strict: STRICT });
  if (JSON_OUT) {
    process.stdout.write(
      `${JSON.stringify({ network, ok, checks }, null, 2)}\n`
    );
  } else {
    process.stdout.write(`\nVenue gate — ${network}\n\n${renderChecks(checks)}\n\n`);
    const warnNote = warned.length > 0 ? ` ${warned.length} check(s) could not run (WARN); most mean the monitor is not configured yet.` : "";
    process.stdout.write(
      ok
        ? `PASS: the venue agrees with itself and every check that ran passed.${warnNote}\n`
        : `FAIL: ${failed.length} of ${checks.length} checks failed.${warnNote}\n`
    );
    if (!ok) process.stdout.write("Contracts are verified separately: arc-forge script script/99_VerifyDeployment.s.sol\n");
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`venue-gate: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
