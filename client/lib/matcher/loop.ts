/**
 * The matcher's tick and its lifecycle (plan §4.2.6).
 *
 *   load → match → band → batch → submit → wait → apply → sleep
 *
 * One batch is in flight at a time. `TxSender` owns the nonce for its key, so
 * a shard is a single key and a single sequence of settlement transactions;
 * running two of them against one key would have both allocate the same nonce.
 *
 * Startup does recovery before it does anything new: every open `TxJob` for
 * the key is finished first, and every PENDING fill the previous process
 * reserved is reconciled, so the shard never begins a tick with size reserved
 * against a batch nobody is watching.
 *
 * Shutdown lets the in-flight batch finish. If it cannot, the batch stays as
 * an open job with its fills reserved, which is exactly what recovery expects.
 *
 * Server-side only.
 */

import type { Address, Hex, PublicClient, TransactionReceipt } from "viem";

import { insuranceAbi, orderGatewayAbi } from "@/lib/chain/contracts";
import type { ArcNetwork, ProtocolContracts } from "@/lib/chain/networks";
import { TxTimeoutError, type TxSender } from "@/lib/chain/tx-sender";
import type { TxJob } from "@/lib/chain/tx-store";
import { matchOrders } from "@/lib/market/matching-engine";
import {
  OracleUnavailableError,
  bandFor,
  filterBackstopFills,
  filterByBand,
  isBackstopMatch,
  readIndexPrice,
  withinBand,
  type BackstopLimits,
} from "./band";
import { applyBatchResult, resultFromReceipt, revertReasonFor } from "./apply";
import { buildFills, chainGasEstimator, halveAfterGasRevert, sizeBatches, type PlannedFill } from "./batch";
import { loadBook, loadMinValidNonces, loadSignedOrders, MarketNotConfiguredError } from "./book";
import { DEFAULT_COOLDOWN, RejectionCooldown, type CooldownOptions } from "./cooldown";
import type { Db } from "./db";
import { erc1271CheckerFor, type Erc1271Checker } from "@/lib/validation";
import { newMetrics, recordBatchGas, type MatcherMetrics } from "./metrics";
import { linkFillsToJob, releasePendingFills, submitBatch } from "./submit";

/** The read surface a shard needs from the chain. */
export type MatcherChain = Pick<PublicClient, "readContract" | "estimateGas" | "call">;

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface MatcherClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

