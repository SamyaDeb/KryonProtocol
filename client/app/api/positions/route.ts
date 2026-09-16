import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { rateLimit, requestKey } from "@/lib/rate-limit";

/**
 * GET /api/positions?address=G…&market_id=1
 *
 * An account's open positions, as indexed from the engine contract.
 *
 * `/api/portfolio/:address` already exposes positions, but it joins five
 * analytics tables to build an equity curve and a PnL history. A bot checking
 * its exposure on every loop should not pay for that, and at 120 requests a
 * minute it cannot afford to. This is the cheap read: one table, one index.
 *
 * Values are raw fixed-point (price 1e18, size 1e7), matching the order
 * intake payload rather than the pre-scaled analytics routes, so a bot can
 * compare a position against the orders it signed without converting twice.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const address = params.get("address");

  if (!address || !StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }
  if (!(await rateLimit(requestKey(req, address), 120))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const marketIdRaw = params.get("market_id");
  const marketId = marketIdRaw === null ? null : Number(marketIdRaw);
  if (marketId !== null && !Number.isInteger(marketId)) {
    return NextResponse.json({ error: "invalid_market_id" }, { status: 400 });
  }

  try {
    const sql = db(networkFromRequest(req));

    const rows =
      marketId === null
        ? await sql`
            SELECT "positionId", "marketId", size, "entryPrice", margin,
                   "isLong", "lastFundingIndex", mode, "updatedAt"
            FROM "Position"
            WHERE owner = ${address} AND size::numeric <> 0
            ORDER BY "marketId" ASC
          `
        : await sql`
            SELECT "positionId", "marketId", size, "entryPrice", margin,
                   "isLong", "lastFundingIndex", mode, "updatedAt"
            FROM "Position"
            WHERE owner = ${address}
              AND "marketId" = ${marketId}
              AND size::numeric <> 0
            ORDER BY "marketId" ASC
          `;

    const positions = rows.map((r) => ({
      position_id: String(r.positionId),
      market_id: Number(r.marketId),
      is_long: Boolean(r.isLong),
      size: String(r.size),
      entry_price: String(r.entryPrice),
      margin: String(r.margin),
      last_funding_index: String(r.lastFundingIndex),
      mode: String(r.mode),
      updated_at: new Date(r.updatedAt as string).getTime(),
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
