import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { marketVolumes } from "@/lib/queries/fills";
import { marketToJson } from "@/lib/queries/json";
import { getMarketById } from "@/lib/queries/markets";
import { parseMarketId } from "@/lib/queries/scalars";

/** GET /api/markets/:id — one market, in the same shape as a `/api/markets` entry. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = parseMarketId((await params).id);
  if (marketId === null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const network = networkFromRequest(req);
  try {
    const sql = db(network);
    const [market, volumes] = await Promise.all([
      getMarketById(sql, network, marketId),
      marketVolumes(sql, network, new Date(Date.now() - 24 * 3600 * 1000)),
    ]);
    if (!market) return NextResponse.json({ error: "market_not_found" }, { status: 404 });
    return NextResponse.json(marketToJson(market, volumes.get(marketId)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("market error:", e);
    return NextResponse.json({ error: "market_unavailable" }, { status: 500 });
  }
}
