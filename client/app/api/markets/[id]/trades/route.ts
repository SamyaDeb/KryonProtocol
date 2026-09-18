import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { listTrades } from "@/lib/queries/fills";
import { formatFixed, parseLimit, parseMarketId } from "@/lib/queries/scalars";

/**
 * GET /api/markets/:id/trades?limit=50 — recent prints, newest first.
 *
 * SETTLED fills only: a PENDING fill can still be rejected by the gateway, and
 * a print that later un-happens is worse than one that arrives a block late.
 * `side` is the taker's direction (`takerIsBuy`), which is what makes a print
 * a buy or a sell. Price and size are display decimals, 1e18-based.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = parseMarketId((await params).id);
  if (marketId === null) return NextResponse.json([], { status: 400 });
  const limit = parseLimit(req.nextUrl.searchParams.get("limit"), 50, 200);
  if (limit === null) return NextResponse.json({ error: "invalid_limit" }, { status: 400 });

  const network = networkFromRequest(req);
  try {
    const fills = await listTrades(db(network), network, marketId, limit);
    const trades = fills.map((f) => ({
      price: formatFixed(f.price),
      size: formatFixed(f.size),
      side: (f.takerIsBuy ? "buy" : "sell") as "buy" | "sell",
      timestamp: f.createdAt.getTime(),
      fill_id: f.fillId,
      tx_hash: f.txHash,
    }));
    return NextResponse.json(trades, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("trades error:", e);
    return NextResponse.json([], { status: 500 });
  }
}
