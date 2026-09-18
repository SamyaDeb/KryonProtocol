/**
 * Off-chain aggregation: one publisher's price for one feed, from its venues.
 *
 * Median of the live sources, with outliers dropped against a first-pass
 * median and the median recomputed over what is left. Never publishes from a
 * single source: fewer than `minSources` survivors means no price.
 *
 * Confidence is the largest distance of a surviving source from the median.
 * It is carried on-chain, and `OracleAdapter.getPrice` reverts once confidence
 * exceeds the feed's `maxConfidenceBps`, so a wide spread is not merely noted:
 * the guards refuse to publish it (see guards.ts).
 */

import type { SourceQuote } from "./sources";

export const BPS = 10_000n;

/** Median; the mean of the middle two for an even count, rounded toward zero. */
export function median(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new Error("median of nothing");
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2n;
}

export function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/** |a - ref| in basis points of `ref`, rounded down. */
export function deviationBps(a: bigint, ref: bigint): bigint {
  if (ref <= 0n) throw new Error("deviation against a non-positive reference");
  return (absDiff(a, ref) * BPS) / ref;
}

export interface Aggregate {
  symbol: string;
  price: bigint;
  confidence: bigint;
  /** Sources that made it into the median. */
  used: string[];
  dropped: { source: string; price: bigint; deviationBps: bigint }[];
  /** Oldest quote used, wall-clock ms. */
  oldestTs: number;
}

export type AggregateFailure =
  | { kind: "insufficient-sources"; live: number; required: number }
  | { kind: "disagreement"; live: number; kept: number; required: number; spreadBps: bigint };

export type AggregateResult = { ok: true; value: Aggregate } | { ok: false; error: AggregateFailure };

export interface AggregateOptions {
  /** Hard floor. Never below 2: a single venue is never a price. */
  minSources: number;
  /** A source further than this from the first-pass median is dropped. */
  maxSourceDeviationBps: bigint;
}

export function aggregate(symbol: string, quotes: readonly SourceQuote[], o: AggregateOptions): AggregateResult {
  const required = Math.max(2, o.minSources);
  if (quotes.length < required) {
    return { ok: false, error: { kind: "insufficient-sources", live: quotes.length, required } };
  }
  const first = median(quotes.map((q) => q.price));
  const kept: SourceQuote[] = [];
  const dropped: Aggregate["dropped"] = [];
  for (const q of quotes) {
    const d = deviationBps(q.price, first);
    if (d > o.maxSourceDeviationBps) dropped.push({ source: q.source, price: q.price, deviationBps: d });
    else kept.push(q);
  }
  if (kept.length < required) {
    const prices = quotes.map((q) => q.price);
    const lo = prices.reduce((a, b) => (a < b ? a : b));
    const hi = prices.reduce((a, b) => (a > b ? a : b));
    return {
      ok: false,
      error: { kind: "disagreement", live: quotes.length, kept: kept.length, required, spreadBps: deviationBps(hi, lo) },
    };
  }
  const price = median(kept.map((q) => q.price));
  const confidence = kept.reduce((m, q) => {
    const d = absDiff(q.price, price);
    return d > m ? d : m;
  }, 0n);
  return {
    ok: true,
    value: {
      symbol,
      price,
      confidence,
      used: kept.map((q) => q.source).sort(),
      dropped,
      oldestTs: Math.min(...kept.map((q) => q.ts)),
    },
  };
}
