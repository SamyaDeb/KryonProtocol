/**
 * Fee-tier bot: keeps `FeeRouter.accountTier` in line with each account's
 * 30-day volume.
 *
 * The schedule is configuration, not code: `FEE_TIER_SCHEDULE` maps each tier
 * to the minimum 30-day volume (whole USD) that earns it, e.g. "1:1000000,2:10000000".
 * Tier rates themselves are governance's (`FeeRouter.defineTier`); the bot only
 * assigns accounts to tiers that already exist, and refuses a schedule naming
 * a tier that is not defined on chain.
 *
 * One tick:
 *   1. Idle, and say why, while the FeeRouter is paused, the stats aggregator is
 *      stale (so a lapsed volume never reads as zero and downgrades everyone),
 *      or the schedule names an undefined tier.
 *   2. Candidates: every account the aggregator says qualifies for a tier, plus
 *      every account the indexer says holds one. Current tiers are read from
 *      the chain (truth), not from the indexer.
 *   3. The diff, largest change first, at most `maxChangesPerTick`.
 *   4. Dry run (the default): log the proposals, send nothing. Enabled: one
 *      `setAccountTier` per change through TxSender, each a KeeperAction
 *      (`fee_tier.set`), confirmed on the contract's own FeeTierSet event.
 *      Nothing new is sent while one of this key's transactions is in flight.
 *
 * Every decision is re-derived from chain state each tick, so a restart
 * re-computes the same diff and never repeats a change that already landed.
 */

import { decodeEventLog, encodeFunctionData, keccak256, toHex, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";

import { feeRouterAbi } from "@/lib/chain/contracts";
import type { TxJob } from "@/lib/chain/tx-store";
import type { TxOutcome, TxRequest } from "@/lib/chain/tx-sender";
import type { Queryable } from "@/lib/queries/client";

import { decodeError } from "./reverts";
import { errorMessage, stillInFlight, type KeeperActions, type Logger, type Metrics } from "./runtime";

export const FEE_TIER_ROLE: Hex = keccak256(toHex("FEE_TIER_ROLE"));
/** FeeRouter.MAX_TIER. */
export const MAX_TIER = 16;
export const SET_ACTION = "fee_tier.set";
/** AccountAnalytics volumes are USD with 6 decimals. */
const USD6 = 1_000_000n;

// ─── schedule ───────────────────────────────────────────────────────────────

export interface TierStep {
  tier: number;
  /** Minimum 30-day volume for this tier, USD × 1e6 (AccountAnalytics units). */
  minVolume: bigint;
}

/** Parse "tier:minUsd,…". Tiers 1..16, thresholds strictly increasing with tier. */
export function parseSchedule(raw: string | undefined): TierStep[] {
  if (!raw || !raw.trim()) throw new Error("FEE_TIER_SCHEDULE is not set (e.g. 1:1000000,2:10000000)");
  const steps = raw.split(",").map((part) => {
    const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(part);
    if (!m) throw new Error(`FEE_TIER_SCHEDULE: "${part}" is not tier:minUsd`);
    const tier = Number(m[1]);
    if (tier < 1 || tier > MAX_TIER) throw new Error(`FEE_TIER_SCHEDULE: tier ${tier} is outside 1..${MAX_TIER}`);
    const minUsd = BigInt(m[2]);
    if (minUsd <= 0n) throw new Error(`FEE_TIER_SCHEDULE: tier ${tier} needs a positive threshold`);
    return { tier, minVolume: minUsd * USD6 };
  });
  steps.sort((a, b) => a.tier - b.tier);
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].tier === steps[i - 1].tier) throw new Error(`FEE_TIER_SCHEDULE: tier ${steps[i].tier} appears twice`);
    if (steps[i].minVolume <= steps[i - 1].minVolume) {
      throw new Error(`FEE_TIER_SCHEDULE: tier ${steps[i].tier} must need more volume than tier ${steps[i - 1].tier}`);
    }
  }
  return steps;
}

/** The highest tier whose threshold the volume meets; 0 (market schedule) below the first. */
export function targetTier(volume30d: bigint, schedule: readonly TierStep[]): number {
  let tier = 0;
  for (const s of schedule) if (volume30d >= s.minVolume) tier = s.tier;
  return tier;
}

export interface TierChange {
  account: Address;
  from: number;
  to: number;
  volume30d: bigint;
}

