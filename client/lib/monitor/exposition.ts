/**
 * `/healthz`, `/metrics` and `/status` for the monitor process.
 *
 * `/healthz` answers about the *monitor*, not the protocol: 200 while it is
 * ticking, 503 when its own loop has stalled. Whether the protocol is healthy
 * is what the alerts and `/status` are for — a supervisor that restarted the
 * monitor because the protocol was unwell would take away the only thing
 * still reporting.
 */

import { createServer, type Server } from "node:http";

import type { Metrics } from "@/lib/keepers/runtime";

import type { AlertState } from "./alerting";
import type { CheckResult } from "./types";

export interface MonitorSnapshotView {
  network: string;
  level: "OK" | "WARN" | "PAGE";
  tickAt: number;
  tickDurationMs: number;
  results: CheckResult[];
  firing: AlertState[];
}

const LEVEL_CODE = { OK: 0, WARN: 1, PAGE: 2 } as const;

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
const labels = (l: Record<string, string>) =>
  Object.entries(l)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(",");

/** Prometheus text format. Values that are numbers become gauges; the rest are labels. */
export function prometheus(view: MonitorSnapshotView | null, metrics: Metrics, nowMs: number): string {
  const out: string[] = [];
  const line = (name: string, l: Record<string, string>, v: number) => out.push(`${name}{${labels(l)}} ${v}`);

  out.push("# HELP kryon_monitor_up 1 while the monitor process is serving.");
  out.push("# TYPE kryon_monitor_up gauge");
  out.push(`kryon_monitor_up 1`);

  if (view) {
    out.push("# HELP kryon_monitor_level 0 = OK, 1 = WARN firing, 2 = PAGE firing.");
    out.push("# TYPE kryon_monitor_level gauge");
    line("kryon_monitor_level", { network: view.network }, LEVEL_CODE[view.level]);
    out.push("# TYPE kryon_monitor_last_tick_seconds gauge");
    line("kryon_monitor_last_tick_seconds", { network: view.network }, Math.round(view.tickAt / 1000));
    out.push("# TYPE kryon_monitor_tick_age_seconds gauge");
    line("kryon_monitor_tick_age_seconds", { network: view.network }, Math.round((nowMs - view.tickAt) / 1000));
    out.push("# TYPE kryon_monitor_tick_duration_ms gauge");
    line("kryon_monitor_tick_duration_ms", { network: view.network }, view.tickDurationMs);

    out.push("# HELP kryon_monitor_check 1 = pass, 0 = fail, -1 = could not run, 2 = skipped.");
    out.push("# TYPE kryon_monitor_check gauge");
    const code = { pass: 1, fail: 0, error: -1, skip: 2 };
    for (const r of view.results) {
      line("kryon_monitor_check", { check: r.check, subject: r.subject ?? "", severity: r.severity, runbook: r.runbook }, code[r.status]);
    }

    out.push("# HELP kryon_monitor_check_value A numeric value a check measured.");
    out.push("# TYPE kryon_monitor_check_value gauge");
    for (const r of view.results) {
      for (const [name, v] of Object.entries(r.values)) {
        if (typeof v === "number" && Number.isFinite(v)) line("kryon_monitor_check_value", { check: r.check, subject: r.subject ?? "", name }, v);
        if (typeof v === "boolean") line("kryon_monitor_check_value", { check: r.check, subject: r.subject ?? "", name }, v ? 1 : 0);
      }
    }

    out.push("# HELP kryon_monitor_alert_firing An alert that has fired and not resolved.");
    out.push("# TYPE kryon_monitor_alert_firing gauge");
    for (const f of view.firing) {
      line("kryon_monitor_alert_firing", { check: f.check, subject: f.subject ?? "", severity: f.severity }, 1);
    }
    out.push("# TYPE kryon_monitor_alerts_firing_total gauge");
    line("kryon_monitor_alerts_firing_total", { network: view.network, severity: "PAGE" }, view.firing.filter((f) => f.severity === "PAGE").length);
    line("kryon_monitor_alerts_firing_total", { network: view.network, severity: "WARN" }, view.firing.filter((f) => f.severity === "WARN").length);
  }

  const snap = metrics.snapshot();
  out.push("# HELP kryon_monitor_runtime The monitor's own counters and gauges.");
  out.push("# TYPE kryon_monitor_runtime gauge");
  for (const [k, v] of Object.entries(snap.counters)) line("kryon_monitor_runtime", { name: k }, Number(v));
  for (const [k, v] of Object.entries(snap.gauges)) line("kryon_monitor_runtime", { name: k }, v);
  return `${out.join("\n")}\n`;
}

export function statusJson(view: MonitorSnapshotView | null, nowMs: number): unknown {
  if (!view) return { status: "starting" };
  return {
    network: view.network,
    level: view.level,
    tickAt: new Date(view.tickAt).toISOString(),
    tickAgeSecs: Math.round((nowMs - view.tickAt) / 1000),
    tickDurationMs: view.tickDurationMs,
    firing: view.firing.map((f) => ({
      key: f.key,
      severity: f.severity,
      detail: f.detail,
      since: new Date(f.firstFailedAt).toISOString(),
    })),
    checks: view.results.map((r) => ({
      key: r.key,
      status: r.status,
      severity: r.severity,
      detail: r.detail,
      runbook: r.runbook,
      values: r.values,
    })),
  };
}

export interface ExposureOptions {
  host: string;
  port: number;
  metrics: Metrics;
  /** The latest tick, or null before the first one completes. */
  view: () => MonitorSnapshotView | null;
  /** The monitor's loop is considered stalled after this long without a tick. */
  stallAfterMs: number;
  now?: () => number;
}

export function serveExposure(o: ExposureOptions): { server: Server; close: () => Promise<void> } {
  const now = o.now ?? Date.now;
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const view = o.view();
    const send = (code: number, type: string, body: string) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };
    if (url === "/metrics") return send(200, "text/plain; version=0.0.4", prometheus(view, o.metrics, now()));
    if (url === "/status") return send(200, "application/json", JSON.stringify(statusJson(view, now()), null, 2));
    if (url === "/healthz") {
      const ageMs = view ? now() - view.tickAt : 0;
      const ticking = view !== null && ageMs < o.stallAfterMs;
      // Before the first tick the process is starting, which is healthy.
      const ok = view === null || ticking;
      return send(ok ? 200 : 503, "application/json", JSON.stringify({ ok, ticking, ageMs, level: view?.level ?? "starting" }));
    }
    send(404, "text/plain", "not found\n");
  });
  server.listen(o.port, o.host);
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
