/**
 * The monitor's only writes: one row of current status per network, and one
 * row per alert transition.
 *
 * `MonitorStatus` is upserted, so it stays one row however long the monitor
 * runs; the status page reads it and needs no history. `MonitorAlert` is
 * append-only but only on a transition (fire, reminder, resolve), so it grows
 * with incidents rather than with ticks.
 */

import type { Queryable } from "@/lib/queries/client";

import type { AlertEvent } from "./alerting";
import type { MonitorSnapshotView } from "./exposition";

export async function writeStatus(q: Queryable, view: MonitorSnapshotView): Promise<void> {
  const checks = view.results.map((r) => ({
    key: r.key,
    check: r.check,
    subject: r.subject,
    status: r.status,
    severity: r.severity,
    detail: r.detail,
    values: r.values,
    runbook: r.runbook,
  }));
  const firing = view.firing.map((f) => ({
    key: f.key,
    check: f.check,
    subject: f.subject,
    severity: f.severity,
    detail: f.detail,
    since: new Date(f.firstFailedAt).toISOString(),
  }));
  await q.query(
    `INSERT INTO "MonitorStatus" ("network", "level", "checks", "firing", "tickAt", "tickDurationMs", "updatedAt")
     VALUES ($1, $2::"MonitorLevel", $3::jsonb, $4::jsonb, $5, $6, now())
     ON CONFLICT ("network") DO UPDATE SET
       "level" = EXCLUDED."level",
       "checks" = EXCLUDED."checks",
       "firing" = EXCLUDED."firing",
       "tickAt" = EXCLUDED."tickAt",
       "tickDurationMs" = EXCLUDED."tickDurationMs",
       "updatedAt" = now()`,
    [view.network, view.level, JSON.stringify(checks), JSON.stringify(firing), new Date(view.tickAt), view.tickDurationMs]
  );
}

export async function writeAlert(q: Queryable, network: string, e: AlertEvent): Promise<void> {
  await q.query(
    `INSERT INTO "MonitorAlert" ("network", "alertKey", "check", "subject", "severity", "event", "detail", "values", "runbook", "forSecs")
     VALUES ($1, $2, $3, $4, $5::"MonitorSeverity", $6::"MonitorAlertEvent", $7, $8::jsonb, $9, $10)`,
    [
      network,
      e.key,
      e.check,
      e.subject,
      e.severity,
      e.kind.toUpperCase(),
      e.detail.slice(0, 2_000),
      JSON.stringify(e.values),
      e.runbook || null,
      e.forSecs,
    ]
  );
}
