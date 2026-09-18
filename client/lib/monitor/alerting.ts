/**
 * When a failing check becomes an alert.
 *
 * The rules, and why each exists:
 *
 *  - **Fire after N consecutive failing ticks.** One tick that catches a
 *    liquidatable account mid-liquidation, or an RPC that blipped, is not an
 *    incident. Checks that are already durable by nature (solvency) set
 *    `failAfter: 1`.
 *  - **Resolve after M consecutive passing ticks**, so a flapping check does
 *    not produce a resolve/fire pair every 30 seconds.
 *  - **Re-notify on an interval while still failing**, never every tick: a
 *    page repeated 120 times an hour is a page nobody reads.
 *  - **A startup grace period.** A monitor that restarts mid-incident, or
 *    starts before the services it watches, would otherwise page for
 *    everything at once. State is tracked from the first tick; notifications
 *    begin once the grace period is over.
 *  - **`skip` counts as a pass**, so a subject that stops being applicable
 *    (a market whose open interest went to zero) resolves rather than sticking.
 *  - **A subject that disappears** while its check still runs also counts as a
 *    pass, so per-market and per-key alerts clear when the thing is gone.
 *
 * The engine only decides; delivery is the notifier's problem, and a notifier
 * that throws never reaches this class.
 */

import type { CheckResult, Severity } from "./types";

export type AlertKind = "firing" | "reminder" | "resolved";

export interface AlertEvent {
  kind: AlertKind;
  key: string;
  check: string;
  subject: string | null;
  severity: Severity;
  detail: string;
  values: CheckResult["values"];
  runbook: string;
  /** When the failure started. */
  since: number;
  /** Seconds it has been failing (at resolve: how long it lasted). */
  forSecs: number;
}

export interface AlertState {
  key: string;
  check: string;
  subject: string | null;
  severity: Severity;
  firing: boolean;
  failStreak: number;
  passStreak: number;
  firstFailedAt: number;
  lastNotifiedAt: number | null;
  detail: string;
}

export interface AlertEngineOptions {
  failAfter: number;
  resolveAfter: number;
  renotifyMs: number;
  startupGraceMs: number;
  startedAt: number;
  /** Per-check override of `failAfter`. */
  failAfterFor?: (check: string) => number | undefined;
}

export class AlertEngine {
  private readonly states = new Map<string, AlertState>();

  constructor(private readonly o: AlertEngineOptions) {}

  /** Alerts currently firing, worst first. */
  firing(): AlertState[] {
    return [...this.states.values()]
      .filter((s) => s.firing)
      .sort((a, b) => (a.severity === b.severity ? a.key.localeCompare(b.key) : a.severity === "PAGE" ? -1 : 1));
  }

  state(key: string): AlertState | undefined {
    return this.states.get(key);
  }

  /**
   * Fold one tick's results in and return what should be delivered.
   * `ran` names the checks that completed, so subjects that vanished from a
   * check that did run can be resolved (and those from a check that did not
   * run are left alone).
   */
  observe(results: readonly CheckResult[], ran: ReadonlySet<string>, now: number): AlertEvent[] {
    const events: AlertEvent[] = [];
    const seen = new Set<string>();
    const inGrace = now < this.o.startedAt + this.o.startupGraceMs;

    for (const r of results) {
      seen.add(r.key);
      const failing = r.status === "fail" || r.status === "error";
      if (failing) this.onFail(r, now, inGrace, events);
      else this.onPass(r.key, r.detail, now, events);
    }

    // A subject that disappeared from a check that ran is no longer failing.
    for (const [key, s] of this.states) {
      if (seen.has(key) || !ran.has(s.check)) continue;
      this.onPass(key, "no longer reported", now, events);
    }
    return events;
  }

  private failAfter(check: string): number {
    return this.o.failAfterFor?.(check) ?? this.o.failAfter;
  }

  private onFail(r: CheckResult, now: number, inGrace: boolean, events: AlertEvent[]): void {
    const prev = this.states.get(r.key);
    const s: AlertState = prev ?? {
      key: r.key,
      check: r.check,
      subject: r.subject,
      severity: r.severity,
      firing: false,
      failStreak: 0,
      passStreak: 0,
      firstFailedAt: now,
      lastNotifiedAt: null,
      detail: r.detail,
    };
    const escalated = s.firing && r.severity === "PAGE" && s.severity === "WARN";
    s.failStreak += 1;
    s.passStreak = 0;
    s.severity = r.severity;
    s.detail = r.detail;
    if (!prev) s.firstFailedAt = now;
    this.states.set(r.key, s);

    if (!s.firing && s.failStreak < this.failAfter(r.check)) return;
    const event = (kind: AlertKind) => {
      events.push(this.event(kind, r, s, now));
      s.lastNotifiedAt = now;
    };
    if (!s.firing) {
      s.firing = true;
      // In the grace window the state is kept but nothing is delivered; the
      // first tick after it ends notifies whatever is still failing.
      if (!inGrace) event("firing");
      return;
    }
    if (escalated) {
      event("firing");
      return;
    }
    if (inGrace) return;
    if (s.lastNotifiedAt === null) event("firing");
    else if (now - s.lastNotifiedAt >= this.o.renotifyMs) event("reminder");
  }

  private onPass(key: string, detail: string, now: number, events: AlertEvent[]): void {
    const s = this.states.get(key);
    if (!s) return;
    s.passStreak += 1;
    s.failStreak = 0;
    if (s.passStreak < this.o.resolveAfter) return;
    this.states.delete(key);
    if (!s.firing || s.lastNotifiedAt === null) return; // never announced, nothing to resolve
    events.push({
      kind: "resolved",
      key,
      check: s.check,
      subject: s.subject,
      severity: s.severity,
      detail,
      values: {},
      runbook: "",
      since: s.firstFailedAt,
      forSecs: Math.round((now - s.firstFailedAt) / 1000),
    });
  }

  private event(kind: AlertKind, r: CheckResult, s: AlertState, now: number): AlertEvent {
    return {
      kind,
      key: r.key,
      check: r.check,
      subject: r.subject,
      severity: r.severity,
      detail: r.detail,
      values: r.values,
      runbook: r.runbook,
      since: s.firstFailedAt,
      forSecs: Math.round((now - s.firstFailedAt) / 1000),
    };
  }
}

/** PAGE beats WARN beats healthy: the one line `/healthz` and the snapshot report. */
export function overallLevel(firing: readonly AlertState[]): "OK" | "WARN" | "PAGE" {
  if (firing.some((f) => f.severity === "PAGE")) return "PAGE";
  return firing.length > 0 ? "WARN" : "OK";
}
