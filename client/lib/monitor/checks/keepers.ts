/**
 * Keepers and settlement: is every service doing its job, and can it keep
 * doing it (gas)?
 */

import type { Address } from "viem";

import type { AccountHealth } from "@/lib/chain/collateral";
import { CURSOR_STREAM } from "@/lib/indexer/indexer";
import { detectNonceGaps } from "@/lib/reconciler/jobs";

import type { ChainHead, MarketState } from "../chain";
import type { GasTarget, MonitorConfig } from "../config";
import { reads, type Check, type CheckContext } from "../context";
import type { CrossedBook, OpenJob, PendingFill, PendingFillKind } from "../store";
import { fmtSecs, orNothingToCheck, resultsFor, toFloat18, usd18, type CheckMeta, type CheckResult } from "../types";

// ─── indexer ────────────────────────────────────────────────────────────────

export const INDEXER: CheckMeta = {
  id: "indexer.lag",
  severity: "PAGE",
  runbook: "indexer-stalled.md",
  description: "The indexer's cursor keeps up with the chain head",
};

export function evaluateIndexer(
  cursor: { blockNumber: bigint } | null,
  head: ChainHead,
  cursorTime: number | null,
  cfg: MonitorConfig["indexer"]
): CheckResult[] {
  const r = resultsFor(INDEXER);
  if (!cursor) return [r.fail("the indexer has never written a cursor", { lagBlocks: null, lagSecs: null })];
  const lagBlocks = head.number > cursor.blockNumber ? Number(head.number - cursor.blockNumber) : 0;
  const lagSecs = lagBlocks === 0 || cursorTime === null ? 0 : Math.max(0, head.timestamp - cursorTime);
  const values = { lagBlocks, lagSecs, cursor: cursor.blockNumber.toString(), head: head.number.toString() };
  if (lagSecs > cfg.lagSecs || lagBlocks > cfg.lagBlocks) {
    return [r.fail(`indexer is ${lagBlocks} block(s) / ${fmtSecs(lagSecs)} behind the head (limits ${cfg.lagBlocks} blocks, ${cfg.lagSecs}s)`, values)];
  }
  return [r.pass(`indexer ${lagBlocks} block(s) / ${fmtSecs(lagSecs)} behind`, values)];
}

// ─── matcher ────────────────────────────────────────────────────────────────

export const CROSSED: CheckMeta = {
  id: "matcher.crossed-book",
  severity: "WARN",
  runbook: "matcher-failure.md",
  description: "No market's book stays crossed without being matched",
};

export function evaluateCrossed(books: readonly CrossedBook[], nowMs: number, limitSecs: number): CheckResult[] {
  const r = resultsFor(CROSSED);
  const out: CheckResult[] = [];
  for (const b of books) {
    const secs = (nowMs - b.crossedSince.getTime()) / 1000;
    const values = { crossedSecs: Math.round(secs), bestBid: toFloat18(b.bestBid), bestAsk: toFloat18(b.bestAsk) };
    const subject = `market-${b.marketId}`;
    const detail = `market ${b.marketId} crossed for ${fmtSecs(secs)} (bid ${toFloat18(b.bestBid)} ≥ ask ${toFloat18(b.bestAsk)})`;
    out.push(secs > limitSecs ? r.fail(`${detail}: the matcher is not matching it`, values, { subject }) : r.pass(detail, values, { subject }));
  }
  if (out.length === 0) out.push(r.pass("no crossed book", { crossedMarkets: 0 }));
  return out;
}

export const REJECTIONS: CheckMeta = {
  id: "matcher.rejections",
  severity: "WARN",
  runbook: "matcher-failure.md",
  description: "Fill rejection rate over a window, by reason",
};

