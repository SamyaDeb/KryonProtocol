/**
 * Economics and infrastructure: the fill mix pays for its own gas, and the
 * things every other check depends on (RPC, database, API, WS) are reachable.
 */

import { utcDay } from "@/lib/keepers/runtime";

import type { MonitorConfig } from "../config";
import type { Check } from "../context";
import { fmtSecs, resultsFor, toFloat18, usd18, type CheckMeta, type CheckResult } from "../types";

// ─── fees versus gas ────────────────────────────────────────────────────────

export const FEES_VS_GAS: CheckMeta = {
  id: "economics.fees-vs-gas",
  severity: "WARN",
  runbook: "service-degraded.md",
  description: "Fees accrued cover the gas the services spent, per UTC day",
};

/** Both sides are 1e18: FeeAccrual in ledger units, GasSpend in wei of 18-decimal native USDC. */
export function evaluateFeesVsGas(
  days: readonly { day: string; fees: bigint; gas: bigint }[],
  minGas: bigint
): CheckResult[] {
  const r = resultsFor(FEES_VS_GAS);
  const values: Record<string, number | string> = {};
  for (const d of days) {
    values[`fees.${d.day}`] = toFloat18(d.fees);
    values[`gas.${d.day}`] = toFloat18(d.gas);
  }
  const bad = days.filter((d) => d.gas > d.fees && d.gas >= minGas);
  if (bad.length === 0) {
    const today = days[days.length - 1];
    return [r.pass(today ? `${today.day}: fees ${usd18(today.fees)} vs gas ${usd18(today.gas)}` : "no days to compare", values)];
  }
  const parts = bad.map((d) => `${d.day}: gas ${usd18(d.gas)} > fees ${usd18(d.fees)}`);
  return [r.fail(`the fill mix is not paying for its gas — ${parts.join("; ")}`, values)];
}

// ─── RPC ────────────────────────────────────────────────────────────────────

export const RPC: CheckMeta = {
  id: "infra.rpc",
  severity: "WARN",
  runbook: "service-degraded.md",
  description: "Which RPC endpoint is serving, and whether the fallback is in use",
};