/**
 * Accounts whose on-chain tier differs from their target, largest move first
 * (ties: most volume first), capped at `max`. `onChain` is the truth; an
 * account missing from it is skipped rather than assumed to be tier 0.
 */
export function diffTiers(
  volumes: ReadonlyMap<Address, bigint>,
  onChain: ReadonlyMap<Address, number>,
  schedule: readonly TierStep[],
  max: number
): { changes: TierChange[]; deferred: number } {
  const all: TierChange[] = [];
  for (const [account, from] of onChain) {
    const volume30d = volumes.get(account) ?? 0n;
    const to = targetTier(volume30d, schedule);
    if (to !== from) all.push({ account, from, to, volume30d });
  }
  all.sort((a, b) => {
    const d = Math.abs(b.to - b.from) - Math.abs(a.to - a.from);
    if (d !== 0) return d;
    return a.volume30d === b.volume30d ? (a.account < b.account ? -1 : 1) : a.volume30d > b.volume30d ? -1 : 1;
  });
  return { changes: all.slice(0, max), deferred: Math.max(0, all.length - max) };
}

// ─── chain and data ─────────────────────────────────────────────────────────

export interface FeeTierChain {
  paused(): Promise<boolean>;
  hasRole(account: Address): Promise<boolean>;
  /** Which of these tiers are defined (`tierRates(t).set`). */
  definedTiers(tiers: readonly number[]): Promise<Set<number>>;
  accountTiers(accounts: readonly Address[]): Promise<Map<Address, number>>;
}

export interface FeeTierData {
  /** Age of the stats aggregator's cursor in ms, or null if it has never run. */
  statsAgeMs(): Promise<number | null>;
  /** Accounts with 30-day volume at or above `minVolume`. */
  qualifying(minVolume: bigint): Promise<Map<Address, bigint>>;
  /** Accounts the indexer shows holding a non-zero tier (Account.feeTier). */
  tiered(): Promise<Address[]>;
  /** 30-day volume for specific accounts (0 when absent). */
  volumes(accounts: readonly Address[]): Promise<Map<Address, bigint>>;
}

export interface FeeTierSender {
  readonly address: Address;
  submit(req: TxRequest): Promise<TxJob>;
  wait(job: TxJob): Promise<TxOutcome>;
  openJobs(): Promise<TxJob[]>;
}

export function viemFeeTierChain(o: { client: Pick<PublicClient, "multicall">; feeRouter: Address }): FeeTierChain {
  const batch = 200;
  return {
    async paused() {
      const [p] = await o.client.multicall({
        allowFailure: false,
        contracts: [{ address: o.feeRouter, abi: feeRouterAbi, functionName: "paused" }],
      });
      return Boolean(p);
    },
    async hasRole(account) {
      const [h] = await o.client.multicall({
        allowFailure: false,
        contracts: [{ address: o.feeRouter, abi: feeRouterAbi, functionName: "hasRole", args: [FEE_TIER_ROLE, account] }],
      });
      return Boolean(h);
    },
    async definedTiers(tiers) {
      const out = await o.client.multicall({
        allowFailure: false,
        contracts: tiers.map((t) => ({ address: o.feeRouter, abi: feeRouterAbi, functionName: "tierRates", args: [t] }) as const),
      });
      const set = new Set<number>();
      out.forEach((r, i) => {
        if ((r as { set: boolean }).set) set.add(tiers[i]);
      });
      return set;
    },
    async accountTiers(accounts) {
      const out = new Map<Address, number>();
      for (let i = 0; i < accounts.length; i += batch) {
        const slice = accounts.slice(i, i + batch);
        const res = await o.client.multicall({
          allowFailure: true,
          contracts: slice.map((a) => ({ address: o.feeRouter, abi: feeRouterAbi, functionName: "accountTier", args: [a] }) as const),
        });
        res.forEach((r, k) => {
          if (r.status === "success") out.set(slice[k], Number(r.result));
        });
      }
      return out;
    },
  };
}

