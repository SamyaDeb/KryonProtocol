import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkAwareCacheControl, networkFromRequest } from "@/lib/network-server";

const VALID_PERIODS = ["DAY", "WEEK", "MONTH", "ALL"] as const;
const VALID_METRICS: Record<string, string> = {
  pnl: '"realizedPnl"',
  volume: "volume",
  roi: "roi",
};
const AMOUNT_SCALE = 1e7;

// GET /api/leaderboard?period=MONTH&metric=pnl&limit=50&offset=0&search=G...
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const periodRaw = (sp.get("period") ?? "MONTH").toUpperCase();
  const period = (VALID_PERIODS as readonly string[]).includes(periodRaw) ? periodRaw : "MONTH";
  const metric = (sp.get("metric") ?? "pnl").toLowerCase();
  const orderCol = VALID_METRICS[metric] ?? VALID_METRICS.pnl;
  const limit = Math.min(parseInt(sp.get("limit") ?? "50", 10) || 50, 200);
  const offset = Math.max(parseInt(sp.get("offset") ?? "0", 10) || 0, 0);
  const search = sp.get("search")?.trim();

  try {
    const network = networkFromRequest(req);
    const sql = db(network);

    // Total count for pagination
    // Ranked page. orderCol is from a fixed allowlist, so interpolation is safe.
    const query = `
      SELECT address, "realizedPnl", volume, roi, "winRate", "tradeCount",
             "liquidationCount", "peakCollateral",
             RANK() OVER (ORDER BY (${orderCol})::numeric DESC) AS rank
      FROM "TraderStat"
      WHERE network = $1 AND period = $2::"StatsPeriod"
      ${search ? "AND address ILIKE $5" : ""}
      ORDER BY (${orderCol})::numeric DESC
      LIMIT $3 OFFSET $4
    `;
    const params = search ? [network, period, limit, offset, "%" + search + "%"] : [network, period, limit, offset];

    // Count + page in parallel (independent queries → one round-trip latency).
    const [countRows, rows] = await Promise.all([
      search
        ? sql`SELECT COUNT(*)::int AS c FROM "TraderStat" WHERE network = ${network} AND period = ${period}::"StatsPeriod" AND address ILIKE ${"%" + search + "%"}`
        : sql`SELECT COUNT(*)::int AS c FROM "TraderStat" WHERE network = ${network} AND period = ${period}::"StatsPeriod"`,
      sql.query(query, params),
    ]);
    const total = Number((countRows as Record<string, unknown>[])[0]?.c ?? 0);

    const data = (rows as Record<string, unknown>[]).map((r) => ({
      rank: Number(r.rank),
      address: r.address as string,
      pnl: Number(r.realizedPnl) / AMOUNT_SCALE,
      volume: Number(r.volume) / AMOUNT_SCALE,
      roi: Number(r.roi),
      winRate: Number(r.winRate),
      tradeCount: Number(r.tradeCount),
      liquidations: Number(r.liquidationCount),
      accountValue: Number(r.peakCollateral) / AMOUNT_SCALE,
    }));

    return NextResponse.json(
      { period, metric, total, limit, offset, traders: data },
      { headers: { "Cache-Control": networkAwareCacheControl(req, "s-maxage=10, stale-while-revalidate=30") } }
    );
  } catch {
    return NextResponse.json(
      { period, metric, total: 0, limit, offset, traders: [], error: "leaderboard_unavailable" },
      { status: 500 }
    );
  }
}
