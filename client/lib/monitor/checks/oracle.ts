/**
 * Oracle checks: the ones that block withdrawals.
 *
 * A stale price on a market an account holds blocks that account's trades,
 * its liquidation and its withdrawals. So freshness is judged exactly the way
 * `OracleAdapter._validate` judges it — both `publishTime` and `writeTime`
 * against the block timestamp, bounded by the market's `maxOracleAge` (the
 * value Engine passes to `getPrice`) — and it alerts at a fraction of that
 * bound, while there is still time to act.
 *
 * Every feed is reported by name, one result each. The previous monitor
 * learned why: with eight feeds, one combined "oracle stale" result hides
 * which market is down, and a check that throws on the first stale feed hides
 * the other seven.
 */

import { divergenceBps } from "@/lib/chain/refprice";
import type { FeedState, OracleState } from "@/lib/oracle/publisher";

import type { MarketState } from "../chain";
import type { MonitorConfig } from "../config";
import { reads, type Check } from "../context";
import type { OracleRun } from "../store";
import { fmtSecs, orNothingToCheck, resultsFor, toFloat18, type CheckMeta, type CheckResult } from "../types";

export const FRESHNESS: CheckMeta = {
  id: "oracle.freshness",
  severity: "PAGE",
  runbook: "oracle-failure.md",
  description: "Every feed with open interest is fresh (per feed)",
};
export const QUORUM: CheckMeta = {
  id: "oracle.quorum",
  severity: "WARN",
  runbook: "oracle-failure.md",
  description: "Enough distinct publishers contribute to each feed",
};
export const DIVERGENCE: CheckMeta = {
  id: "oracle.divergence",
  severity: "WARN",
  runbook: "oracle-failure.md",
  description: "Each feed stays inside its Chainlink divergence bound",
};
export const FLATLINE: CheckMeta = {
  id: "oracle.flatline",
  severity: "WARN",
  runbook: "oracle-failure.md",
  description: "A feed's price has moved within a plausible interval",
};

const hasOi = (m: MarketState) => m.longOi !== 0n || m.shortOi !== 0n;

/** Feeds behind active markets, by lowercase feed id. */
function feedsOfActiveMarkets(markets: readonly MarketState[], oracle: OracleState): Map<string, { feed: FeedState; markets: MarketState[] }> {
  const byId = new Map(oracle.feeds.map((f) => [f.id.toLowerCase(), f]));
  const out = new Map<string, { feed: FeedState; markets: MarketState[] }>();
  for (const m of markets) {
    if (!m.active || !m.listed) continue;
    const feed = byId.get(m.oracleId.toLowerCase());
    if (!feed) continue;
    const e = out.get(feed.id.toLowerCase()) ?? { feed, markets: [] };
    e.markets.push(m);
    out.set(feed.id.toLowerCase(), e);
  }
  return out;
}

/** Seconds since the older of publishTime and writeTime: the age `_validate` enforces. */
export function feedAge(feed: FeedState, chainNow: number): number {
  const s = feed.snapshot;
  if (s.writeTime === 0 || s.publishTime === 0) return Number.POSITIVE_INFINITY;
  return chainNow - Math.min(s.publishTime, s.writeTime);
}

