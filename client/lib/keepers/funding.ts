/**
 * Funding keeper: one `Engine.updateFunding(marketId)` per market, a little
 * under every hour, from the KEEPER_ROLE key.
 *
 * The contract facts that shape it (Engine.updateFunding, FundingLib):
 *
 *   - One update charges `min(elapsed, 3600)` seconds. Elapsed past an hour is
 *     lost, never back-charged, so the cadence must stay *under* an hour: an
 *     hourly timer that fires at 3600s + jitter loses the jitter every time.
 *     Default due-age is 3300s (55 min).
 *   - `now <= lastUpdate` leaves the indexes unchanged **but still consumes the
 *     mark TWAP window**. A same-second or duplicate call is not a no-op: it
 *     degrades the next period's premium. So the keeper decides due-ness from
 *     `fundingState.lastUpdate` against the latest block's timestamp (never the
 *     wall clock), skips `dt <= 0`, and never sends two updates for one market
 *     in one tick.
 *   - A missed hour is logged as a shortfall and not chased: a second update
 *     would charge a fresh hour against a fresh TWAP, which is wrong twice.
 *   - The mark reads the oracle. A stale index makes the call revert
 *     `StaleOracle`; that market is reported as blocked on the oracle and
 *     retried next tick, never hot-looped.
 *
 * Every decision is re-made from chain state each tick, so a crash loses
 * nothing and a restart cannot double-send: the reconciler (or startup
 * recovery) finishes what is in flight, and the next tick reads the result.
 */

import {
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";

import { engineAbi, riskParamsAbi } from "@/lib/chain/contracts";
import type { TxJob } from "@/lib/chain/tx-store";
import type { TxOutcome, TxRequest } from "@/lib/chain/tx-sender";

import { decodeError } from "./reverts";
import { errorMessage, type KeeperActions, type Logger, type Metrics } from "./runtime";

export const MAX_FUNDING_ELAPSED_SECS = 3600;

export interface MarketFunding {
  marketId: number;
  active: boolean;
  lastUpdate: number;
  longIndex: bigint;
  shortIndex: bigint;
  ratePerHour: bigint;
}

export interface FundingChain {
  /** Latest block timestamp, pause flag, role check and every listed market's funding state. */
  read(): Promise<{ chainNow: number; paused: boolean; hasRole: boolean; markets: MarketFunding[] }>;
}

export interface FundingSender {
  readonly address: Address;
  submit(req: TxRequest): Promise<TxJob>;
  wait(job: TxJob): Promise<TxOutcome>;
}

export interface FundingOptions {
  chain: FundingChain;
  sender: FundingSender;
  engine: Address;
  log: Logger;
  metrics: Metrics;
  actions: KeeperActions;
  /** Update once `chainNow - lastUpdate` reaches this. Must stay under 3600. */
  dueAfterSecs: number;
  /** Updates sent per tick at most; the most overdue go first. */
  maxPerTick: number;
}

export type FundingPlan =
  | { marketId: number; action: "update"; elapsed: number; shortfallSecs: number; first: boolean }
  | { marketId: number; action: "skip"; reason: "inactive" | "not-due" | "same-timestamp" };

/** Pure: what to do for each market at `chainNow`. */
export function planFunding(markets: readonly MarketFunding[], chainNow: number, dueAfterSecs: number): FundingPlan[] {
  return markets.map((m): FundingPlan => {
    if (!m.active) return { marketId: m.marketId, action: "skip", reason: "inactive" };
    // lastUpdate == 0: the first call starts the clock; nothing accrues before it.
    if (m.lastUpdate === 0) return { marketId: m.marketId, action: "update", elapsed: 0, shortfallSecs: 0, first: true };
    const elapsed = chainNow - m.lastUpdate;
    if (elapsed <= 0) return { marketId: m.marketId, action: "skip", reason: "same-timestamp" };
    if (elapsed < dueAfterSecs) return { marketId: m.marketId, action: "skip", reason: "not-due" };
    return {
      marketId: m.marketId,
      action: "update",
      elapsed,
      shortfallSecs: Math.max(0, elapsed - MAX_FUNDING_ELAPSED_SECS),
      first: false,
    };
  });
}

/** Most overdue first; first-ever updates (which start the clock) ahead of everything. */
export function orderDue(plans: readonly FundingPlan[]): Extract<FundingPlan, { action: "update" }>[] {
  return plans
    .filter((p): p is Extract<FundingPlan, { action: "update" }> => p.action === "update")
    .sort((a, b) => (a.first === b.first ? b.elapsed - a.elapsed : a.first ? -1 : 1));
}

export interface FundingUpdatedEvent {
  marketId: number;
  longIndex: bigint;
  shortIndex: bigint;
  ratePerHour: bigint;
  premium: bigint;
  mark: bigint;
  index: bigint;
}

export function fundingUpdatedFrom(receipt: TransactionReceipt, engine: Address, marketId: number): FundingUpdatedEvent | null {
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== engine.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: engineAbi, data: l.data, topics: l.topics });
      if (ev.eventName !== "FundingUpdated") continue;
      const a = ev.args as unknown as Omit<FundingUpdatedEvent, "marketId"> & { marketId: number | bigint };
      if (Number(a.marketId) !== marketId) continue;
      return { ...a, marketId: Number(a.marketId) };
    } catch {
      continue;
    }
  }
  return null;
}