export function evaluateRejections(
  outcomes: { settled: number; rejected: Map<string, number> },
  cfg: MonitorConfig["rejections"]
): CheckResult[] {
  const r = resultsFor(REJECTIONS);
  const rejected = [...outcomes.rejected.values()].reduce((a, b) => a + b, 0);
  const total = outcomes.settled + rejected;
  const rateBps = total === 0 ? 0 : Math.round((rejected * 10_000) / total);
  const byReason = [...outcomes.rejected.entries()].sort((a, b) => b[1] - a[1]);
  const values: Record<string, number> = { rateBps, rejected, settled: outcomes.settled, windowSecs: cfg.windowSecs };
  for (const [reason, n] of byReason) values[`reason.${reason}`] = n;
  const reasons = byReason.map(([k, n]) => `${k} ×${n}`).join(", ");
  if (total < cfg.minSample) {
    return [r.pass(`${rejected}/${total} fills rejected in ${fmtSecs(cfg.windowSecs)} (below the ${cfg.minSample}-fill sample)`, values)];
  }
  if (rateBps > cfg.maxRateBps) {
    return [
      r.fail(
        `${(rateBps / 100).toFixed(1)}% of fills rejected in ${fmtSecs(cfg.windowSecs)} (${rejected}/${total}): ${reasons}. ` +
          `The matcher is sending fills the chain refuses`,
        values
      ),
    ];
  }
  return [r.pass(`${(rateBps / 100).toFixed(1)}% of ${total} fills rejected${reasons ? ` (${reasons})` : ""}`, values)];
}

// ─── settlement ─────────────────────────────────────────────────────────────

export const FILLS: CheckMeta = {
  id: "settlement.fills",
  severity: "PAGE",
  runbook: "settlement-stuck.md",
  description: "No fill stays PENDING past its batch's outcome",
};

/** Waiting on something that will resolve by itself: WARN. The rest will never settle: PAGE. */
const SELF_HEALING: ReadonlySet<PendingFillKind> = new Set(["in-flight", "indexer-lag"]);

export function evaluateFills(fills: readonly PendingFill[], nowMs: number, minAgeSecs: number): CheckResult[] {
  const r = resultsFor(FILLS);
  if (fills.length === 0) return [r.pass(`no fill PENDING for more than ${fmtSecs(minAgeSecs)}`, { pending: 0 })];
  const byKind = new Map<PendingFillKind, PendingFill[]>();
  for (const f of fills) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
  return [...byKind.entries()].map(([kind, fs]) => {
    const oldest = Math.max(...fs.map((f) => (nowMs - f.createdAt.getTime()) / 1000));
    const values = { count: fs.length, oldestSecs: Math.round(oldest) };
    const what: Record<PendingFillKind, string> = {
      "in-flight": "their batch is still open",
      "indexer-lag": "their batch confirmed; the indexer has not caught up",
      "not-in-receipt": "their batch confirmed but neither settled nor rejected them",
      "batch-failed": "their batch reverted or dropped; they will never settle",
      "never-submitted": "no batch was ever sent for them",
    };
    return r.fail(
      `${fs.length} fill(s) PENDING up to ${fmtSecs(oldest)}: ${what[kind]} (e.g. ${fs[0].fillId.slice(0, 18)}…)`,
      values,
      { subject: kind, severity: SELF_HEALING.has(kind) ? "WARN" : "PAGE" }
    );
  });
}

export const TXJOBS: CheckMeta = {
  id: "settlement.txjobs",
  severity: "PAGE",
  runbook: "settlement-stuck.md",
  description: "No transaction stays unreconciled past the threshold, per key",
};

export function evaluateTxJobs(jobs: readonly OpenJob[], nowMs: number, stuckSecs: number): CheckResult[] {
  const r = resultsFor(TXJOBS);
  const old = jobs.filter((j) => (nowMs - j.createdAt.getTime()) / 1000 > stuckSecs);
  if (old.length === 0) return [r.pass(`no transaction open for more than ${fmtSecs(stuckSecs)}`, { open: jobs.length, stuck: 0 })];
  const byKey = new Map<string, OpenJob[]>();
  for (const j of old) byKey.set(`${j.service}:${j.fromAddress}`, [...(byKey.get(`${j.service}:${j.fromAddress}`) ?? []), j]);
  return [...byKey.values()].map((js) => {
    const oldest = js.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
    const age = (nowMs - oldest.createdAt.getTime()) / 1000;
    return r.fail(
      `${js.length} ${oldest.service} transaction(s) unreconciled, oldest ${fmtSecs(age)} ` +
        `(nonce ${oldest.nonce}, "${oldest.label}", ${oldest.status}) from ${oldest.fromAddress}`,
      { stuck: js.length, oldestSecs: Math.round(age), oldestNonce: oldest.nonce },
      { subject: `${oldest.service}:${oldest.fromAddress.slice(0, 10)}` }
    );
  });
}

