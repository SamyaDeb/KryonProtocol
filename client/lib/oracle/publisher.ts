/**
 * The oracle publisher: sources → aggregation → guards → publish.
 *
 * One tick:
 *   1. Read the adapter's state in one multicall: pause flag, publisher set,
 *      and for every listed feed its config, stored aggregate, reference
 *      reading and every publisher's latest observation.
 *   2. Idle if paused; alert and idle if this key is not a publisher.
 *   3. Fetch every active feed plus USDC from every venue, in parallel.
 *   4. Halt everything on a USDC de-peg.
 *   5. Per feed: aggregate, apply local guards, apply the deviation/heartbeat
 *      rule, and predict the contract's outcome (guards.ts).
 *   6. Send one `pushPrices` batch for every feed that is due. A pre-flight
 *      revert is isolated per feed with `eth_call`, so one broken feed backs
 *      off alone instead of blocking the batch.
 *   7. Read the receipt's events (PriceUpdated / PriceUpdateSkipped /
 *      PriceReanchored) and record the per-feed outcome.
 *
 * Stateless across restarts by design: the "last published" reference for the
 * deviation/heartbeat rule is this key's on-chain observation, not memory.
 */

import { decodeEventLog, hexToString, type Address, type Hex, type TransactionReceipt } from "viem";

import { oracleAdapterAbi } from "@/lib/chain/contracts";
import { encodePushPrices } from "@/lib/chain/oracle";
import type { TxJob } from "@/lib/chain/tx-store";
import type { TxOutcome, TxRequest } from "@/lib/chain/tx-sender";
import { errorMessage, type KeeperActions, type Logger, type Metrics } from "@/lib/keepers/runtime";
import { decodeError } from "@/lib/keepers/reverts";

import { aggregate, type AggregateOptions, type AggregateResult } from "./aggregate";
import {
  ONCHAIN_SKIP_REASONS,
  TRANSIENT_HOLDS,
  decide,
  depegGuard,
  type Decision,
  type FeedState,
  type HoldReason,
  type PolicyOptions,
  type SkipReason,
} from "./guards";
import { SourceHealth, collectQuotes, type PriceSource } from "./sources";

// ─── dependencies ───────────────────────────────────────────────────────────

export interface OracleState {
  paused: boolean;
  publishers: Address[];
  feeds: FeedState[];
  /** Latest block timestamp: the only clock the contract's rules use. */
  chainNow: number;
}

export interface OracleChain {
  readState(): Promise<OracleState>;
  /** On-chain USDC/USD (Chainlink) in 1e18, or null when absent or stale. */
  readUsdcReference(chainNow: number): Promise<bigint | null>;
  /** eth_call a pushPrices payload from this key; returns the revert data or null on success. */
  simulate(data: Hex): Promise<{ ok: true } | { ok: false; error: unknown }>;
}

export interface Pusher {
  readonly address: Address;
  submit(req: TxRequest): Promise<TxJob>;
  wait(job: TxJob): Promise<TxOutcome>;
}

export interface PublisherOptions {
  chain: OracleChain;
  sender: Pusher;
  oracle: Address;
  sources: readonly PriceSource[];
  log: Logger;
  metrics: Metrics;
  actions: KeeperActions;
  aggregate: AggregateOptions;
  policy: PolicyOptions;
  /** Quotes older than this (wall clock) are ignored. */
  maxQuoteAgeMs: number;
  usdcDepegHaltBps: bigint;
  /** Halt when no USDC reading is available at all. */
  depegFailClosed: boolean;
  /** Seconds subtracted from the batch publishTime. */
  backdateSecs: number;
  /** Alert once a feed's stored aggregate is older than this. */
  alertAfterSecs: number;
  now?: () => number;
}

// ─── revert classes ─────────────────────────────────────────────────────────

export type RevertClass =
  | "stale"
  | "not-a-publisher"
  | "paused"
  | "unknown-feed"
  | "inactive-feed"
  | "invalid-price"
  | "unknown";

export function classifyRevert(errorName: string | null): RevertClass {
  switch (errorName) {
    case "StaleOracle":
      return "stale";
    case "AccessControlUnauthorizedAccount":
    case "NotPublisher":
      return "not-a-publisher";
    case "EnforcedPause":
    case "ExecutionPaused":
      return "paused";
    case "UnknownFeed":
      return "unknown-feed";
    case "InvalidConfig":
      return "inactive-feed";
    case "InvalidPrice":
    case "MathOverflow":
      return "invalid-price";
    default:
      return "unknown";
  }
}

