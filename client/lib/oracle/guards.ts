/**
 * Guards: decide, per feed and before any gas is spent, whether to publish.
 *
 * Two layers:
 *
 *  1. Local guards, which are about *our* price: enough live sources, sources
 *     that agree, confidence the contract will accept on read, no divergence
 *     from the on-chain Chainlink reference, a valid publishTime, and the
 *     global USDC de-peg halt.
 *
 *  2. A faithful mirror of `OracleAdapter._aggregate`, which is about what the
 *     contract will do with our observation *combined with the other
 *     publishers'*. The contract never reverts on a guard; it stores the
 *     observation and emits `PriceUpdateSkipped`. So the mirror predicts the
 *     outcome rather than a revert.
 *
 * What we do with a predicted skip depends on why:
 *
 *   - **Quorum not met, or spread too wide → send anyway.** Both are
 *     disagreements between *our* fresh observation and the other publishers'
 *     older ones, and our stored observation is exactly what resolves them:
 *     the next publisher's push then finds a quorum at the new level. Two
 *     publishers that each held for these would never converge. For spread
 *     that is not hypothetical: any move wider than `maxSpreadBps` (0.5%)
 *     between two publishers' pushes would make both hold, both observations
 *     would expire, and the feed would go stale on an ordinary move.
 *   - **Jump, not-monotonic, divergence → hold.** The contract would reject
 *     the aggregate whatever the other publishers do; sending buys nothing but
 *     gas. Jump resolves itself: once the stored price is older than `maxAge`
 *     the jump guard stops applying, the mirror predicts a re-anchor, and we
 *     send.
 */

import type { Address, Hex } from "viem";

import { BPS, absDiff, deviationBps, median, type Aggregate } from "./aggregate";

// ─── on-chain state, as read each tick ──────────────────────────────────────

export interface FeedConfig {
  listed: boolean;
  active: boolean;
  minPublishers: number;
  maxSpreadBps: number;
  maxJumpBps: number;
  maxConfidenceBps: number;
  maxAge: number;
}

export interface Snapshot {
  price: bigint;
  confidence: bigint;
  publishTime: number;
  writeTime: number;
  sourceCount: number;
}

export interface Observation {
  price: bigint;
  confidence: bigint;
  publishTime: number;
}

export interface ReferenceState {
  enabled: boolean;
  required: boolean;
  maxDivergenceBps: number;
  /** `OracleAdapter.referencePrice(id)`: the contract's own reading and staleness rules. */
  ok: boolean;
  price: bigint;
}

export interface FeedState {
  id: Hex;
  symbol: string;
  cfg: FeedConfig;
  snapshot: Snapshot;
  /** Every current publisher's latest observation, keyed by lowercase address. */
  observations: Map<string, Observation>;
  reference: ReferenceState;
}

// ─── contract mirror ────────────────────────────────────────────────────────

/** `KryonMath.applyBps`: truncating, as Solidity signed division is. */
export function applyBps(amount: bigint, bps: number | bigint): bigint {
  return (amount * BigInt(bps)) / BPS;
}

export type SkipReason = "quorum" | "spread" | "jump" | "divergence" | "reference-unavailable" | "not-monotonic";

/** `OracleAdapter.SkipReason` enum order. */
export const ONCHAIN_SKIP_REASONS: readonly SkipReason[] = [
  "quorum",
  "spread",
  "jump",
  "divergence",
  "reference-unavailable",
  "not-monotonic",
];

export type Prediction =
  | { outcome: "update"; median: bigint; count: number; reanchor: boolean }
  | { outcome: "skip"; reason: SkipReason; median: bigint | null; count: number };

/**
 * What `_aggregate` will do if `self` pushes `obs` and the block lands at
 * `blockTime`. Mirrors the contract line for line; keep them in step.
 */
