import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const marketId = parseInt(id, 10);
  if (!marketId) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  try {
    const sql = db(networkFromRequest(req));
    const rows = await sql`
      SELECT
        id AS market_id,
        symbol,
        "lastPrice"      AS last_price,
        "volume"         AS volume,
        "longOpenInterest"  AS long_open_interest,
        "shortOpenInterest" AS short_open_interest,
        "fundingLongIndex"  AS funding_long_index,
        "fundingShortIndex" AS funding_short_index,
        "lastOraclePrice"   AS last_oracle_price,
        active
      FROM "Market"
      WHERE id = ${marketId}
    `;

    if (!rows[0]) {
      return NextResponse.json({ error: "market_not_found" }, { status: 404 });
    }

    return NextResponse.json(rows[0], {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "market_unavailable" }, { status: 500 });
  }
}