export const NONCE_GAPS: CheckMeta = {
  id: "settlement.nonce-gap",
  severity: "PAGE",
  runbook: "settlement-stuck.md",
  description: "No signer has a nonce gap below its in-flight transactions",
};

export function evaluateNonceGaps(jobs: readonly OpenJob[], minedNonces: Map<string, number>): CheckResult[] {
  const r = resultsFor(NONCE_GAPS);
  const byKey = new Map<string, OpenJob[]>();
  for (const j of jobs) byKey.set(j.fromAddress, [...(byKey.get(j.fromAddress) ?? []), j]);
  const out: CheckResult[] = [];
  for (const [address, js] of byKey) {
    const mined = minedNonces.get(address);
    if (mined === undefined) continue;
    const gaps = detectNonceGaps(mined, js.map((j) => j.nonce));
    if (gaps.length === 0) continue;
    out.push(
      r.fail(
        `${js[0].service} key ${address} has nonce gap(s) at ${gaps.slice(0, 10).join(", ")}${gaps.length > 10 ? "…" : ""}: ` +
          `nothing it sends will mine until they are filled`,
        { gaps: gaps.length, minedNonce: mined, blocked: js.filter((j) => j.nonce > gaps[0]).length },
        { subject: `${js[0].service}:${address.slice(0, 10)}` }
      )
    );
  }
  if (out.length === 0) out.push(r.pass(`no nonce gaps across ${byKey.size} key(s) with open jobs`, { keys: byKey.size }));
  return out;
}

// ─── funding ────────────────────────────────────────────────────────────────

export const FUNDING: CheckMeta = {
  id: "funding.freshness",
  severity: "PAGE",
  runbook: "funding-stale.md",
  description: "Every active market's funding was updated within the hour",
};

/**
 * Judged on `Engine.fundingState().lastUpdate`, not on an indexed event: a
 * market's funding clock can start without a `FundingUpdated` log (the first
 * trade sets it), so a DB-only view reports "never updated" for a market that
 * is perfectly current. The indexed row is carried alongside as a cross-check,
 * which is also how an indexer that is missing updates becomes visible.
 *
 * The Engine accrues at most one hour per `updateFunding`, so anything past
 * that hour is funding that will never be charged.
 */
export function evaluateFunding(
  markets: readonly MarketState[],
  indexed: ReadonlyMap<number, Date | null>,
  chainNow: number,
  staleSecs: number
): CheckResult[] {
  const r = resultsFor(FUNDING);
  const out: CheckResult[] = [];
  for (const m of markets) {
    if (!m.active || !m.listed) continue;
    const subject = m.symbol;
    const indexedAt = indexed.get(m.marketId) ?? null;
    const indexedAgeSecs = indexedAt === null ? null : chainNow - Math.floor(indexedAt.getTime() / 1000);
    if (m.fundingLastUpdate === 0) {
      // The clock starts at the first trade. With no open interest there is
      // nothing to charge and nothing to lose, which is the normal state of a
      // freshly listed market — paging for it would page every new venue at
      // the moment it opens. With open interest, funding is genuinely not
      // accruing and someone is being short-changed.
      const oi = m.longOi + m.shortOi;
      const values = { ageSecs: null, indexedAgeSecs };
      out.push(
        oi === 0n
          ? r.skip(`${subject}: never traded, so funding has not started (no open interest)`, values, { subject })
          : r.fail(`${subject}: funding has never been initialised on chain, but the market holds open interest`, values, { subject })
      );
      continue;
    }
    const age = chainNow - m.fundingLastUpdate;
    const values = { ageSecs: age, thresholdSecs: staleSecs, indexedAgeSecs };
    if (age > staleSecs) {
      out.push(
        r.fail(
          `${subject}: funding last updated ${fmtSecs(age)} ago; the Engine accrues at most 1h per update, so funding is being lost`,
          values,
          { subject }
        )
      );
      continue;
    }
    out.push(r.pass(`${subject}: funding updated ${fmtSecs(age)} ago`, values, { subject }));
  }
  return orNothingToCheck(out, FUNDING, "no active market to check");
}

// ─── liquidation ────────────────────────────────────────────────────────────

export const LIQUIDATION: CheckMeta = {
  id: "liquidation.backlog",
  severity: "PAGE",
  runbook: "liquidation-backlog.md",
  description: "No account stays below maintenance margin, or blocked on a stale price",
};

