/**
 * The comparison behind the nightly check: does a full recompute reproduce
 * what the incremental passes wrote?
 *
 * Pure, so the aggregator's honesty check and the test that asserts
 * "incremental equals rebuild" run the same code. `updatedAt` is not compared:
 * when a row was written says nothing about whether it is right.
 */

import type { AccountAnalyticsRow, TraderStatRow } from "./metrics";

export interface Mismatch {
  table: "TraderStat" | "AccountAnalytics";
  key: string;
  /** Absent when the whole row is missing or unexpected. */
  field?: string;
  stored?: string;
  computed?: string;
}

type Row = Record<string, unknown>;

const show = (v: unknown): string =>
  v === null || v === undefined ? "null" : v instanceof Date ? v.toISOString() : String(v);

function diffRows(table: Mismatch["table"], stored: Map<string, Row>, computed: Map<string, Row>): Mismatch[] {
  const out: Mismatch[] = [];
  for (const [key, want] of computed) {
    const have = stored.get(key);
    if (!have) {
      out.push({ table, key, computed: "row missing from the table" });
      continue;
    }
    for (const field of Object.keys(want)) {
      const a = show(have[field]);
      const b = show(want[field]);
      if (a !== b) out.push({ table, key, field, stored: a, computed: b });
    }
  }
  for (const key of stored.keys()) {
    if (!computed.has(key)) out.push({ table, key, stored: "row the recompute does not produce" });
  }
  return out;
}

const byKey = <T extends { address: string }>(rows: readonly T[], key: (r: T) => string): Map<string, Row> =>
  new Map(rows.map((r) => [key(r), r as unknown as Row]));

/** Every difference between what is stored and what a full recompute produces. */
export function diffStats(
  stored: { traderStats: readonly TraderStatRow[]; analytics: readonly AccountAnalyticsRow[] },
  computed: { traderStats: readonly TraderStatRow[]; analytics: readonly AccountAnalyticsRow[] }
): Mismatch[] {
  const statKey = (r: TraderStatRow) => `${r.address}|${r.period}`;
  const acctKey = (r: AccountAnalyticsRow) => r.address;
  return [
    ...diffRows("TraderStat", byKey(stored.traderStats, statKey), byKey(computed.traderStats, statKey)),
    ...diffRows("AccountAnalytics", byKey(stored.analytics, acctKey), byKey(computed.analytics, acctKey)),
  ];
}

/** A few mismatches, short enough for a log line. */
export function describeMismatches(all: readonly Mismatch[], limit = 5): string[] {
  return all.slice(0, limit).map((m) =>
    m.field
      ? `${m.table}[${m.key}].${m.field}: stored ${m.stored} vs computed ${m.computed}`
      : `${m.table}[${m.key}]: ${m.computed ?? m.stored}`
  );
}