export function pgFeeTierData(q: Queryable, network: string): FeeTierData {
  const asAddress = (x: unknown) => String(x).toLowerCase() as Address;
  return {
    async statsAgeMs() {
      const rows = await q.query(
        // "updatedAt" is written by now() into a zoneless timestamp, so compare it
        // with LOCALTIMESTAMP: both sides use this session's TimeZone.
        `SELECT (EXTRACT(EPOCH FROM (LOCALTIMESTAMP - "updatedAt")) * 1000)::bigint::text AS "ageMs"
           FROM "BlockCursor" WHERE "network" = $1 AND "stream" = 'stats'`,
        [network]
      );
      return rows.length === 0 ? null : Number(rows[0].ageMs);
    },
    async qualifying(minVolume) {
      const rows = await q.query(
        `SELECT "address", "volume30d"::text AS "v" FROM "AccountAnalytics" WHERE "network" = $1 AND "volume30d" >= $2`,
        [network, minVolume.toString()]
      );
      return new Map(rows.map((r) => [asAddress(r.address), BigInt(String(r.v))]));
    },
    async tiered() {
      const rows = await q.query(`SELECT "address" FROM "Account" WHERE "network" = $1 AND "feeTier" > 0`, [network]);
      return rows.map((r) => asAddress(r.address));
    },
    async volumes(accounts) {
      if (accounts.length === 0) return new Map();
      const rows = await q.query(
        `SELECT "address", "volume30d"::text AS "v" FROM "AccountAnalytics" WHERE "network" = $1 AND "address" = ANY($2::text[])`,
        [network, accounts.map((a) => a.toLowerCase())]
      );
      return new Map(rows.map((r) => [asAddress(r.address), BigInt(String(r.v))]));
    },
  };
}

// ─── bot ────────────────────────────────────────────────────────────────────

export type FeeTierIdle = "paused" | "stats-stale" | "tier-undefined" | "in-flight" | "lacks-role";

export type FeeTierTickResult =
  | { status: "idle"; reason: FeeTierIdle; detail?: unknown }
  | { status: "ran"; dryRun: boolean; changes: TierChange[]; deferred: number; applied: { change: TierChange; outcome: "confirmed" | "reverted" | "preflight" | "unconfirmed" }[] };

export interface FeeTierBotOptions {
  chain: FeeTierChain;
  data: FeeTierData;
  sender: FeeTierSender;
  feeRouter: Address;
  schedule: TierStep[];
  /** Sends nothing unless true. */
  enabled: boolean;
  maxChangesPerTick?: number;
  /** The aggregator must have run within this long. Default 2h. */
  maxStatsAgeMs?: number;
  log: Logger;
  metrics: Metrics;
  actions: KeeperActions;
}

export class FeeTierBot {
  private readonly max: number;
  private readonly maxStatsAge: number;
  private lastIdle: FeeTierIdle | null = null;

  constructor(private readonly o: FeeTierBotOptions) {
    if (o.schedule.length === 0) throw new Error("fee tier schedule is empty");
    this.max = o.maxChangesPerTick ?? 20;
    this.maxStatsAge = o.maxStatsAgeMs ?? 2 * 3_600_000;
  }

  private idle(reason: FeeTierIdle, detail?: unknown): FeeTierTickResult {
    this.o.metrics.inc(`fee_tier_idle_${reason.replace(/-/g, "_")}_total`);
    if (this.lastIdle !== reason) {
      const level = reason === "tier-undefined" || reason === "lacks-role" ? "error" : "info";
      this.o.log[level]("fee tier bot idle", { reason, detail });
    }
    this.lastIdle = reason;
    return { status: "idle", reason, detail };
  }