export function evaluateLiquidation(health: Map<Address, AccountHealth | null>): CheckResult[] {
  const r = resultsFor(LIQUIDATION);
  const liquidatable: { trader: Address; shortfall: bigint }[] = [];
  const blocked: Address[] = [];
  for (const [trader, h] of health) {
    if (h === null) blocked.push(trader);
    else if (h.liquidatable) liquidatable.push({ trader, shortfall: h.maintenanceMarginRequired - h.equity });
  }
  liquidatable.sort((a, b) => (a.shortfall > b.shortfall ? -1 : a.shortfall < b.shortfall ? 1 : 0));
  const worst = liquidatable[0]?.shortfall ?? 0n;
  const values = { accounts: health.size, liquidatable: liquidatable.length, blocked: blocked.length, worstShortfallUsd: toFloat18(worst) };
  const parts: string[] = [];
  if (liquidatable.length) {
    parts.push(
      `${liquidatable.length} account(s) below maintenance margin (worst ${liquidatable[0].trader}, short ${usd18(worst)})`
    );
  }
  if (blocked.length) parts.push(`${blocked.length} account(s) blocked on a stale price (e.g. ${blocked[0]})`);
  if (parts.length) return [r.fail(`${parts.join("; ")}: the liquidation keeper is not clearing them`, values)];
  return [r.pass(`${health.size} account(s) with positions, all above maintenance`, values)];
}

// ─── signer gas ─────────────────────────────────────────────────────────────

export const GAS: CheckMeta = {
  id: "gas.balance",
  severity: "PAGE",
  runbook: "signer-gas.md",
  description: "Every service key can pay for its next transaction (USDC is gas)",
};

export function evaluateGas(
  targets: readonly GasTarget[],
  balances: Map<string, bigint>,
  nextTxCost: Map<string, bigint>,
  cfg: MonitorConfig["gas"]
): CheckResult[] {
  const r = resultsFor(GAS);
  if (targets.length === 0) {
    return [
      r.fail("no service keys configured to watch (MONITOR_GAS_TARGETS or REFILL_TARGETS): an empty key would go unnoticed", {}, { severity: "WARN" }),
    ];
  }
  const out: CheckResult[] = [];
  for (const t of targets) {
    const a = t.address.toLowerCase();
    const bal = balances.get(a) ?? 0n;
    const next = nextTxCost.get(a) ?? 0n;
    const pageAt = next > cfg.pageBelow ? next : cfg.pageBelow;
    const values = { balanceUsd: toFloat18(bal), pageBelowUsd: toFloat18(pageAt), warnBelowUsd: toFloat18(cfg.warnBelow), nextTxMaxCostUsd: toFloat18(next) };
    const subject = t.name;
    if (bal < pageAt) {
      out.push(
        r.fail(`${t.name} (${t.address}) has ${usd18(bal)} gas: below ${usd18(pageAt)}, its next transaction can fail`, values, { subject })
      );
    } else if (bal < cfg.warnBelow) {
      out.push(
        r.fail(`${t.name} has ${usd18(bal)} gas, under the refill floor ${usd18(cfg.warnBelow)}: keeper-refill has not topped it up`, values, {
          subject,
          severity: "WARN",
        })
      );
    } else {
      out.push(r.pass(`${t.name} ${usd18(bal)}`, values, { subject }));
    }
  }
  return out;
}

export const FUNDER: CheckMeta = {
  id: "gas.funder",
  severity: "WARN",
  runbook: "signer-gas.md",
  description: "The keeper-refill funder holds enough to keep topping up",
};

export function evaluateFunder(address: Address | null, balance: bigint | null, warnBelow: bigint): CheckResult[] {
  const r = resultsFor(FUNDER);
  if (!address) return [r.skip("MONITOR_REFILL_FUNDER_ADDRESS not set")];
  const values = { balanceUsd: toFloat18(balance ?? 0n), warnBelowUsd: toFloat18(warnBelow) };
  if ((balance ?? 0n) < warnBelow) {
    return [r.fail(`refill funder ${address} has ${usd18(balance ?? 0n)} (< ${usd18(warnBelow)}): top-ups will stop`, values)];
  }
  return [r.pass(`refill funder ${usd18(balance ?? 0n)}`, values)];
}

// ─── the checks ─────────────────────────────────────────────────────────────