export function evaluateFreshness(
  markets: readonly MarketState[],
  oracle: OracleState,
  staleFraction: number
): CheckResult[] {
  const r = resultsFor(FRESHNESS);
  const byId = new Map(oracle.feeds.map((f) => [f.id.toLowerCase(), f]));
  const out: CheckResult[] = [];
  for (const m of markets) {
    if (!m.listed || !m.active) continue;
    const subject = m.symbol;
    if (!hasOi(m)) {
      out.push(r.skip("no open interest", { openInterest: 0 }, { subject }));
      continue;
    }
    const feed = byId.get(m.oracleId.toLowerCase());
    if (!feed) {
      out.push(r.fail(`market ${m.marketId} has open interest but its feed is not listed on the adapter`, {}, { subject }));
      continue;
    }
    const maxAge = m.maxOracleAge > 0 ? m.maxOracleAge : feed.cfg.maxAge;
    const alertAt = Math.max(1, Math.floor(maxAge * staleFraction));
    const age = feedAge(feed, oracle.chainNow);
    const values = {
      ageSecs: Number.isFinite(age) ? age : null,
      maxAgeSecs: maxAge,
      alertAtSecs: alertAt,
      price: toFloat18(feed.snapshot.price),
      openInterest: toFloat18(m.longOi > m.shortOi ? m.longOi : m.shortOi),
    };
    if (age > maxAge) {
      out.push(
        r.fail(
          `${subject} STALE: ${fmtSecs(age)} old, past its ${maxAge}s bound — trading, liquidation and withdrawals are blocked for its holders`,
          values,
          { subject }
        )
      );
    } else if (age > alertAt) {
      out.push(r.fail(`${subject} ${fmtSecs(age)} old, ${maxAge - age}s before it blocks withdrawals (bound ${maxAge}s)`, values, { subject }));
    } else {
      out.push(r.pass(`${subject} ${fmtSecs(age)} old (bound ${maxAge}s)`, values, { subject }));
    }
  }
  if (oracle.paused) {
    out.push(r.fail("the oracle adapter is paused: no feed can update", { paused: true }, { subject: "adapter" }));
  }
  return orNothingToCheck(out, FRESHNESS, "no listed, active market to check");
}

/** Distinct publishers whose observation is still inside the feed's maxAge. */
export function freshPublishers(feed: FeedState, publishers: readonly string[], chainNow: number): number {
  let n = 0;
  for (const p of publishers) {
    const o = feed.observations.get(p.toLowerCase());
    if (o && o.publishTime > 0 && chainNow - o.publishTime <= feed.cfg.maxAge) n += 1;
  }
  return n;
}

export function evaluateQuorum(markets: readonly MarketState[], oracle: OracleState): CheckResult[] {
  const r = resultsFor(QUORUM);
  const out: CheckResult[] = [];
  for (const { feed } of feedsOfActiveMarkets(markets, oracle).values()) {
    const subject = feed.symbol;
    const fresh = freshPublishers(feed, oracle.publishers, oracle.chainNow);
    const values = {
      freshPublishers: fresh,
      minPublishers: feed.cfg.minPublishers,
      registeredPublishers: oracle.publishers.length,
      lastSourceCount: feed.snapshot.sourceCount,
    };
    if (oracle.publishers.length < feed.cfg.minPublishers) {
      out.push(r.fail(`${subject}: only ${oracle.publishers.length} publisher(s) registered, quorum needs ${feed.cfg.minPublishers}`, values, { subject }));
    } else if (fresh < feed.cfg.minPublishers) {
      out.push(r.fail(`${subject}: ${fresh} of ${feed.cfg.minPublishers} required publishers are fresh; the next update will not reach quorum`, values, { subject }));
    } else {
      out.push(r.pass(`${subject}: ${fresh} fresh publisher(s), quorum ${feed.cfg.minPublishers}`, values, { subject }));
    }
  }
  return orNothingToCheck(out, QUORUM, "no active market's feed to check");
}