export type FundingRevertClass = "oracle" | "not-keeper" | "paused" | "config" | "unknown";

export function classifyFundingRevert(errorName: string | null): FundingRevertClass {
  switch (errorName) {
    case "StaleOracle":
    case "OracleConfidenceTooWide":
    case "InvalidPrice":
      return "oracle";
    case "AccessControlUnauthorizedAccount":
      return "not-keeper";
    case "EnforcedPause":
    case "ExecutionPaused":
      return "paused";
    case "InvalidConfig":
    case "UnknownMarket":
      return "config";
    default:
      return "unknown";
  }
}

export interface FundingTickResult {
  status: "paused" | "not-keeper" | "idle" | "ran";
  plans: FundingPlan[];
  results: Map<number, { outcome: "confirmed" | "reverted" | "preflight" | "unconfirmed"; detail?: unknown }>;
}

export class FundingKeeper {
  constructor(private readonly o: FundingOptions) {
    if (o.dueAfterSecs >= MAX_FUNDING_ELAPSED_SECS) {
      throw new Error(`dueAfterSecs ${o.dueAfterSecs} must be under ${MAX_FUNDING_ELAPSED_SECS}, or every update loses time`);
    }
  }

  async tick(): Promise<FundingTickResult> {
    const { log, metrics } = this.o;
    const results: FundingTickResult["results"] = new Map();
    const state = await this.o.chain.read();
    metrics.gauge("funding_paused", state.paused ? 1 : 0);
    if (state.paused) {
      log.info("engine paused; idling");
      return { status: "paused", plans: [], results };
    }
    if (!state.hasRole) {
      metrics.inc("funding_not_keeper_total");
      log.error("this key does not hold KEEPER_ROLE on the engine", { alert: true, key: this.o.sender.address });
      return { status: "not-keeper", plans: [], results };
    }

    const plans = planFunding(state.markets, state.chainNow, this.o.dueAfterSecs);
    for (const m of state.markets) {
      if (m.active && m.lastUpdate > 0) metrics.gauge(`funding_age_s.${m.marketId}`, state.chainNow - m.lastUpdate);
    }
    const due = orderDue(plans).slice(0, this.o.maxPerTick);
    if (due.length === 0) return { status: "idle", plans, results };

    for (const p of due) {
      if (p.shortfallSecs > 0) {
        metrics.inc(`funding_shortfall_secs_total.${p.marketId}`, p.shortfallSecs);
        log.warn("funding shortfall: more than an hour since the last update; the excess is not charged", {
          marketId: p.marketId,
          elapsedSecs: p.elapsed,
          lostSecs: p.shortfallSecs,
        });
      }
      results.set(p.marketId, await this.update(p, state.chainNow));
    }
    return { status: "ran", plans, results };
  }