/** `bytes32("BTC")` → "BTC". */
export function symbolOf(id: Hex): string {
  return hexToString(id, { size: 32 }).replace(/\0+$/, "");
}

// ─── receipt ────────────────────────────────────────────────────────────────

export type FeedOutcome =
  | { kind: "updated"; price: bigint; sourceCount: number; reanchored: boolean }
  | { kind: "skipped"; reason: SkipReason; candidate: bigint }
  | { kind: "observed" };

/** Per-feed result of a mined pushPrices, from the adapter's own events. */
export function outcomesFromReceipt(receipt: TransactionReceipt, oracle: Address): Map<Hex, FeedOutcome> {
  const out = new Map<Hex, FeedOutcome>();
  const reanchored = new Set<Hex>();
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== oracle.toLowerCase()) continue;
    let ev: { eventName: string; args: Record<string, unknown> };
    try {
      ev = decodeEventLog({ abi: oracleAdapterAbi, data: l.data, topics: l.topics }) as typeof ev;
    } catch {
      continue;
    }
    const id = ev.args.id as Hex;
    if (ev.eventName === "ObservationPushed" && !out.has(id)) out.set(id, { kind: "observed" });
    if (ev.eventName === "PriceUpdated") {
      out.set(id, {
        kind: "updated",
        price: ev.args.price as bigint,
        sourceCount: Number(ev.args.sourceCount),
        reanchored: false,
      });
    }
    if (ev.eventName === "PriceUpdateSkipped") {
      out.set(id, {
        kind: "skipped",
        reason: ONCHAIN_SKIP_REASONS[Number(ev.args.reason)] ?? "quorum",
        candidate: ev.args.candidate as bigint,
      });
    }
    if (ev.eventName === "PriceReanchored") reanchored.add(id);
  }
  for (const id of reanchored) {
    const o = out.get(id);
    if (o?.kind === "updated") o.reanchored = true;
  }
  return out;
}

// ─── the publisher ──────────────────────────────────────────────────────────

interface Backoff {
  until: number;
  failures: number;
  reason: string;
}

export interface TickResult {
  status: "paused" | "not-a-publisher" | "depeg-halt" | "nothing-due" | "published" | "reverted" | "send-failed";
  decisions: Map<string, Decision>;
  outcomes?: Map<string, FeedOutcome>;
  revert?: RevertClass;
}

const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;

