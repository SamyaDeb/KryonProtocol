import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";

// Build OHLCV candles by bucketing fills into time windows.
// Returns newest-first to match frontend expectations.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const marketId = parseInt(id, 10);
  if (!marketId) return NextResponse.json([], { status: 400 });

  const tf = Math.max(60, parseInt(req.nextUrl.searchParams.get("tf") ?? "3600", 10));
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "600", 10), 1000);

  try {
    const sql = db(networkFromRequest(req));

    // Each fill becomes an OHLCV bucket. For sparse data, each fill is its own candle.
    // For real volume: aggregate fills within the same tf window.
    const rows = await sql`
      WITH bucketed AS (
        SELECT
          (floor(extract(epoch FROM "createdAt") / ${tf})::bigint * ${tf}) AS time,
          "fillPrice"::numeric  AS price,
          "fillSize"::numeric   AS size,
          "createdAt"
        FROM "Fill"
        WHERE "marketId" = ${marketId}
        ORDER BY "createdAt" ASC
      ),
      agg AS (
        SELECT
          time,
          (array_agg(price ORDER BY "createdAt" ASC))[1]  AS open,
          max(price)                                        AS high,
          min(price)                                        AS low,
          (array_agg(price ORDER BY "createdAt" DESC))[1]  AS close,
          sum(size)                                         AS volume
        FROM bucketed
        GROUP BY time
      )
      SELECT * FROM agg
      ORDER BY time DESC
      LIMIT ${limit}
    `;

    const PRICE_SCALE = 1e18;
    const AMOUNT_SCALE = 1e7;
    const candles = rows.map((r) => ({
      time: Number(r.time),
      open:   Number(r.open)   / PRICE_SCALE,
      high:   Number(r.high)   / PRICE_SCALE,
      low:    Number(r.low)    / PRICE_SCALE,
      close:  Number(r.close)  / PRICE_SCALE,
      volume: Number(r.volume) / AMOUNT_SCALE,
    })).reverse(); // oldest first for the chart

    return NextResponse.json(candles, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json([], { status: 500 });
  }
}
