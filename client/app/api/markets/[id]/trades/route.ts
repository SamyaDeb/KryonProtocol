import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";

// Prices are stored in 1e18 precision (PRICE_PRECISION).
// Sizes are stored in 1e7 precision (AMOUNT_PRECISION) for real fills,
// or 1e18 for legacy E2E test data — we normalise both to floats here.
const PRICE_SCALE = 1e18;
const AMOUNT_SCALE = 1e7;

function normaliseSize(rawSize: string | number): number {
  const n = Number(rawSize);
  // Heuristic: real amounts (1e7 precision) are < 1e12 for normal trade sizes.
  // E2E test data uses 1e18, so anything ≥ 1e12 is treated as 1e18-scaled.
  return n >= 1e12 ? n / PRICE_SCALE : n / AMOUNT_SCALE;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const marketId = parseInt(id, 10);
  if (!marketId) return NextResponse.json([], { status: 400 });

  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10), 200);

  try {
    const sql = db(networkFromRequest(req));
    // Side is the TAKER's direction — the aggressor is what makes a print a buy
    // or a sell — joined from the taker's own order row. `Order` is unique on
    // (owner, nonce), so this is exact. It replaces `makerNonce % 2`, which was
    // a coin flip on a nonce and mislabelled roughly half of every print.
    const rows = await sql`
      SELECT
        f."fillPrice"::text AS fill_price,
        f."fillSize"::text  AS fill_size,
        f."createdAt"       AS ts,
        ot."isLong"         AS taker_is_long
      FROM "Fill" f
      LEFT JOIN "Order" ot ON ot.owner = f.taker AND ot.nonce = f."takerNonce"
      WHERE f."marketId" = ${marketId}
      ORDER BY f."createdAt" DESC, f.id DESC
      LIMIT ${limit}
    `;

    const trades = rows.map((r) => ({
      price: (Number(r.fill_price) / PRICE_SCALE).toFixed(4),
      size:  normaliseSize(r.fill_size).toFixed(4),
      // null when the taker's order row has been pruned — callers render no
      // side rather than an invented one.
      side:  r.taker_is_long === null || r.taker_is_long === undefined
        ? null
        : ((r.taker_is_long ? "buy" : "sell") as "buy" | "sell"),
      timestamp: new Date(r.ts).getTime(),
    }));

    return NextResponse.json(trades, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json([], { status: 500 });
  }
}
