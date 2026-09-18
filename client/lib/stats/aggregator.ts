/**
 * The stats aggregator: fills `TraderStat`, `AccountAnalytics` and
 * `LeaderboardSnapshot` from the indexer's projections, so `/api/leaderboard`
 * and `/api/portfolio/[address]` have something to serve.
 *
 * INCREMENTAL, BUT NEVER ACCUMULATED
 * ----------------------------------
 * Rolling windows cannot be accumulated: a trade that ages out of DAY would
 * have to be subtracted, and any arithmetic that adds and subtracts drifts from
 * the truth in a way nothing notices. So the cursor decides only WHICH
 * addresses to look at, and each one is then recomputed from its own events by
 * `computeAddressStats`. That makes "incremental" and "rebuild" the same
 * function over the same rows, which is why they agree; the nightly recompute
 * and the database tests check it rather than assume it.
 *
 * An address is recomputed when either:
 *  - an event after the cursor touched it (`dirtyAddressesSince`), or
 *  - its stored window is no longer the current one (`addressesWithStaleWindow`) —
 *    this is what happens at 00:00 UTC, and what removes a trader whose only
 *    trade has aged out.
 *
 * THE CURSOR
 * ----------
 * A `BlockCursor` row (`stream = 'stats'`) holding the last block processed and
 * that block's hash. A hash that no longer matches means the chain moved under
 * us, and the answer is a full rebuild rather than a guess about what changed.
 * No cursor at all (a fresh database, or `--rebuild`) is also a full rebuild.
 *
 * IDEMPOTENT
 * ----------
 * Every write is delete-then-insert for the addresses in hand, inside one
 * transaction. Reprocessing a window writes the same rows; a crash halfway
 * leaves the cursor where it was, so the next run redoes that work harmlessly.
 *
 * It holds no key and sends no transaction.
 */

import type { Db, Query } from "@/lib/indexer/db";
import type { ArcNetworkId } from "@/lib/network";
import { errorMessage, utcDay, type Clock, type Logger, type Metrics } from "@/lib/keepers/runtime";
import {
  addressesWithStaleWindow,
  allKnownAddresses,
  blockHashAt,
  dirtyAddressesSince,
  getStatsCursor,
  indexedHead,
  insertLeaderboardSnapshot,
  loadActivity,
  rankTraders,
  readAccountAnalytics,
  readTraderStats,
  replaceAddressStats,
  setStatsCursor,
  SNAPSHOT_METRICS,
  type IndexedHead,
  type SnapshotMetric,
} from "@/lib/queries/analytics";
import {
  computeAddressStats,
  emptyActivity,
  STATS_PERIODS,
  windowStart,
  type AccountAnalyticsRow,
  type AddressStats,
  type TraderStatRow,
} from "./metrics";
import { describeMismatches, diffStats, type Mismatch } from "./verify";

export interface AggregatorOptions {
  db: Db;
  network: ArcNetworkId;
  log: Logger;
  metrics: Metrics;
  clock: Clock;
  /** Addresses recomputed per transaction. */
  batchSize?: number;
  /** How often a `LeaderboardSnapshot` set is captured. */
  snapshotEveryMs?: number;
  /** Traders per snapshot. */
  snapshotLimit?: number;
  /** UTC hour at which the nightly full recompute runs (0–23). */
  rebuildHourUtc?: number;
}

export interface TickResult {
  mode: "incremental" | "rebuild";
  reason?: "no-cursor" | "reorg" | "nightly" | "requested";
  addresses: number;
  traderStats: number;
  analytics: number;
  snapshots: number;
  mismatches: number;
}

const DEFAULTS = { batchSize: 200, snapshotEveryMs: 300_000, snapshotLimit: 100, rebuildHourUtc: 0 };

const chunk = <T>(xs: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
};

export class StatsAggregator {
  private readonly o: Required<Omit<AggregatorOptions, "db" | "network" | "log" | "metrics" | "clock">> &
    AggregatorOptions;
  private lastSnapshotAt = -Infinity;
  private lastRebuildDay: string | null = null;

  constructor(options: AggregatorOptions) {
    this.o = { ...DEFAULTS, ...options };
  }

  /** One pass. Does the incremental work, then snapshots and the nightly recompute if due. */
  async tick(): Promise<TickResult> {
    const now = new Date(this.o.clock.now());
    const db = this.o.db;
    const network = this.o.network;

    // Head first: anything the indexer writes after this read is picked up by
    // the next tick, never silently skipped.
    const head = await indexedHead(db, network);
    const cursor = await getStatsCursor(db, network);

    let result: TickResult;
    if (cursor === null) {
      result = await this.rebuild(now, "no-cursor", head);
    } else if (head !== null && (await blockHashAt(db, network, cursor.blockNumber)) !== cursor.blockHash) {
      this.o.log.warn("stats cursor no longer matches the chain; rebuilding", {
        cursorBlock: cursor.blockNumber.toString(),
      });
      this.o.metrics.inc("stats_reorg_rebuilds_total");
      result = await this.rebuild(now, "reorg", head);
    } else {
      result = await this.incremental(now, cursor, head);
    }

    if (this.nightlyDue(now)) {
      this.lastRebuildDay = utcDay(now);
      const verified = await this.rebuild(now, "nightly", await indexedHead(db, network), true);
      result = { ...verified, snapshots: result.snapshots };
    }
    result.snapshots += await this.snapshotsIfDue(now);
    return result;
  }

