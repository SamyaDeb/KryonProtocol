/**
 * Counters the matcher exposes for health and dashboards (plan §4.2.7).
 *
 * Plain numbers on one object: the service prints them as a structured log
 * line each tick and serves them on its health endpoint. Nothing here is a
 * control signal — the database and the chain are.
 */

export interface MatcherMetrics {
  ticks: number;
  tickErrors: number;
  /** Ticks skipped because the oracle had no usable price. */
  oracleSkips: number;
  matches: number;
  /** Matches dropped for being outside the execution band. */
  bandDrops: number;
  /** Backstop matches dropped by Insurance's own unwind band and caps. */
  backstopDrops: number;
  fillsSubmitted: number;
  fillsSettled: number;
  fillsRejected: number;
  fillsUnaccounted: number;
  ordersRetired: number;
  matcherBugs: number;
  batches: number;
  batchReverts: number;
  gasResizes: number;
  gasUsedTotal: bigint;
  /** Largest batch that settled without an `InsufficientBatchGas` revert. */
  maxSettledBatchFills: number;
  lastBatchFills: number;
  lastBatchGasUsed: bigint;
  lastGasPerFill: bigint;
  lastTickAt: number | null;
}

export function newMetrics(): MatcherMetrics {
  return {
    ticks: 0,
    tickErrors: 0,
    oracleSkips: 0,
    matches: 0,
    bandDrops: 0,
    backstopDrops: 0,
    fillsSubmitted: 0,
    fillsSettled: 0,
    fillsRejected: 0,
    fillsUnaccounted: 0,
    ordersRetired: 0,
    matcherBugs: 0,
    batches: 0,
    batchReverts: 0,
    gasResizes: 0,
    gasUsedTotal: 0n,
    maxSettledBatchFills: 0,
    lastBatchFills: 0,
    lastBatchGasUsed: 0n,
    lastGasPerFill: 0n,
    lastTickAt: null,
  };
}

/** Record one settled batch's gas, including the per-fill figure the gas pass tracks. */
export function recordBatchGas(m: MatcherMetrics, fills: number, gasUsed: bigint): void {
  m.batches += 1;
  m.gasUsedTotal += gasUsed;
  m.lastBatchFills = fills;
  m.lastBatchGasUsed = gasUsed;
  m.lastGasPerFill = fills > 0 ? gasUsed / BigInt(fills) : 0n;
  if (fills > m.maxSettledBatchFills) m.maxSettledBatchFills = fills;
}

/** JSON-safe snapshot (bigints become decimal strings). */
export function snapshot(m: MatcherMetrics): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) out[k] = typeof v === "bigint" ? v.toString() : v;
  return out;
}
