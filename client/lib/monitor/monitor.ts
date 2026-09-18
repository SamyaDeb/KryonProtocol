/**
 * One monitor tick: run every check, fold the results into the alert engine,
 * deliver whatever transitioned, publish the snapshot.
 *
 * Nothing in a tick may take the loop down. A check that throws is an `error`
 * result, a notifier that throws is caught by `fanout`, and a database that
 * refuses the snapshot write is logged — the alerts still went out, and the
 * `infra.db` check reports the database itself.
 */

import type { Logger, Metrics } from "@/lib/keepers/runtime";
import type { Queryable } from "@/lib/queries/client";

import { AlertEngine, overallLevel, type AlertEvent } from "./alerting";
import type { MonitorChain } from "./chain";
import type { MonitorConfig } from "./config";
import { memo, type CheckContext, type Probes } from "./context";
import type { MonitorSnapshotView } from "./exposition";
import type { Notifier } from "./notifier";
import { CHECKS, runChecks } from "./registry";
import type { ExpectedImpl, RoleMembership } from "./roles";
import { writeAlert, writeStatus } from "./snapshot";
import type { MonitorStore } from "./store";
import type { CheckResult } from "./types";

export interface MonitorOptions {
  cfg: MonitorConfig;
  network: string;
  contracts: CheckContext["contracts"];
  chain: MonitorChain;
  store: MonitorStore;
  probes: Probes;
  roleBaseline: RoleMembership | null;
  deploymentRecord: Map<string, ExpectedImpl>;
  log: Logger;
  metrics: Metrics;
  notifier: Notifier;
  /** Where the status snapshot goes; null disables persistence. */
  persist: Queryable | null;
  now?: () => number;
}

export class Monitor {
  readonly engine: AlertEngine;
  private readonly now: () => number;
  private latest: MonitorSnapshotView | null = null;

  constructor(private readonly o: MonitorOptions) {
    this.now = o.now ?? Date.now;
    this.engine = new AlertEngine({
      ...o.cfg.alerting,
      startedAt: this.now(),
      failAfterFor: (id) => CHECKS.find((c) => c.id === id)?.failAfter,
    });
  }

  view(): MonitorSnapshotView | null {
    return this.latest;
  }

  async tick(): Promise<MonitorSnapshotView> {
    const ctx: CheckContext = {
      cfg: this.o.cfg,
      network: this.o.network,
      contracts: this.o.contracts,
      chain: this.o.chain,
      store: this.o.store,
      probes: this.o.probes,
      roleBaseline: this.o.roleBaseline,
      deploymentRecord: this.o.deploymentRecord,
      now: this.now,
      once: memo(),
    };

    const { results, ran, durationMs } = await runChecks(ctx);
    const at = this.now();
    const events = this.engine.observe(results, ran, at);
    const firing = this.engine.firing();
    const view: MonitorSnapshotView = {
      network: this.o.network,
      level: overallLevel(firing),
      tickAt: at,
      tickDurationMs: durationMs,
      results,
      firing,
    };
    this.latest = view;
    this.record(results, view, events);

    for (const e of events) await this.o.notifier.send(e, { network: this.o.network });
    await this.persist(view, events);

    const failing = results.filter((r) => r.status === "fail");
    const errored = results.filter((r) => r.status === "error");
    this.o.log.info("tick", {
      level: view.level,
      checks: results.length,
      failing: failing.length,
      errors: errored.length,
      firing: firing.length,
      events: events.length,
      durationMs,
      worst: firing.slice(0, 3).map((f) => f.key),
    });
    return view;
  }

  private record(results: readonly CheckResult[], view: MonitorSnapshotView, events: readonly AlertEvent[]): void {
    const m = this.o.metrics;
    const count = (s: CheckResult["status"]) => results.filter((r) => r.status === s).length;
    m.gauge("checks_total", results.length);
    m.gauge("checks_failing", count("fail"));
    m.gauge("checks_error", count("error"));
    m.gauge("checks_skipped", count("skip"));
    m.gauge("alerts_firing", view.firing.length);
    m.gauge("alerts_firing_page", view.firing.filter((f) => f.severity === "PAGE").length);
    m.gauge("tick_duration_ms", view.tickDurationMs);
    for (const e of events) m.inc(`alert_events_total.${e.kind}`);
  }

  private async persist(view: MonitorSnapshotView, events: readonly AlertEvent[]): Promise<void> {
    if (!this.o.persist || !this.o.cfg.snapshot) return;
    try {
      await writeStatus(this.o.persist, view);
      for (const e of events) await writeAlert(this.o.persist, this.o.network, e);
    } catch (err) {
      this.o.metrics.inc("snapshot_write_failures_total");
      this.o.log.error("could not write the monitor snapshot; alerting is unaffected", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
