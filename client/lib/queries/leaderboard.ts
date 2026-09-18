/**
 * Typed read helpers for `TraderStat`, the leaderboard rollup. All money
 * columns are 1e6 USDC (analytics scale), not 1e18.
 *
 * Server-side only.
 */

import type { ArcNetworkId } from "@/lib/network";
import type { Queryable } from "./client";
import { big } from "./scalars";

export const STATS_PERIODS = ["DAY", "WEEK", "MONTH", "ALL"] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

/**
 * Sort keys. The value is spliced into ORDER BY, so it must only ever come
 * from this table — never from the request.
 */
export const LEADERBOARD_METRICS = {
  pnl: `"realizedPnl"`,
  volume: `"volume"`,
  roi: `"roi"`,
} as const;
export type LeaderboardMetric = keyof typeof LEADERBOARD_METRICS;

export interface TraderStatView {
  rank: number;
  address: string;
  /** 1e6, signed. */
  realizedPnl: bigint;
  /** 1e6. */
  volume: bigint;
  roi: number;
  winRate: number;
  tradeCount: number;
  liquidationCount: number;
  /** 1e6: the ROI denominator. */
  peakEquity: bigint;
}

export interface LeaderboardPage {
  total: number;
  traders: TraderStatView[];
}

export async function getLeaderboard(
  q: Queryable,
  network: ArcNetworkId,
  opts: { period: StatsPeriod; metric: LeaderboardMetric; limit: number; offset: number; search: string | null }
): Promise<LeaderboardPage> {
  const orderCol = LEADERBOARD_METRICS[opts.metric];
  // Search matches a lowercase address prefix or substring; addresses are
  // stored lowercase, so lowering the needle makes a checksummed paste match.
  const needle = opts.search ? `%${opts.search.toLowerCase().replace(/[%_\\]/g, "\\$&")}%` : null;
  const [countRows, rows] = await Promise.all([
    q.query(
      `SELECT COUNT(*)::int AS c FROM "TraderStat"
       WHERE "network" = $1 AND "period" = $2::"StatsPeriod" AND ($3::text IS NULL OR "address" LIKE $3)`,
      [network, opts.period, needle]
    ),
    // Rank over the whole period, then filter: a search must return each
    // trader's real rank, not their position within the search results.
    q.query(
      `SELECT * FROM (
         SELECT "address", "realizedPnl"::text AS "realizedPnl", "volume"::text AS "volume",
                "roi"::text AS "roi", "winRate"::text AS "winRate", "tradeCount",
                "liquidationCount", "peakEquity"::text AS "peakEquity",
                RANK() OVER (ORDER BY ${orderCol} DESC) AS "rank"
         FROM "TraderStat"
         WHERE "network" = $1 AND "period" = $2::"StatsPeriod"
       ) ranked
       WHERE ($3::text IS NULL OR "address" LIKE $3)
       ORDER BY "rank" ASC, "address" ASC
       LIMIT $4 OFFSET $5`,
      [network, opts.period, needle, opts.limit, opts.offset]
    ),
  ]);
  return {
    total: Number(countRows[0]?.c ?? 0),
    traders: rows.map((r) => ({
      rank: Number(r.rank),
      address: String(r.address),
      realizedPnl: big(r.realizedPnl),
      volume: big(r.volume),
      roi: Number(r.roi),
      winRate: Number(r.winRate),
      tradeCount: Number(r.tradeCount),
      liquidationCount: Number(r.liquidationCount),
      peakEquity: big(r.peakEquity),
    })),
  };
}