async function openJobs(c: CheckContext) {
  return c.once("openJobs", () => c.store.openJobs());
}

export const keeperChecks: Check[] = [
  {
    ...INDEXER,
    threshold: (cfg) => `cursor > ${cfg.indexer.lagSecs}s or > ${cfg.indexer.lagBlocks} blocks behind head`,
    run: async (c) => {
      const [cursor, head] = await Promise.all([c.store.cursor(CURSOR_STREAM), reads.head(c)]);
      const behind = cursor !== null && head.number > cursor.blockNumber;
      const cursorTime = behind ? await c.chain.blockTimestamp(cursor.blockNumber) : null;
      return evaluateIndexer(cursor, head, cursorTime, c.cfg.indexer);
    },
  },
  {
    ...CROSSED,
    threshold: (cfg) => `book crossed > ${cfg.matcher.crossedBookSecs}s`,
    run: async (c) =>
      evaluateCrossed(await c.store.crossedBooks(Math.floor(c.now() / 1000)), c.now(), c.cfg.matcher.crossedBookSecs),
  },
  {
    ...FILLS,
    threshold: (cfg) => `PENDING > ${cfg.matcher.pendingFillSecs}s; WARN if self-healing, PAGE if it will never settle`,
    run: async (c) =>
      evaluateFills(
        await c.store.pendingFills(new Date(c.now() - c.cfg.matcher.pendingFillSecs * 1000)),
        c.now(),
        c.cfg.matcher.pendingFillSecs
      ),
  },
  {
    ...TXJOBS,
    threshold: (cfg) => `TxJob open > ${cfg.txJobStuckSecs}s, per key`,
    run: async (c) => evaluateTxJobs(await openJobs(c), c.now(), c.cfg.txJobStuckSecs),
  },
  {
    ...NONCE_GAPS,
    threshold: () => "any unfilled nonce below an open job, per key",
    run: async (c) => {
      const jobs = await openJobs(c);
      const keys = [...new Set(jobs.map((j) => j.fromAddress))] as Address[];
      return evaluateNonceGaps(jobs, await c.chain.nonces(keys));
    },
  },
  {
    ...REJECTIONS,
    threshold: (cfg) =>
      `rejected > ${cfg.rejections.maxRateBps / 100}% over ${cfg.rejections.windowSecs}s (min ${cfg.rejections.minSample} fills)`,
    run: async (c) =>
      evaluateRejections(await c.store.fillOutcomes(new Date(c.now() - c.cfg.rejections.windowSecs * 1000)), c.cfg.rejections),
  },
  {
    ...FUNDING,
    threshold: (cfg) => `fundingState.lastUpdate > ${cfg.fundingStaleSecs}s ago (chain time), per market`,
    run: async (c) => {
      const [markets, head, indexed] = await Promise.all([reads.markets(c), reads.head(c), c.store.funding()]);
      return evaluateFunding(markets, new Map(indexed.map((i) => [i.marketId, i.lastAt])), head.timestamp, c.cfg.fundingStaleSecs);
    },
  },
  {
    ...LIQUIDATION,
    threshold: () => "any account liquidatable or unpriceable for N ticks",
    run: async (c) => {
      const holders = await c.store.positionHolders(c.contracts.insurance);
      return evaluateLiquidation(await c.chain.accountHealth(holders, c.cfg.liquidationBatch));
    },
  },
  {
    ...GAS,
    threshold: (cfg) =>
      `PAGE < max(${usd18(cfg.gas.pageBelow)}, next-tx max cost); WARN < ${usd18(cfg.gas.warnBelow)} (refill floor)`,
    run: async (c) => {
      const addrs = c.cfg.gas.targets.map((t) => t.address);
      const [balances, costs] = await Promise.all([c.chain.balances(addrs), c.store.nextTxCost(addrs)]);
      return evaluateGas(c.cfg.gas.targets, balances, costs, c.cfg.gas);
    },
  },
  {
    ...FUNDER,
    threshold: (cfg) => `funder < ${usd18(cfg.gas.funderWarnBelow)}`,
    run: async (c) => {
      const f = c.cfg.gas.funder;
      const bal = f ? (await c.chain.balances([f])).get(f.toLowerCase()) ?? 0n : null;
      return evaluateFunder(f, bal, c.cfg.gas.funderWarnBelow);
    },
  },
];