export const systemMatcherClock: MatcherClock = {
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface MatcherOptions {
  db: Db;
  network: ArcNetwork;
  contracts: ProtocolContracts;
  chain: MatcherChain;
  sender: TxSender;
  /** Market ids this shard matches. One shard, one operator key. */
  marketIds: number[];
  pollMs?: number;
  log: Logger;
  clock?: MatcherClock;
  metrics?: MatcherMetrics;
  /** Below this many fills a gas resize gives up instead of halving again. */
  minBatchFills?: number;
  /**
   * How long a PENDING fill with no `txJobId` may sit before recovery decides
   * whether its batch ever reached the chain.
   */
  orphanGraceMs?: number;
  /**
   * Decides a rejected signature that ECDSA cannot clear (contract wallets,
   * including the Insurance backstop's unwind orders). Defaults to the
   * network's gas-capped `eth_call` checker; tests inject their own.
   */
  erc1271?: Erc1271Checker;
  /**
   * How long an order waits after the chain refuses a fill it was in, and
   * when to stop retrying it altogether. Defaults to DEFAULT_COOLDOWN.
   */
  cooldown?: CooldownOptions;
}

export class Matcher {
  readonly metrics: MatcherMetrics;
  private readonly o: Required<Omit<MatcherOptions, "metrics">> & { metrics: MatcherMetrics };
  private stopping = false;
  private running: Promise<void> | null = null;
  private readonly cooldown: RejectionCooldown;

  constructor(options: MatcherOptions) {
    this.metrics = options.metrics ?? newMetrics();
    this.o = {
      pollMs: 1_000,
      clock: systemMatcherClock,
      minBatchFills: 1,
      cooldown: DEFAULT_COOLDOWN,
      orphanGraceMs: 60_000,
      erc1271: erc1271CheckerFor(options.network.id),
      ...options,
      metrics: this.metrics,
    };
    if (this.o.marketIds.length === 0) throw new Error("a matcher shard needs at least one market id");
    this.cooldown = new RejectionCooldown(this.o.cooldown);
  }

  /** Insurance's unwind limits and what is left of today's cap. */
  private async backstopLimits(): Promise<BackstopLimits> {
    const [maxDeviationBps, maxFillNotional, maxDailyNotional, usedToday] = (await this.o.chain.readContract({
      address: this.o.contracts.insurance,
      abi: insuranceAbi,
      functionName: "unwindLimits",
    })) as [number, bigint, bigint, bigint];
    const remaining = maxDailyNotional - usedToday;
    return {
      maxDeviationBps: BigInt(maxDeviationBps),
      maxFillNotional,
      dailyRemaining: remaining > 0n ? remaining : 0n,
    };
  }

  private get network(): string {
    return this.o.network.id;
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /** Recover, then tick until `stop()`. */
  async run(): Promise<void> {
    await this.recover();
    this.running = this.loop();
    return this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.tick();
      } catch (err) {
        this.metrics.tickErrors += 1;
        this.o.log.error("tick_failed", { error: message(err) });
      }
      if (this.stopping) break;
      await this.o.clock.sleep(this.o.pollMs);
    }
  }

  /** Stop after the current tick. The in-flight batch is finished, not abandoned. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.running) await this.running.catch(() => undefined);
    this.o.log.info("stopped", { metrics: this.metrics.ticks });
  }

  // ─── recovery ──────────────────────────────────────────────────────────────

  /**
   * Finish what the previous process started, before matching anything new.
   *
   * Open jobs first: each is a batch that may or may not have been mined, and
   * `wait()` settles that question. Then the fills that never got as far as a
   * job, which is the window between committing the reservation and the node
   * accepting the broadcast.
   */
  async recover(): Promise<void> {
    const jobs = await this.o.sender.openJobs();
    this.o.log.info("recovery_started", { openJobs: jobs.length, key: this.o.sender.address });

    for (const job of jobs) {
      if (!job.label.startsWith("settleFillsSigned")) {
        this.o.log.warn("recovery_foreign_job", { job: job.id, label: job.label });
        continue;
      }
      const fills = await this.fillsForJob(job.id);
      if (fills.length === 0) {
        this.o.log.warn("recovery_job_without_fills", { job: job.id, nonce: job.nonce });
      }
      await this.awaitAndApply(job, fills);
    }

    await this.reconcileOrphanFills();
    this.o.log.info("recovery_finished", {});
  }

  /**
   * PENDING fills whose batch nobody is waiting for any more.
   *
   * Two ways to get one. The narrow window between committing the reservation
   * and the node accepting the broadcast leaves a fill with no `txJobId`. The
   * other is a batch that was broadcast and then lost its transaction — the
   * nonce taken by something else, or the node refusing it outright — which
   * leaves the fill pointing at a `TxJob` in a terminal, unconfirmed state.
   * Without this second case those fills hold their size reserved forever,
   * because `openJobs` only returns jobs still in flight.
   *
   * Either way the batch reached the chain or it did not, and
   * `OrderGateway.filled` answers it: if the maker's on-chain filled amount
   * leaves no room for this fill, it never landed and the reservation is
   * released. If it does leave room the fill may have settled, so the row is
   * left for the indexer to confirm rather than released into a double-fill.
   */
  private async reconcileOrphanFills(): Promise<void> {
    const cutoff = new Date(this.o.clock.nowMs() - this.o.orphanGraceMs);
    const rows = await this.o.db.query(
      `SELECT f."fillId", f."makerOrderHash", f."size"::text AS size
       FROM "Fill" f
       WHERE f."network" = $1 AND f."status" = 'PENDING'
         AND f."marketId" = ANY($2::int[]) AND f."createdAt" < $3
         AND (
           f."txJobId" IS NULL
           OR EXISTS (
             SELECT 1 FROM "TxJob" j
             WHERE j."id" = f."txJobId" AND j."status" IN ('DROPPED', 'FAILED')
           )
         )`,
      [this.network, this.o.marketIds, cutoff]
    );
    if (rows.length === 0) return;

    const orders = await loadSignedOrders(
      this.o.db,
      this.network,
      rows.map((r) => String(r.makerOrderHash) as Hex)
    );
    const release: Hex[] = [];
    const keep: Hex[] = [];

    for (const row of rows) {
      const fillId = String(row.fillId) as Hex;
      const maker = orders.get(String(row.makerOrderHash) as Hex);
      if (!maker) {
        keep.push(fillId);
        continue;
      }
      const onChainFilled = await this.o.chain.readContract({
        address: this.o.contracts.orderGateway,
        abi: orderGatewayAbi,
        functionName: "filled",
        args: [maker.owner, maker.nonce],
      });
      const settled = await this.settledSizeFor(String(row.makerOrderHash) as Hex);
      // No room on-chain for this fill on top of what is already recorded
      // settled ⇒ it was never mined ⇒ the reservation is safe to release.
      (onChainFilled < settled + BigInt(String(row.size)) ? release : keep).push(fillId);
    }

    const released = await releasePendingFills(this.o.db, this.network, release);
    this.o.log.info("recovery_orphans", { released, keptForReconciler: keep.length });
    if (keep.length > 0) this.o.log.warn("recovery_orphans_undecided", { fills: keep });
  }

  private async settledSizeFor(orderHash: Hex): Promise<bigint> {
    const rows = await this.o.db.query(
      `SELECT COALESCE(SUM("size"), 0)::text AS total FROM "Fill"
       WHERE "network" = $1 AND "status" = 'SETTLED'
         AND ("makerOrderHash" = $2 OR "takerOrderHash" = $2)`,
      [this.network, orderHash.toLowerCase()]
    );
    return BigInt(String(rows[0]?.total ?? "0"));
  }

  /** Rebuild a job's batch from its PENDING fills and the signed orders behind them. */
  private async fillsForJob(txJobId: string): Promise<PlannedFill[]> {
    const rows = await this.o.db.query(
      `SELECT "fillId", "marketId", "makerOrderHash", "takerOrderHash",
              "size"::text AS size, "price"::text AS price
       FROM "Fill"
       WHERE "network" = $1 AND "txJobId" = $2 AND "status" = 'PENDING'
       ORDER BY "id" ASC`,
      [this.network, txJobId]
    );
    if (rows.length === 0) return [];
    const hashes = rows.flatMap((r) => [String(r.makerOrderHash) as Hex, String(r.takerOrderHash) as Hex]);
    const orders = await loadSignedOrders(this.o.db, this.network, hashes);

    const out: PlannedFill[] = [];
    for (const r of rows) {
      const maker = orders.get(String(r.makerOrderHash) as Hex);
      const taker = orders.get(String(r.takerOrderHash) as Hex);
      if (!maker || !taker) continue;
      out.push({
        fillId: String(r.fillId) as Hex,
        maker: strip(maker),
        makerSignature: maker.signature,
        taker: strip(taker),
        takerSignature: taker.signature,
        size: BigInt(String(r.size)),
        price: BigInt(String(r.price)),
        marketId: Number(r.marketId),
        makerOrderHash: String(r.makerOrderHash) as Hex,
        takerOrderHash: String(r.takerOrderHash) as Hex,
        takerIsBuy: taker.isLong,
        notional: (BigInt(String(r.size)) * BigInt(String(r.price))) / 10n ** 18n,
      });
    }
    return out;
  }

  // ─── the tick ──────────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    this.metrics.ticks += 1;
    this.metrics.lastTickAt = this.o.clock.nowMs();
    for (const marketId of this.o.marketIds) {
      if (this.stopping) return;
      await this.tickMarket(marketId);
    }
  }

  private async tickMarket(marketId: number): Promise<void> {
    const nowSec = BigInt(Math.floor(this.o.clock.nowMs() / 1000));

    let book;
    try {
      book = await loadBook(this.o.db, this.network, marketId, nowSec);
    } catch (err) {
      if (err instanceof MarketNotConfiguredError) {
        this.o.log.warn("market_not_configured", { marketId, error: message(err) });
        return;
      }
      throw err;
    }
    if (!book.market.active) return;
    if (book.orders.length === 0) return;

    // Orders the chain has just refused wait their turn out. Without this the
    // same pair is re-offered every tick and every rejection costs gas.
    const nowMs = this.o.clock.nowMs();
    this.cooldown.sweep(nowMs);
    const orders = book.orders.filter((o) => !this.cooldown.blocked(o.orderHash, nowMs));
    this.metrics.ordersCoolingDown = this.cooldown.blockedCount(nowMs);
    if (orders.length === 0) return;

    let index;
    try {
      index = await readIndexPrice(this.o.chain, this.o.contracts.oracleAdapter, book.market);
    } catch (err) {
      if (err instanceof OracleUnavailableError) {
        this.metrics.oracleSkips += 1;
        this.o.log.warn("oracle_unavailable", { marketId, error: message(err) });
        return;
      }
      throw err;
    }

    // The band goes into the engine as a maker-price test, not a filter over
    // the matches it produced: a quote the Engine would refuse must not absorb
    // a taker's size and starve the orders resting behind it. `filterByBand`
    // below is then only a consistency check against the same band.
    const band = bandFor(index.price, book.market.maxExecutionDeviationBps);
    const { matches } = matchOrders({
      marketId,
      nowSec,
      orders,
      positions: book.positions,
      minValidNonce: book.minValidNonce,
      minFillNotional: book.market.minFillNotional,
      acceptPrice: (price) => withinBand(price, band),
    });
    if (matches.length === 0) return;
    this.metrics.matches += matches.length;

    const { kept, dropped } = filterByBand(matches, index.price, book.market.maxExecutionDeviationBps);
    if (dropped.length > 0) {
      this.metrics.bandDrops += dropped.length;
      this.o.log.warn("band_dropped", {
        marketId,
        dropped: dropped.length,
        index: index.price.toString(),
        low: band.low.toString(),
        high: band.high.toString(),
      });
    }
    if (kept.length === 0) return;

    // The Insurance backstop is held to its own, tighter band and to per-fill
    // and daily caps (`Insurance.onBackstopFill`). Read them only when a match
    // actually involves it: unwinding is off for most of the protocol's life.
    let offered = kept;
    if (kept.some((m) => isBackstopMatch(m, this.o.contracts.insurance))) {
      const limits = await this.backstopLimits();
      const guard = filterBackstopFills(kept, { backstop: this.o.contracts.insurance, index: index.price, limits });
      if (guard.dropped.length > 0) {
        this.metrics.backstopDrops += guard.dropped.length;
        this.o.log.warn("backstop_dropped", {
          marketId,
          dropped: guard.dropped.length,
          reasons: [...new Set(guard.dropped.map((d) => d.reason))],
          maxDeviationBps: Number(limits.maxDeviationBps),
          index: index.price.toString(),
        });
      }
      offered = guard.kept;
      if (offered.length === 0) return;
    }

    const fills = await buildFills(this.o.db, this.network, offered);
    if (fills.length === 0) return;

    const estimator = chainGasEstimator(
      this.o.chain,
      this.o.contracts.orderGateway,
      this.o.sender.address
    );
    const batches = await sizeBatches(fills, estimator, { minBatchFills: this.o.minBatchFills });

    for (const batch of batches) {
      if (this.stopping) {
        this.o.log.info("shutdown_before_batch", { marketId, fills: batch.fills.length });
        return;
      }
      await this.settle(book.market.symbol, batch.fills, batch.gas, estimator);
    }
  }

  // ─── one batch ─────────────────────────────────────────────────────────────

  /**
   * Reserve, broadcast, wait, apply. On `InsufficientBatchGas` the batch is
   * halved and both halves are retried, down to `minBatchFills`; the size that
   * did settle is logged, because that is the number the batch cap is set from.
   */
  private async settle(
    symbol: string,
    fills: readonly PlannedFill[],
    gas: bigint,
    estimator: ReturnType<typeof chainGasEstimator>
  ): Promise<void> {
    if (fills.length === 0) return;
    const label = `settleFillsSigned:${symbol}`;
    const submitted = await submitBatch(
      { db: this.o.db, network: this.network, sender: this.o.sender, gateway: this.o.contracts.orderGateway, label },
      fills,
      gas
    );
    this.metrics.fillsSubmitted += fills.length;
    this.o.log.info("batch_submitted", {
      symbol,
      fills: fills.length,
      gas: gas.toString(),
      job: submitted.job.id,
      nonce: submitted.job.nonce,
      hash: submitted.job.submittedHash,
    });

    const receipt = await this.awaitAndApply(submitted.job, submitted.fills);
    if (receipt === null) return;
    if (receipt.status === "success") return;

    // Reverted: nothing in the batch happened, so the reservation goes back
    // before anything is retried.
    this.metrics.batchReverts += 1;
    await releasePendingFills(this.o.db, this.network, fills.map((f) => f.fillId));

    const { errorName } = await revertReasonFor(this.o.chain, receipt, {
      from: this.o.sender.address,
      to: this.o.contracts.orderGateway,
      data: submitted.job.data,
      gas: submitted.job.gasLimit,
    });
    this.o.log.error("batch_reverted", { symbol, fills: fills.length, reason: errorName ?? "unknown" });

    if (errorName !== "InsufficientBatchGas") return;
    const halves = halveAfterGasRevert(fills, this.o.minBatchFills);
    if (halves.length === 0) {
      this.o.log.error("batch_gas_floor_reached", { symbol, fills: fills.length });
      return;
    }

    this.metrics.gasResizes += 1;
    for (const part of halves) {
      if (this.stopping) return;
      const [sized] = await sizeBatches(part, estimator, { minBatchFills: this.o.minBatchFills });
      if (!sized) return;
      await this.settle(symbol, sized.fills, sized.gas, estimator);
    }
  }

  /**
   * Wait for a job's receipt and apply it. Returns null when the wait times
   * out: the job stays open with its fills reserved, which is precisely the
   * state recovery and the reconciler are built to resolve.
   */
  private async awaitAndApply(job: TxJob, fills: readonly PlannedFill[]): Promise<TransactionReceipt | null> {
    if (fills.length > 0) await linkFillsToJob(this.o.db, this.network, fills.map((f) => f.fillId), job.id);

    let receipt: TransactionReceipt;
    try {
      ({ receipt } = await this.o.sender.wait(job));
    } catch (err) {
      if (err instanceof TxTimeoutError) {
        this.o.log.warn("batch_wait_timeout", { job: job.id, nonce: job.nonce, fills: fills.length });
        return null;
      }
      throw err;
    }
    if (receipt.status !== "success" || fills.length === 0) return receipt;

    const result = resultFromReceipt(receipt, this.o.contracts.orderGateway);
    const owners = fills.flatMap((f) => [f.maker.owner.toLowerCase(), f.taker.owner.toLowerCase()]);
    const minValidNonce = await loadMinValidNonces(this.o.db, this.network, owners);

    const applied = await applyBatchResult(
      {
        q: this.o.db,
        network: this.network,
        chainId: this.o.network.chainId,
        gateway: this.o.contracts.orderGateway,
        nowSec: BigInt(Math.floor(this.o.clock.nowMs() / 1000)),
        minValidNonce,
        erc1271: this.o.erc1271,
      },
      fills,
      result
    );

    this.metrics.fillsSettled += applied.settled.length;
    this.metrics.fillsRejected += applied.rejected.length;
    this.metrics.fillsUnaccounted += applied.unaccounted.length;
    this.metrics.ordersRetired += applied.retired.length;
    this.metrics.matcherBugs += applied.matcherBugs.length;
    recordBatchGas(this.metrics, fills.length, receipt.gasUsed);

    this.o.log.info("batch_applied", {
      job: job.id,
      fills: fills.length,
      settled: applied.settled.length,
      rejected: applied.rejected.length,
      retired: applied.retired.length,
      gasUsed: receipt.gasUsed.toString(),
      gasPerFill: this.metrics.lastGasPerFill.toString(),
    });
    if (applied.rejected.length > 0) {
      this.o.log.warn("batch_rejections", { job: job.id, rejected: applied.rejected });
      this.recordRejectionBackoff(fills, applied.rejected);
    }
    // A fill that settled proves both its orders are fine; drop any strikes
    // they were carrying so an old rejection cannot escalate a new one.
    if (applied.settled.length > 0) {
      const settled = new Set(applied.settled.map((id) => id.toLowerCase()));
      for (const f of fills) {
        if (!settled.has(f.fillId.toLowerCase())) continue;
        this.cooldown.clear(f.makerOrderHash);
        this.cooldown.clear(f.takerOrderHash);
      }
    }
    if (applied.unaccounted.length > 0) {
      this.o.log.error("batch_unaccounted", { job: job.id, fills: applied.unaccounted });
    }
    if (applied.matcherBugs.length > 0) {
      this.o.log.error("matcher_bug_rejections", { job: job.id, rejections: applied.matcherBugs });
    }
    if (applied.unblamed.length > 0) {
      this.o.log.warn("signature_rejection_unblamed", { job: job.id, fills: applied.unblamed });
    }
    return receipt;
  }

  /**
   * Hold back the orders behind a retryable rejection, for longer each time.
   *
   * Only `retryable` earns a strike: a poison rejection has already retired
   * its order, and a matcher bug is ours to fix, not the order's to wait out.
   */
  private recordRejectionBackoff(
    fills: readonly PlannedFill[],
    rejected: readonly { fillId: Hex; reason: string; kind: string }[]
  ): void {
    const nowMs = this.o.clock.nowMs();
    const byFillId = new Map(fills.map((f) => [f.fillId.toLowerCase(), f]));
    for (const r of rejected) {
      if (r.kind !== "retryable") continue;
      const fill = byFillId.get(r.fillId.toLowerCase());
      if (!fill) continue;
      for (const orderHash of [fill.makerOrderHash, fill.takerOrderHash]) {
        const state = this.cooldown.strike(orderHash, r.reason, nowMs);
        if (state.parked && state.strikes === this.o.cooldown.parkAfter) {
          this.metrics.ordersParked += 1;
          this.o.log.warn("order_parked", {
            orderHash,
            reason: r.reason,
            strikes: state.strikes,
            waitMs: state.until - nowMs,
          });
        }
      }
    }
    this.metrics.ordersCoolingDown = this.cooldown.blockedCount(nowMs);
  }
}

function strip(row: {
  owner: Address;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  reduceOnly: boolean;
  nonce: bigint;
  expiry: bigint;
  referrer: Address;
}) {
  return {
    owner: row.owner,
    marketId: row.marketId,
    isLong: row.isLong,
    size: row.size,
    limitPrice: row.limitPrice,
    reduceOnly: row.reduceOnly,
    nonce: row.nonce,
    expiry: row.expiry,
    referrer: row.referrer,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
