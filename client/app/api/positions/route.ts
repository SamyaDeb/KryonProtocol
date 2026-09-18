import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { listOpenPositions } from "@/lib/queries/positions";
import { parseAddress, parseMarketId } from "@/lib/queries/scalars";
import { rateLimit, requestKey } from "@/lib/rate-limit";

/**
 * GET /api/positions?address=0x…&market_id=1 — an account's open positions.
 *
 * The cheap read a bot polls every loop: one table, one index. Values are raw
 * 1e18 strings, the same scale as the signed order, so a bot can reconcile a
 * position against its orders without converting.
 *
 * Arc accounts are cross-margined: one signed position per market, so there is
 * no position id, per-position margin or mode. `size` is negative for a short;
 * `is_long` is provided for convenience. `entry_price` is |open_notional| /
 * |size|.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const address = parseAddress(sp.get("address"));
  if (!address) return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  if (!(await rateLimit(requestKey(req, address), 120))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const marketRaw = sp.get("market_id");
  const marketId = marketRaw === null ? null : parseMarketId(marketRaw);
  if (marketRaw !== null && marketId === null) {
    return NextResponse.json({ error: "invalid_market_id" }, { status: 400 });
  }

  const network = networkFromRequest(req);
  try {
    const rows = await listOpenPositions(db(network), network, address, marketId);
    const positions = rows.map((p) => ({
      market_id: p.marketId,
      is_long: p.size > 0n,
      size: p.size.toString(),
      open_notional: p.openNotional.toString(),
      entry_price: p.entryPrice.toString(),
      last_price: p.lastPrice.toString(),
      realized_pnl_cum: p.realizedPnlCum.toString(),
      updated_at: p.updatedAt.getTime(),
    }));
    return NextResponse.json(
      { address, count: positions.length, positions },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("positions error:", e);
    return NextResponse.json({ error: "positions_unavailable" }, { status: 500 });
  }
}