  /** Recompute only the addresses the cursor and the clock say may have moved. */
  private async incremental(now: Date, cursor: IndexedHead, head: IndexedHead | null): Promise<TickResult> {
    const db = this.o.db;
    const network = this.o.network;
    const upTo = head?.blockNumber ?? cursor.blockNumber;
    const rolling = STATS_PERIODS.filter((p) => p !== "ALL").map((period) => ({
      period,
      start: windowStart(period, now),
    }));
    const [touched, stale] = await Promise.all([
      dirtyAddressesSince(db, network, cursor.blockNumber, upTo),
      addressesWithStaleWindow(db, network, rolling),
    ]);
    const addresses = [...new Set([...touched, ...stale])];
    const written = await this.recompute(addresses, now);
    if (head !== null && head.blockNumber !== cursor.blockNumber) await setStatsCursor(db, network, head);
    this.o.metrics.inc("stats_addresses_total", addresses.length);
    this.o.log.info("incremental pass", {
      addresses: addresses.length,
      touched: touched.length,
      windowRolled: stale.length,
      cursor: upTo.toString(),
      ...written,
    });
    return { mode: "incremental", addresses: addresses.length, ...written, snapshots: 0, mismatches: 0 };
  }

  /**
   * Recompute EVERY address from the projections, in one transaction.
   * With `verify`, the rows already stored are compared against the recompute
   * first — the check that keeps the incremental maths honest.
   */
  async rebuild(
    now: Date,
    reason: TickResult["reason"],
    head: IndexedHead | null,
    verify = false
  ): Promise<TickResult> {
    const db = this.o.db;
    const network = this.o.network;
    const addresses = await allKnownAddresses(db, network);
    const results: AddressStats[] = [];
    for (const batch of chunk(addresses, this.o.batchSize!)) {
      const activity = await loadActivity(db, network, batch);
      for (const address of batch) {
        results.push(computeAddressStats(address, activity.get(address) ?? emptyActivity(), now));
      }
    }
    const traderStats = results.flatMap((r) => r.traderStats);
    const analytics = results.map((r) => r.analytics).filter((a): a is AccountAnalyticsRow => a !== null);

    let mismatches: Mismatch[] = [];
    await db.transaction(async (q) => {
      if (verify) mismatches = await this.compare(q, { traderStats, analytics });
      await replaceAddressStats(q, network, addresses, results, now);
      if (head !== null) await setStatsCursor(q, network, head);
    });

    this.o.metrics.inc("stats_rebuilds_total");
    this.o.metrics.gauge("stats_rebuild_mismatches", mismatches.length);
    if (mismatches.length > 0) {
      // Loud, but not fatal: the rebuild has already written the right rows.
      this.o.log.warn("the incremental result did not match a full recompute", {
        mismatches: mismatches.length,
        examples: describeMismatches(mismatches),
      });
    }
    this.o.log.info("rebuild complete", {
      reason,
      addresses: addresses.length,
      traderStats: traderStats.length,
      analytics: analytics.length,
      mismatches: mismatches.length,
    });
    return {
      mode: "rebuild",
      reason,
      addresses: addresses.length,
      traderStats: traderStats.length,
      analytics: analytics.length,
      snapshots: 0,
      mismatches: mismatches.length,
    };
  }

  private async compare(
    q: Query,
    computed: { traderStats: TraderStatRow[]; analytics: AccountAnalyticsRow[] }
  ): Promise<Mismatch[]> {
    const [storedStats, storedAnalytics] = await Promise.all([
      readTraderStats(q, this.o.network),
      readAccountAnalytics(q, this.o.network),
    ]);
    return diffStats({ traderStats: storedStats, analytics: storedAnalytics }, computed);
  }

  private async recompute(addresses: readonly string[], now: Date): Promise<{ traderStats: number; analytics: number }> {
    let traderStats = 0;
    let analytics = 0;
    for (const batch of chunk(addresses, this.o.batchSize!)) {
      const activity = await loadActivity(this.o.db, this.o.network, batch);
      const results = batch.map((address) =>
        computeAddressStats(address, activity.get(address) ?? emptyActivity(), now)
      );
      const written = await this.o.db.transaction((q) =>
        replaceAddressStats(q, this.o.network, batch, results, now)
      );
      traderStats += written.traderStats;
      analytics += written.analytics;
    }
    return { traderStats, analytics };
  }

  /** A `LeaderboardSnapshot` per (period, metric) — the historical boards. */
  async snapshot(now: Date): Promise<number> {
    let written = 0;
    for (const period of STATS_PERIODS) {
      for (const metric of Object.keys(SNAPSHOT_METRICS) as SnapshotMetric[]) {
        const { ranked, traderCount } = await rankTraders(
          this.o.db,
          this.o.network,
          period,
          metric,
          this.o.snapshotLimit!
        );
        if (traderCount === 0) continue;
        await insertLeaderboardSnapshot(this.o.db, this.o.network, period, metric, ranked, traderCount, now);
        written += 1;
      }
    }
    this.lastSnapshotAt = this.o.clock.now();
    this.o.metrics.inc("stats_snapshots_total", written);
    return written;
  }

  private async snapshotsIfDue(now: Date): Promise<number> {
    if (this.o.clock.now() - this.lastSnapshotAt < this.o.snapshotEveryMs!) return 0;
    try {
      return await this.snapshot(now);
    } catch (err) {
      // A snapshot is a historical nicety; never let it fail the pass that
      // keeps the live boards current.
      this.o.metrics.inc("stats_snapshot_errors_total");
      this.o.log.warn("snapshot failed", { error: errorMessage(err) });
      this.lastSnapshotAt = this.o.clock.now();
      return 0;
    }
  }

  private nightlyDue(now: Date): boolean {
    if (this.lastRebuildDay === null) {
      // Not on the first tick: the process has just started and may have
      // rebuilt already. Arm it for the next UTC day instead.
      this.lastRebuildDay = utcDay(now);
      return false;
    }
    return utcDay(now) !== this.lastRebuildDay && now.getUTCHours() >= this.o.rebuildHourUtc!;
  }
}