export class OraclePublisher {
  readonly health = new SourceHealth();
  private readonly backoff = new Map<string, Backoff>();
  private readonly lastAlert = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly o: PublisherOptions) {
    this.now = o.now ?? Date.now;
  }

  async tick(): Promise<TickResult> {
    const { log, metrics } = this.o;
    const decisions = new Map<string, Decision>();
    const state = await this.o.chain.readState();
    const self = this.o.sender.address;

    metrics.gauge("oracle_paused", state.paused ? 1 : 0);
    if (state.paused) {
      log.info("oracle adapter paused; idling");
      return { status: "paused", decisions };
    }
    if (!state.publishers.some((p) => p.toLowerCase() === self.toLowerCase())) {
      metrics.inc("oracle_not_publisher_total");
      this.alert("not-a-publisher", "this key does not hold PUBLISHER_ROLE on the adapter", { key: self });
      return { status: "not-a-publisher", decisions };
    }

    const active = state.feeds.filter((f) => f.cfg.listed && f.cfg.active);
    const nowMs = this.now();
    const quotes = await collectQuotes(
      this.o.sources,
      [...active.map((f) => f.symbol), "USDC"],
      this.health,
      { now: nowMs, maxQuoteAgeMs: this.o.maxQuoteAgeMs }
    );

    // ── de-peg: every price is quoted in USDC ────────────────────────────
    const usdcReadings = (quotes.get("USDC") ?? []).map((q) => q.price);
    const usdcRef = await this.o.chain.readUsdcReference(state.chainNow).catch(() => null);
    if (usdcRef !== null) usdcReadings.push(usdcRef);
    const peg = depegGuard(usdcReadings, this.o.usdcDepegHaltBps, this.o.depegFailClosed);
    metrics.gauge("oracle_usdc_readings", peg.readings);
    if (peg.halt) {
      metrics.inc("oracle_depeg_halt_total");
      this.alert("depeg", "USDC peg guard tripped; publishing halted for every feed", {
        reason: peg.reason,
        ...(peg.reason === "depeg" ? { usdc: peg.price, deviationBps: peg.deviationBps } : {}),
      });
      this.freshness(state);
      return { status: "depeg-halt", decisions };
    }
    metrics.gauge("oracle_usdc_deviation_bps", Number(peg.deviationBps));

    // ── per feed ─────────────────────────────────────────────────────────
    const publishTime = Math.min(state.chainNow, Math.floor(nowMs / 1000)) - this.o.backdateSecs;
    const toPublish: { feed: FeedState; price: bigint; confidence: bigint; decision: Decision }[] = [];
    for (const feed of state.feeds) {
      const live = quotes.get(feed.symbol) ?? [];
      metrics.gauge(`oracle_sources_live.${feed.symbol}`, live.length);
      const bo = this.backoff.get(feed.symbol);
      if (bo && bo.until > nowMs) {
        decisions.set(feed.symbol, { action: "hold", reason: "sources", detail: { backoff: bo.reason } });
        continue;
      }
      const agg: AggregateResult = aggregate(feed.symbol, live, this.o.aggregate);
      const d = decide(
        feed,
        agg as Parameters<typeof decide>[1],
        { self, publishers: state.publishers, publishTime, chainNow: state.chainNow },
        this.o.policy
      );
      decisions.set(feed.symbol, d);
      if (d.action === "publish") toPublish.push({ feed, price: d.price, confidence: d.confidence, decision: d });
      if (d.action === "hold") this.onHold(feed.symbol, d.reason, d.detail);
      if (agg.ok && agg.value.dropped.length > 0) {
        metrics.inc(`oracle_source_dropped_total.${feed.symbol}`, agg.value.dropped.length);
        log.warn("source dropped as outlier", { feed: feed.symbol, dropped: agg.value.dropped });
      }
    }
    this.freshness(state);

    if (toPublish.length === 0) return { status: "nothing-due", decisions };

    // ── send ─────────────────────────────────────────────────────────────
    const updates = toPublish.map((t) => ({ symbol: t.feed.symbol, price: t.price, confidence: t.confidence }));
    const data = encodePushPrices(updates, publishTime);
    const actionId = await this.o.actions.record({
      kind: "oracle.push",
      payload: { publisher: self, publishTime, updates, why: toPublish.map((t) => (t.decision as { why?: string }).why) },
    });

    let job: TxJob;
    try {
      job = await this.o.sender.submit({ to: this.o.oracle, data, label: `oracle.push ${updates.length}` });
    } catch (err) {
      const { errorName, errorArgs } = decodeError(err);
      const cls = classifyRevert(errorName);
      metrics.inc(`oracle_push_reverted_total.${cls}`);
      await this.o.actions.update(actionId, {
        status: "FAILED",
        payload: { publisher: self, publishTime, updates, preflight: { errorName, errorArgs, cls, error: errorMessage(err) } },
      });
      await this.onRevert(cls, errorName, errorArgs, toPublish, publishTime);
      return { status: "send-failed", decisions, revert: cls };
    }
    await this.o.actions.update(actionId, { status: "SUBMITTED", txJobId: job.id });
    metrics.inc("oracle_push_total");

    let outcome: TxOutcome;
    try {
      outcome = await this.o.sender.wait(job);
    } catch (err) {
      // Left open for the reconciler; the next tick signs a fresh push at the next nonce.
      log.warn("push not confirmed in time", { job: job.id, error: errorMessage(err) });
      return { status: "send-failed", decisions };
    }

    if (outcome.receipt.status !== "success") {
      metrics.inc("oracle_push_reverted_total.onchain");
      await this.o.actions.update(actionId, { status: "FAILED", blockNumber: outcome.receipt.blockNumber });
      log.warn("push reverted on-chain", { job: job.id, block: outcome.receipt.blockNumber });
      return { status: "reverted", decisions };
    }

    const byId = outcomesFromReceipt(outcome.receipt, this.o.oracle);
    const outcomes = new Map<string, FeedOutcome>();
    for (const t of toPublish) {
      const r = byId.get(t.feed.id) ?? { kind: "observed" as const };
      outcomes.set(t.feed.symbol, r);
      this.backoff.delete(t.feed.symbol);
      if (r.kind === "updated") {
        metrics.inc(`oracle_updated_total.${t.feed.symbol}`);
        metrics.gauge(`oracle_last_price.${t.feed.symbol}`, toFloat(r.price));
        if (r.reanchored) {
          metrics.inc(`oracle_reanchor_total.${t.feed.symbol}`);
          log.warn("feed re-anchored after an outage", {
            feed: t.feed.symbol,
            previous: t.feed.snapshot.price,
            price: r.price,
            staleForSecs: state.chainNow - t.feed.snapshot.writeTime,
          });
        }
      } else if (r.kind === "skipped") {
        metrics.inc(`oracle_skipped_total.${r.reason}`);
        const log2 = r.reason === "quorum" ? log.info : log.warn;
        log2.call(log, "aggregate skipped on-chain", { feed: t.feed.symbol, reason: r.reason, candidate: r.candidate });
      }
    }
    await this.o.actions.update(actionId, {
      status: "CONFIRMED",
      blockNumber: outcome.receipt.blockNumber,
      payload: {
        publisher: self,
        publishTime,
        updates,
        outcomes: Object.fromEntries([...outcomes].map(([s, r]) => [s, r])),
      },
    });
    return { status: "published", decisions, outcomes };
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private onHold(symbol: string, reason: HoldReason, detail?: Record<string, unknown>) {
    this.o.metrics.inc(`oracle_hold_total.${reason}`);
    const level = TRANSIENT_HOLDS.has(reason) ? "info" : "warn";
    this.o.log[level]("feed held", { feed: symbol, reason, ...detail });
    if (reason === "divergence") {
      this.alert(`divergence:${symbol}`, "price diverges from the Chainlink reference; feed halted", {
        feed: symbol,
        ...detail,
      });
    }
  }

  /**
   * Isolate a pre-flight revert. Global classes (not a publisher, paused,
   * stale publishTime) need no isolation. Anything else is re-simulated one
   * feed at a time, and only the feeds that still fail back off.
   */
  private async onRevert(
    cls: RevertClass,
    errorName: string | null,
    errorArgs: readonly unknown[],
    batch: { feed: FeedState; price: bigint; confidence: bigint }[],
    publishTime: number
  ) {
    const { log } = this.o;
    if (cls === "not-a-publisher") {
      this.alert("not-a-publisher", "pushPrices refused: key lacks PUBLISHER_ROLE", { errorName });
      return;
    }
    if (cls === "paused" || cls === "stale") {
      log.warn("push refused in pre-flight", { cls, errorName });
      return;
    }
    if (cls === "unknown-feed" && typeof errorArgs[0] === "string") {
      const hit = batch.find((b) => b.feed.id.toLowerCase() === String(errorArgs[0]).toLowerCase());
      if (hit) {
        this.backOff(hit.feed.symbol, `UnknownFeed`);
        return;
      }
    }
    for (const b of batch) {
      const one = encodePushPrices([{ symbol: b.feed.symbol, price: b.price, confidence: b.confidence }], publishTime);
      const r = await this.o.chain.simulate(one);
      if (!r.ok) {
        const e = decodeError(r.error);
        this.backOff(b.feed.symbol, e.errorName ?? "revert");
      }
    }
  }

  private backOff(symbol: string, reason: string) {
    const prev = this.backoff.get(symbol);
    const failures = (prev?.failures ?? 0) + 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
    this.backoff.set(symbol, { until: this.now() + delay, failures, reason });
    this.o.metrics.inc(`oracle_backoff_total.${symbol}`);
    this.o.log.warn("feed backing off", { feed: symbol, reason, delayMs: delay, failures });
  }

  /** Freshness per feed for the monitor, and an alert for any feed past the threshold. */
  private freshness(state: OracleState) {
    for (const f of state.feeds) {
      if (!f.cfg.active) continue;
      const age = f.snapshot.writeTime === 0 ? Number.POSITIVE_INFINITY : state.chainNow - f.snapshot.writeTime;
      this.o.metrics.gauge(`oracle_feed_age_s.${f.symbol}`, Number.isFinite(age) ? age : -1);
      if (f.snapshot.price > 0n) this.o.metrics.gauge(`oracle_feed_price.${f.symbol}`, toFloat(f.snapshot.price));
      if (age > this.o.alertAfterSecs) {
        this.alert(`stale:${f.symbol}`, "feed stale on-chain: trading, liquidation and withdrawals are blocked", {
          feed: f.symbol,
          ageSecs: Number.isFinite(age) ? age : null,
          maxAge: f.cfg.maxAge,
        });
      }
    }
  }

  /** An alert is an error log with `alert: true`, at most once per key per `alertAfterSecs`. */
  private alert(key: string, msg: string, fields: Record<string, unknown>) {
    const now = this.now();
    const last = this.lastAlert.get(key) ?? 0;
    this.o.metrics.inc(`oracle_alert_total.${key.split(":")[0]}`);
    if (now - last < this.o.alertAfterSecs * 1000) return;
    this.lastAlert.set(key, now);
    this.o.log.error(msg, { alert: true, alertKey: key, ...fields });
  }
}

function toFloat(v: bigint): number {
  return Number(v / 10n ** 10n) / 1e8;
}

export type { FeedState, SkipReason };
