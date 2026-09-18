import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { listCandles } from "@/lib/queries/fills";
import { parseLimit, parseMarketId, toFloat } from "@/lib/queries/scalars";

/**
 * GET /api/markets/:id/candles?tf=3600&limit=600 — OHLCV over SETTLED fills,
 * oldest first (what the chart wants). `tf` is the bucket width in seconds,
 * at least 60.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = parseMarketId((await params).id);
  if (marketId === null) return NextResponse.json([], { status: 400 });

  const sp = req.nextUrl.searchParams;
  const tfRaw = sp.get("tf");
  const tf = tfRaw === null ? 3600 : Number(tfRaw);
  if (!Number.isInteger(tf) || tf < 60 || tf > 7 * 24 * 3600) {
    return NextResponse.json({ error: "invalid_tf" }, { status: 400 });
  }
  const limit = parseLimit(sp.get("limit"), 600, 1000);
  if (limit === null) return NextResponse.json({ error: "invalid_limit" }, { status: 400 });

  const network = networkFromRequest(req);
  try {
    const candles = await listCandles(db(network), network, marketId, tf, limit);
    return NextResponse.json(
      candles.map((c) => ({
        time: c.time,
        open: toFloat(c.open),
        high: toFloat(c.high),
        low: toFloat(c.low),
        close: toFloat(c.close),
        volume: toFloat(c.volume),
      })),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("candles error:", e);
    return NextResponse.json([], { status: 500 });
  }
}