export interface RpcProbe {
  url: string;
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

/** The transport tries the configured order, so the first healthy endpoint is the one serving. */
export function evaluateRpc(probes: readonly RpcProbe[], latencyWarnMs: number): CheckResult[] {
  const r = resultsFor(RPC);
  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  const values: Record<string, number | string | boolean | null> = { endpoints: probes.length };
  probes.forEach((p, i) => {
    values[`latencyMs.${i}.${host(p.url)}`] = p.ok ? p.latencyMs : null;
  });
  const serving = probes.findIndex((p) => p.ok);
  if (serving === -1) {
    return [r.fail(`every RPC endpoint is down: ${probes.map((p) => `${host(p.url)} (${p.error ?? "failed"})`).join(", ")}`, values)];
  }
  values.servingIndex = serving;
  values.serving = host(probes[serving].url);
  const latency = probes[serving].latencyMs ?? 0;
  if (serving > 0) {
    return [
      r.fail(
        `primary RPC ${host(probes[0].url)} is down (${probes[0].error ?? "failed"}); serving from fallback ${host(probes[serving].url)}`,
        values
      ),
    ];
  }
  if (latency > latencyWarnMs) {
    return [r.fail(`RPC ${host(probes[0].url)} responded in ${Math.round(latency)}ms (> ${latencyWarnMs}ms)`, values)];
  }
  return [r.pass(`serving from ${host(probes[0].url)} in ${Math.round(latency)}ms`, values)];
}

// ─── database ───────────────────────────────────────────────────────────────

export const DB: CheckMeta = {
  id: "infra.db",
  severity: "WARN",
  runbook: "service-degraded.md",
  description: "Database round-trip latency",
};

export function evaluateDb(latencyMs: number, warnMs: number): CheckResult[] {
  const r = resultsFor(DB);
  const values = { latencyMs: Math.round(latencyMs), warnMs };
  return [
    latencyMs > warnMs
      ? r.fail(`database round trip ${Math.round(latencyMs)}ms (> ${warnMs}ms)`, values)
      : r.pass(`database round trip ${Math.round(latencyMs)}ms`, values),
  ];
}

export const REPLICA: CheckMeta = {
  id: "infra.db-replica",
  severity: "WARN",
  runbook: "service-degraded.md",
  description: "Read-replica replication lag",
};

export function evaluateReplica(configured: boolean, lagSecs: number | null, maxSecs: number): CheckResult[] {
  const r = resultsFor(REPLICA);
  if (!configured) return [r.skip("MONITOR_REPLICA_DATABASE_URL not set: no replica to watch")];
  if (lagSecs === null) return [r.fail("the configured replica reports that it is not in recovery: it is not a replica")];
  const values = { lagSecs: Math.round(lagSecs), maxSecs };
  return [
    lagSecs > maxSecs
      ? r.fail(`replica is ${fmtSecs(lagSecs)} behind (> ${maxSecs}s): reads from it are stale`, values)
      : r.pass(`replica ${fmtSecs(lagSecs)} behind`, values),
  ];
}

// ─── API and WS ─────────────────────────────────────────────────────────────

export const API: CheckMeta = {
  id: "infra.api",
  severity: "PAGE",
  runbook: "service-degraded.md",
  description: "The app's /api/health responds",
};

export function evaluateApi(url: string | null, status: number | null, error: string | null): CheckResult[] {
  const r = resultsFor(API);
  if (!url) return [r.skip("MONITOR_API_URL not set: the API is not being checked")];
  if (error !== null) return [r.fail(`${url}/api/health unreachable: ${error}`, { status: null })];
  if (status === null || status < 200 || status >= 300) return [r.fail(`${url}/api/health returned HTTP ${status}`, { status })];
  return [r.pass(`/api/health HTTP ${status}`, { status })];
}

export const WS: CheckMeta = {
  id: "infra.ws",
  severity: "WARN",
  runbook: "service-degraded.md",
  description: "The WebSocket server answers a protocol ping with a pong",
};

/**
 * A full protocol round trip, not a connect: `scripts/ws-server.ts` answers
 * `{"type":"ping"}` with `{"type":"pong"}`, and a server that accepts sockets
 * while answering nothing is exactly the failure a connect-only check misses.
 */
export function evaluateWs(url: string | null, error: string | null): CheckResult[] {
  const r = resultsFor(WS);
  if (!url) {
    return [r.skip("MONITOR_WS_URL not set: the WebSocket server is not being checked")];
  }
  if (error !== null) return [r.fail(`WebSocket ${url} did not answer a ping: ${error}`, { pong: false })];
  return [r.pass(`WebSocket ${url} answered ping with pong`, { pong: true })];
}

// ─── the checks ─────────────────────────────────────────────────────────────

export const infraChecks: Check[] = [
  {
    ...FEES_VS_GAS,
    threshold: (cfg: MonitorConfig) => `gas > fees on a day with ≥ ${usd18(cfg.fees.minGasUsd)} of gas`,
    run: async (c) => {
      const now = new Date(c.now());
      const days = [utcDay(new Date(now.getTime() - 86_400_000)), utcDay(now)];
      return evaluateFeesVsGas(await c.store.feesAndGas(days), c.cfg.fees.minGasUsd);
    },
  },
  {
    ...RPC,
    threshold: (cfg) => `fallback in use, or serving endpoint slower than ${cfg.infra.rpcLatencyWarnMs}ms`,
    run: async (c) => {
      const probes = await Promise.all(
        c.cfg.infra.rpcUrls.map(async (url): Promise<RpcProbe> => {
          try {
            const { latencyMs } = await c.probes.rpc(url);
            return { url, ok: true, latencyMs };
          } catch (err) {
            return { url, ok: false, latencyMs: null, error: String(err instanceof Error ? err.message : err).slice(0, 120) };
          }
        })
      );
      return evaluateRpc(probes, c.cfg.infra.rpcLatencyWarnMs);
    },
  },
  {
    ...DB,
    threshold: (cfg) => `SELECT 1 slower than ${cfg.infra.dbLatencyWarnMs}ms`,
    run: async (c) => evaluateDb(await c.store.ping(c.now), c.cfg.infra.dbLatencyWarnMs),
  },
  {
    ...REPLICA,
    threshold: (cfg) => `replay lag > ${cfg.infra.replicaLagSecs}s`,
    run: async (c) =>
      evaluateReplica(c.cfg.infra.replicaUrl !== null, c.cfg.infra.replicaUrl ? await c.probes.replicaLag() : null, c.cfg.infra.replicaLagSecs),
  },
  {
    ...API,
    threshold: () => "non-2xx or unreachable",
    run: async (c) => {
      const url = c.cfg.infra.apiUrl;
      if (!url) return evaluateApi(null, null, null);
      try {
        return evaluateApi(url, await c.probes.http(`${url.replace(/\/$/, "")}/api/health`), null);
      } catch (err) {
        return evaluateApi(url, null, String(err instanceof Error ? err.message : err).slice(0, 120));
      }
    },
  },
  {
    ...WS,
    threshold: () => "no pong (refused, silent or timed out)",
    run: async (c) => {
      const url = c.cfg.infra.wsUrl;
      if (!url) return evaluateWs(null, null);
      try {
        await c.probes.ws(url);
        return evaluateWs(url, null);
      } catch (err) {
        return evaluateWs(url, String(err instanceof Error ? err.message : err).slice(0, 120));
      }
    },
  },
];
