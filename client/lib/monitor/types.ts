/**
 * The shape every monitor check returns.
 *
 * A check never formats a message for a human and stops there: it returns a
 * structured result, and alerting, `/metrics` and the status snapshot all read
 * the same object. That is what lets the alert text, the Prometheus gauge and
 * the status page agree about what is wrong.
 */

/** PAGE: money or availability at risk. WARN: degraded but safe. */
export type Severity = "PAGE" | "WARN";

/**
 * - `pass`  the thing is healthy.
 * - `fail`  the thing is unhealthy; alerting decides whether to notify.
 * - `error` the check could not run (an RPC or database read failed). Never a
 *           pass: a blind spot is reported, at WARN, like any other fault.
 * - `skip`  deliberately not evaluated (not configured, a stub, or nothing to
 *           watch, like a feed with no open interest). Visible in the snapshot
 *           and `/metrics`, never alerted.
 */
export type CheckStatus = "pass" | "fail" | "error" | "skip";

export type Value = number | string | boolean | null;

export interface CheckResult {
  /** `<check id>` or `<check id>:<subject>`, e.g. `oracle.freshness:BTC`. The alert key. */
  key: string;
  check: string;
  /** Per-market, per-key or per-feed subject; null for protocol-wide checks. */
  subject: string | null;
  status: CheckStatus;
  /** Severity if this result is failing. A check may fail at WARN before it fails at PAGE. */
  severity: Severity;
  detail: string;
  values: Record<string, Value>;
  /** File name under kryon-protocol/infra/deploy/runbooks/. */
  runbook: string;
}

export interface CheckMeta {
  id: string;
  /** The severity the check fails at unless a result says otherwise. */
  severity: Severity;
  runbook: string;
  /** What the check protects, one line. */
  description: string;
  /**
   * Consecutive failing ticks before it fires. Defaults to the engine's
   * `failAfter`; solvency uses 1, since one bad read of it is already news.
   */
  failAfter?: number;
}

/** Build results for one check without repeating its id, severity and runbook. */
export function resultsFor(meta: CheckMeta) {
  const make =
    (status: CheckStatus) =>
    (detail: string, values: Record<string, Value> = {}, o: { subject?: string | null; severity?: Severity } = {}): CheckResult => ({
      key: o.subject ? `${meta.id}:${o.subject}` : meta.id,
      check: meta.id,
      subject: o.subject ?? null,
      status,
      severity: status === "error" ? "WARN" : (o.severity ?? meta.severity),
      detail,
      values,
      runbook: meta.runbook,
    });
  return { pass: make("pass"), fail: make("fail"), error: make("error"), skip: make("skip") };
}

/**
 * A per-subject check with nothing to report still has to report something:
 * a check that returns no results at all is invisible in `/metrics` and in the
 * snapshot, and the alert engine cannot resolve what it never saw.
 */
export function orNothingToCheck(results: CheckResult[], meta: CheckMeta, detail: string): CheckResult[] {
  return results.length > 0 ? results : [resultsFor(meta).pass(detail)];
}

/** 1e18 fixed point → a float for gauges and messages. Never used for a comparison. */
export function toFloat18(v: bigint): number {
  return Number(v / 10n ** 10n) / 1e8;
}

export function usd18(v: bigint): string {
  const n = toFloat18(v);
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtSecs(s: number): string {
  if (!Number.isFinite(s)) return "never";
  if (s < 120) return `${Math.round(s)}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