export function predictAggregate(
  feed: FeedState,
  publishers: readonly Address[],
  self: Address,
  obs: Observation,
  blockTime: number
): Prediction {
  const { cfg } = feed;
  const prices: bigint[] = [];
  let oldest = Number.MAX_SAFE_INTEGER;
  for (const p of publishers) {
    const o = p.toLowerCase() === self.toLowerCase() ? obs : feed.observations.get(p.toLowerCase());
    if (!o || o.publishTime === 0 || blockTime - o.publishTime > cfg.maxAge) continue;
    prices.push(o.price);
    if (o.publishTime < oldest) oldest = o.publishTime;
  }
  const count = prices.length;
  if (count < cfg.minPublishers) return { outcome: "skip", reason: "quorum", median: null, count };

  const m = median(prices);
  const maxSpread = applyBps(m, cfg.maxSpreadBps);
  if (prices.some((p) => absDiff(p, m) > maxSpread)) return { outcome: "skip", reason: "spread", median: m, count };

  const prev = feed.snapshot;
  if (oldest < prev.publishTime) return { outcome: "skip", reason: "not-monotonic", median: m, count };

  const prevStale = blockTime - prev.writeTime > cfg.maxAge;
  if (cfg.maxJumpBps !== 0 && prev.price > 0n && !prevStale) {
    if (absDiff(m, prev.price) > applyBps(prev.price, cfg.maxJumpBps)) {
      return { outcome: "skip", reason: "jump", median: m, count };
    }
  }

  const ref = feed.reference;
  if (ref.enabled) {
    if (!ref.ok) {
      if (ref.required) return { outcome: "skip", reason: "reference-unavailable", median: m, count };
    } else if (absDiff(m, ref.price) > applyBps(ref.price, ref.maxDivergenceBps)) {
      return { outcome: "skip", reason: "divergence", median: m, count };
    }
  }

  return { outcome: "update", median: m, count, reanchor: prevStale && prev.price > 0n };
}

// ─── USDC de-peg ────────────────────────────────────────────────────────────

export type DepegVerdict =
  | { halt: false; price: bigint; readings: number; deviationBps: bigint }
  | { halt: true; reason: "depeg"; price: bigint; readings: number; deviationBps: bigint }
  | { halt: true; reason: "no-reading"; readings: 0 };

export const ONE = 10n ** 18n;

/**
 * Halt everything if USDC is off its peg. Every price we publish is quoted in
 * USDC, so a broken USDC means every price is in a broken unit.
 *
 * Uses the median of the available readings (venue quotes plus the on-chain
 * Chainlink USDC/USD where one exists), so a single glitching venue cannot
 * halt the protocol on its own. With no reading at all, `failClosed` decides.
 */
export function depegGuard(readings: readonly bigint[], haltBps: bigint, failClosed: boolean): DepegVerdict {
  if (readings.length === 0) {
    return failClosed
      ? { halt: true, reason: "no-reading", readings: 0 }
      : { halt: false, price: ONE, readings: 0, deviationBps: 0n };
  }
  const price = median(readings);
  const d = deviationBps(price, ONE);
  if (d > haltBps) return { halt: true, reason: "depeg", price, readings: readings.length, deviationBps: d };
  return { halt: false, price, readings: readings.length, deviationBps: d };
}

// ─── publish policy ─────────────────────────────────────────────────────────

export interface PolicyOptions {
  /** Publish when the price has moved at least this far from our last observation. */
  deviationBps: bigint;
  /** ...or when our last observation is this old (chain seconds). */
  heartbeatSecs: number;
  /**
   * Seconds of `maxAge` reserved for the transaction to land. A publishTime
   * that is already this close to expiry is not worth sending.
   */
  inclusionMarginSecs: number;
  /** Stricter-than-chain divergence bound; 0 uses the feed's on-chain bound. */
  maxRefDivergenceBps: number;
}

export type Decision =
  | { action: "publish"; price: bigint; confidence: bigint; prediction: Prediction; why: "new" | "deviation" | "heartbeat" }
  | { action: "hold"; reason: HoldReason; detail?: Record<string, unknown> }
  | { action: "idle"; reason: "inactive" | "not-due" };