  async tick(): Promise<FeeTierTickResult> {
    const { chain, data, metrics, log } = this.o;
    if (await chain.paused()) return this.idle("paused");

    const age = await data.statsAgeMs();
    if (age === null || age > this.maxStatsAge) return this.idle("stats-stale", { ageMs: age, maxAgeMs: this.maxStatsAge });

    const tiers = this.o.schedule.map((s) => s.tier);
    const defined = await chain.definedTiers(tiers);
    const missing = tiers.filter((t) => !defined.has(t));
    if (missing.length > 0) return this.idle("tier-undefined", { missing });

    if (this.o.enabled) {
      if (!(await chain.hasRole(this.o.sender.address))) return this.idle("lacks-role", { bot: this.o.sender.address });
      if (await stillInFlight(this.o.sender, log)) return this.idle("in-flight");
    }
    this.lastIdle = null;

    const qualifying = await data.qualifying(this.o.schedule[0].minVolume);
    const tiered = await data.tiered();
    const candidates = [...new Set<Address>([...qualifying.keys(), ...tiered])];
    const volumes = new Map(qualifying);
    const missingVolumes = candidates.filter((a) => !volumes.has(a));
    for (const [a, v] of await data.volumes(missingVolumes)) volumes.set(a, v);
    const onChain = await chain.accountTiers(candidates);

    const { changes, deferred } = diffTiers(volumes, onChain, this.o.schedule, this.max);
    metrics.gauge("fee_tier_candidates", candidates.length);
    metrics.gauge("fee_tier_pending_changes", changes.length + deferred);

    if (!this.o.enabled) {
      if (changes.length > 0) {
        log.info("fee tier bot dry run: proposed changes (FEE_TIER_BOT_ENABLED is off; nothing sent)", {
          changes: changes.map((c) => ({ account: c.account, from: c.from, to: c.to, volume30dUsd: Number(c.volume30d / USD6) })),
          deferred,
        });
      }
      metrics.inc("fee_tier_dry_run_ticks_total");
      return { status: "ran", dryRun: true, changes, deferred, applied: [] };
    }

    const applied: Extract<FeeTierTickResult, { status: "ran" }>["applied"] = [];
    for (const change of changes) {
      const outcome = await this.apply(change);
      applied.push({ change, outcome });
      // A send that did not settle leaves this key's nonce open: stop here.
      if (outcome === "unconfirmed") break;
    }
    if (deferred > 0) log.info("fee tier changes deferred to later ticks", { deferred, perTick: this.max });
    return { status: "ran", dryRun: false, changes, deferred, applied };
  }

  private async apply(c: TierChange): Promise<"confirmed" | "reverted" | "preflight" | "unconfirmed"> {
    const { log, metrics, actions } = this.o;
    const data = encodeFunctionData({ abi: feeRouterAbi, functionName: "setAccountTier", args: [c.account, c.to] });
    const id = await actions.record({ kind: SET_ACTION, account: c.account, payload: { from: c.from, to: c.to, volume30d: c.volume30d } });

    let job: TxJob;
    try {
      job = await this.o.sender.submit({ to: this.o.feeRouter, data, label: `fee_tier.set ${c.account} ${c.from}->${c.to}` });
    } catch (err) {
      const { errorName } = decodeError(err);
      await actions.update(id, { status: "FAILED", payload: { from: c.from, to: c.to, preflight: { errorName, error: errorMessage(err) } } });
      metrics.inc("fee_tier_preflight_reverted_total");
      log.error("setAccountTier refused before sending", { account: c.account, to: c.to, errorName });
      return "preflight";
    }
    await actions.update(id, { status: "SUBMITTED", txJobId: job.id });

    let out: TxOutcome;
    try {
      out = await this.o.sender.wait(job);
    } catch (err) {
      log.warn("setAccountTier not confirmed in time; left for the reconciler", { account: c.account, error: errorMessage(err) });
      return "unconfirmed";
    }
    if (out.receipt.status !== "success") {
      await actions.update(id, { status: "FAILED", blockNumber: out.receipt.blockNumber });
      metrics.inc("fee_tier_reverted_total");
      return "reverted";
    }
    const ev = feeTierSetFrom(out.receipt, this.o.feeRouter, c.account);
    if (!ev || ev.tier !== c.to) {
      await actions.update(id, { status: "FAILED", blockNumber: out.receipt.blockNumber, payload: { from: c.from, to: c.to, note: "no matching FeeTierSet in receipt" } });
      log.error("setAccountTier succeeded without a matching FeeTierSet event", { account: c.account });
      return "reverted";
    }
    await actions.update(id, { status: "CONFIRMED", blockNumber: out.receipt.blockNumber });
    metrics.inc(c.to > c.from ? "fee_tier_upgrades_total" : "fee_tier_downgrades_total");
    log.info("fee tier set", { account: c.account, from: c.from, to: c.to });
    return "confirmed";
  }
}

function feeTierSetFrom(receipt: TransactionReceipt, feeRouter: Address, account: Address): { tier: number } | null {
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== feeRouter.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: feeRouterAbi, data: l.data, topics: l.topics });
      if (ev.eventName !== "FeeTierSet") continue;
      const args = ev.args as { account: Address; tier: number };
      if (args.account.toLowerCase() === account.toLowerCase()) return { tier: Number(args.tier) };
    } catch {
      // not ours
    }
  }
  return null;
}