export function evaluateDivergence(markets: readonly MarketState[], oracle: OracleState, fraction: number): CheckResult[] {
  const r = resultsFor(DIVERGENCE);
  const out: CheckResult[] = [];
  for (const { feed } of feedsOfActiveMarkets(markets, oracle).values()) {
    const subject = feed.symbol;
    const ref = feed.reference;
    if (!ref.enabled) {
      out.push(r.skip("no Chainlink reference feed configured", {}, { subject }));
      continue;
    }
    if (!ref.ok) {
      const detail = `${subject}: the Chainlink reference is unavailable or stale`;
      out.push(
        ref.required
          ? r.fail(`${detail}, and it is required: the feed will halt`, { required: true }, { subject })
          : r.pass(`${detail}; not required, so the guard is off`, { required: false }, { subject })
      );
      continue;
    }
    if (feed.snapshot.price <= 0n) {
      out.push(r.skip("no stored price to compare", {}, { subject }));
      continue;
    }
    const d = divergenceBps(feed.snapshot.price, ref.price);
    const alertAt = Math.floor(ref.maxDivergenceBps * fraction);
    const values = { divergenceBps: d, alertAtBps: alertAt, haltBps: ref.maxDivergenceBps, price: toFloat18(feed.snapshot.price), reference: toFloat18(ref.price) };
    if (d >= alertAt) {
      out.push(r.fail(`${subject} is ${d} bps from Chainlink; the adapter halts at ${ref.maxDivergenceBps} bps`, values, { subject }));
    } else {
      out.push(r.pass(`${subject} ${d} bps from Chainlink (halt at ${ref.maxDivergenceBps})`, values, { subject }));
    }
  }
  return orNothingToCheck(out, DIVERGENCE, "no active market's feed to check");
}

export function evaluateFlatline(
  markets: readonly MarketState[],
  oracle: OracleState,
  runs: readonly OracleRun[],
  flatlineSecs: number
): CheckResult[] {
  const r = resultsFor(FLATLINE);
  const byId = new Map(runs.map((x) => [x.oracleId.toLowerCase(), x]));
  const out: CheckResult[] = [];
  for (const { feed, markets: ms } of feedsOfActiveMarkets(markets, oracle).values()) {
    const subject = feed.symbol;
    if (!ms.some(hasOi)) {
      out.push(r.skip("no open interest", {}, { subject }));
      continue;
    }
    const run = byId.get(feed.id.toLowerCase());
    if (!run || run.updates < 2) {
      out.push(r.pass(`${subject}: not enough indexed updates to judge`, { updates: run?.updates ?? 0 }, { subject }));
      continue;
    }
    const flat = oracle.chainNow - run.flatSince;
    const values = { flatSecs: flat, updates: run.updates, thresholdSecs: flatlineSecs, price: toFloat18(run.price) };
    if (flat > flatlineSecs) {
      out.push(r.fail(`${subject} has published the identical price ${toFloat18(run.price)} ${run.updates} times over ${fmtSecs(flat)}: a stuck source?`, values, { subject }));
    } else {
      out.push(r.pass(`${subject} price moved within ${fmtSecs(flat)}`, values, { subject }));
    }
  }
  return orNothingToCheck(out, FLATLINE, "no active market's feed to check");
}

export const oracleChecks: Check[] = [
  {
    ...FRESHNESS,
    threshold: (cfg: MonitorConfig) => `age > ${cfg.oracle.staleFraction} × maxOracleAge, per feed with OI`,
    run: async (c) => evaluateFreshness(await reads.markets(c), await reads.oracle(c), c.cfg.oracle.staleFraction),
  },
  {
    ...QUORUM,
    threshold: () => "fresh publishers < feed minPublishers",
    run: async (c) => evaluateQuorum(await reads.markets(c), await reads.oracle(c)),
  },
  {
    ...DIVERGENCE,
    threshold: (cfg) => `divergence ≥ ${cfg.oracle.divergenceFraction} × on-chain maxDivergenceBps`,
    run: async (c) => evaluateDivergence(await reads.markets(c), await reads.oracle(c), c.cfg.oracle.divergenceFraction),
  },
  {
    ...FLATLINE,
    threshold: (cfg) => `identical price for > ${cfg.oracle.flatlineSecs}s`,
    run: async (c) =>
      evaluateFlatline(await reads.markets(c), await reads.oracle(c), await c.store.oracleRuns(), c.cfg.oracle.flatlineSecs),
  },
];