  private async update(
    p: Extract<FundingPlan, { action: "update" }>,
    chainNow: number
  ): Promise<{ outcome: "confirmed" | "reverted" | "preflight" | "unconfirmed"; detail?: unknown }> {
    const { log, metrics } = this.o;
    const data: Hex = encodeFunctionData({ abi: engineAbi, functionName: "updateFunding", args: [p.marketId] });
    const actionId = await this.o.actions.record({
      kind: "funding.update",
      marketId: p.marketId,
      payload: { chainNow, elapsed: p.elapsed, shortfallSecs: p.shortfallSecs, first: p.first },
    });

    let job: TxJob;
    try {
      job = await this.o.sender.submit({ to: this.o.engine, data, label: `funding.update ${p.marketId}` });
    } catch (err) {
      const { errorName } = decodeError(err);
      const cls = classifyFundingRevert(errorName);
      metrics.inc(`funding_preflight_reverted_total.${cls}`);
      await this.o.actions.update(actionId, {
        status: "FAILED",
        payload: { chainNow, elapsed: p.elapsed, preflight: { errorName, cls, error: errorMessage(err) } },
      });
      const level = cls === "oracle" ? "warn" : "error";
      log[level](cls === "oracle" ? "funding blocked on a stale oracle; retrying next tick" : "funding update refused", {
        marketId: p.marketId,
        errorName,
        cls,
        ...(cls === "not-keeper" ? { alert: true } : {}),
      });
      return { outcome: "preflight", detail: { errorName, cls } };
    }
    await this.o.actions.update(actionId, { status: "SUBMITTED", txJobId: job.id });
    metrics.inc("funding_sent_total");

    let out: TxOutcome;
    try {
      out = await this.o.sender.wait(job);
    } catch (err) {
      log.warn("funding update not confirmed in time; left for the reconciler", { marketId: p.marketId, error: errorMessage(err) });
      return { outcome: "unconfirmed" };
    }
    if (out.receipt.status !== "success") {
      metrics.inc("funding_reverted_total");
      await this.o.actions.update(actionId, { status: "FAILED", blockNumber: out.receipt.blockNumber });
      log.warn("funding update reverted on-chain", { marketId: p.marketId, block: out.receipt.blockNumber });
      return { outcome: "reverted" };
    }

    // Confirmed only on the contract's own event for this market.
    const ev = fundingUpdatedFrom(out.receipt, this.o.engine, p.marketId);
    if (!ev) {
      await this.o.actions.update(actionId, { status: "FAILED", blockNumber: out.receipt.blockNumber, payload: { chainNow, note: "no FundingUpdated in receipt" } });
      log.error("updateFunding succeeded without a FundingUpdated event", { marketId: p.marketId });
      return { outcome: "reverted" };
    }
    await this.o.actions.update(actionId, {
      status: "CONFIRMED",
      blockNumber: out.receipt.blockNumber,
      payload: { chainNow, elapsed: p.elapsed, shortfallSecs: p.shortfallSecs, event: ev },
    });
    metrics.inc(`funding_updated_total.${p.marketId}`);
    metrics.gauge(`funding_rate_per_hour.${p.marketId}`, Number(ev.ratePerHour) / 1e18);
    log.info("funding updated", { marketId: p.marketId, ratePerHour: ev.ratePerHour, premium: ev.premium, elapsed: p.elapsed });
    return { outcome: "confirmed", detail: ev };
  }
}

// ─── chain, over viem ───────────────────────────────────────────────────────

const KEEPER_ROLE = keccak256(toHex("KEEPER_ROLE"));

export function viemFundingChain(o: {
  client: Pick<PublicClient, "multicall" | "getBlock">;
  engine: Address;
  riskParams: Address;
  self: Address;
}): FundingChain {
  return {
    async read() {
      const block = await o.client.getBlock({ blockTag: "latest" });
      const blockNumber = block.number;
      const [paused, hasRole, ids] = await o.client.multicall({
        allowFailure: false,
        blockNumber,
        contracts: [
          { address: o.engine, abi: engineAbi, functionName: "paused" },
          { address: o.engine, abi: engineAbi, functionName: "hasRole", args: [KEEPER_ROLE, o.self] },
          { address: o.riskParams, abi: riskParamsAbi, functionName: "marketIds" },
        ],
      });
      const marketIds = (ids as readonly (number | bigint)[]).map(Number);
      const reads = marketIds.length
        ? ((await o.client.multicall({
            allowFailure: false,
            blockNumber,
            contracts: marketIds.flatMap((id) => [
              { address: o.riskParams, abi: riskParamsAbi, functionName: "market", args: [id] },
              { address: o.engine, abi: engineAbi, functionName: "fundingState", args: [id] },
            ]) as never,
          })) as unknown[])
        : [];
      const markets: MarketFunding[] = marketIds.map((id, i) => {
        const m = reads[i * 2] as { active: boolean };
        const f = reads[i * 2 + 1] as { longIndex: bigint; shortIndex: bigint; ratePerHour: bigint; lastUpdate: bigint };
        return {
          marketId: id,
          active: m.active,
          lastUpdate: Number(f.lastUpdate),
          longIndex: f.longIndex,
          shortIndex: f.shortIndex,
          ratePerHour: f.ratePerHour,
        };
      });
      return { chainNow: Number(block.timestamp), paused: paused as boolean, hasRole: hasRole as boolean, markets };
    },
  };
}
