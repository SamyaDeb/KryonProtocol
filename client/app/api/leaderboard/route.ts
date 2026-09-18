import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkAwareCacheControl, networkFromRequest } from "@/lib/network-server";
import {
  getLeaderboard,
  LEADERBOARD_METRICS,
  STATS_PERIODS,
  type LeaderboardMetric,
  type StatsPeriod,
} from "@/lib/queries/leaderboard";
import { toFloat } from "@/lib/queries/scalars";

/** `TraderStat` is analytics scale: 1e6 USDC. */
const usd6 = (v: bigint) => toFloat(v, 6);

// GET /api/leaderboard?period=MONTH&metric=pnl&limit=50&offset=0&search=0x…
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const periodRaw = (sp.get("period") ?? "MONTH").toUpperCase();
  const period: StatsPeriod = (STATS_PERIODS as readonly string[]).includes(periodRaw)
    ? (periodRaw as StatsPeriod)
    : "MONTH";
  const metricRaw = (sp.get("metric") ?? "pnl").toLowerCase();
  const metric: LeaderboardMetric = metricRaw in LEADERBOARD_METRICS ? (metricRaw as LeaderboardMetric) : "pnl";
  const limit = Math.min(Math.max(parseInt(sp.get("limit") ?? "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(sp.get("offset") ?? "0", 10) || 0, 0);
  const search = sp.get("search")?.trim().slice(0, 42) || null;

  const network = networkFromRequest(req);
  try {
    const page = await getLeaderboard(db(network), network, { period, metric, limit, offset, search });
    return NextResponse.json(
      {
        period,
        metric,
        total: page.total,
        limit,
        offset,
        traders: page.traders.map((t) => ({
          rank: t.rank,
          address: t.address,
          pnl: usd6(t.realizedPnl),
          volume: usd6(t.volume),
          roi: t.roi,
          winRate: t.winRate,
          tradeCount: t.tradeCount,
          liquidations: t.liquidationCount,
          accountValue: usd6(t.peakEquity),
        })),
      },
      { headers: { "Cache-Control": networkAwareCacheControl(req, "s-maxage=10, stale-while-revalidate=30") } }
    );
  } catch (e) {
    console.error("leaderboard error:", e);
    return NextResponse.json(
      { period, metric, total: 0, limit, offset, traders: [], error: "leaderboard_unavailable" },
      { status: 500 }
    );
  }
}