export type HoldReason =
  | "sources"
  | "disagreement"
  | "confidence"
  | "divergence"
  | "reference-unavailable"
  | "publish-time"
  | "jump"
  | "not-monotonic";

/** Predicted on-chain skips we still send: our observation is what clears them. */
export const SEND_THROUGH: ReadonlySet<SkipReason> = new Set(["quorum", "spread"]);

/** Holds that describe the market or the network, not a fault of ours. They clear on their own. */
export const TRANSIENT_HOLDS: ReadonlySet<HoldReason> = new Set(["publish-time", "jump", "not-monotonic"]);

export function decide(
  feed: FeedState,
  agg: { ok: true; value: Aggregate } | { ok: false; error: { kind: string } & Record<string, unknown> },
  ctx: { self: Address; publishers: readonly Address[]; publishTime: number; chainNow: number },
  p: PolicyOptions
): Decision {
  if (!feed.cfg.listed || !feed.cfg.active) return { action: "idle", reason: "inactive" };
  if (!agg.ok) {
    return {
      action: "hold",
      reason: agg.error.kind === "disagreement" ? "disagreement" : "sources",
      detail: agg.error,
    };
  }
  const { price, confidence } = agg.value;

  // getPrice reverts OracleConfidenceTooWide above this, which halts the
  // market as surely as a stale price. Don't put it on-chain.
  const maxConfidence = applyBps(price, feed.cfg.maxConfidenceBps);
  if (confidence > maxConfidence) {
    return { action: "hold", reason: "confidence", detail: { confidence, maxConfidence } };
  }

  const ref = feed.reference;
  if (ref.enabled && ref.ok) {
    const bound =
      p.maxRefDivergenceBps > 0 ? Math.min(p.maxRefDivergenceBps, ref.maxDivergenceBps) : ref.maxDivergenceBps;
    const d = deviationBps(price, ref.price);
    if (d > BigInt(bound)) {
      return { action: "hold", reason: "divergence", detail: { price, reference: ref.price, deviationBps: d, bound } };
    }
  } else if (ref.enabled && ref.required) {
    return { action: "hold", reason: "reference-unavailable" };
  }

  const own = feed.observations.get(ctx.self.toLowerCase());
  let why: "new" | "deviation" | "heartbeat";
  if (!own || own.publishTime === 0) why = "new";
  else if (deviationBps(price, own.price) >= p.deviationBps) why = "deviation";
  else if (ctx.chainNow - own.publishTime >= p.heartbeatSecs) why = "heartbeat";
  else return { action: "idle", reason: "not-due" };

  // The contract's timing rules, all against block.timestamp.
  if (own && ctx.publishTime <= own.publishTime) {
    return { action: "hold", reason: "publish-time", detail: { publishTime: ctx.publishTime, last: own.publishTime } };
  }
  if (ctx.publishTime > ctx.chainNow || ctx.chainNow - ctx.publishTime > feed.cfg.maxAge - p.inclusionMarginSecs) {
    return { action: "hold", reason: "publish-time", detail: { publishTime: ctx.publishTime, chainNow: ctx.chainNow } };
  }

  // Predict at the next block: one second on is the earliest it can land.
  const prediction = predictAggregate(
    feed,
    ctx.publishers,
    ctx.self,
    { price, confidence, publishTime: ctx.publishTime },
    ctx.chainNow + 1
  );
  if (prediction.outcome === "skip" && !SEND_THROUGH.has(prediction.reason)) {
    // SEND_THROUGH removed quorum and spread above; what is left is a HoldReason.
    const reason = prediction.reason as Exclude<SkipReason, "quorum" | "spread">;
    return { action: "hold", reason, detail: { median: prediction.median, count: prediction.count } };
  }
  return { action: "publish", price, confidence, prediction, why };
}
