import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { db } from "@/lib/db";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import { networkFromRequest } from "@/lib/network-server";

const AMOUNT_SCALE = 1e7;

// GET /api/funding?address=G...&limit=50
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address || !StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json([], { status: 400 });
  }
  if (!(await rateLimit(requestKey(req, address), 120))) {
    return NextResponse.json([], { status: 429 });
  }
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10), 100);
  try {
    const network = networkFromRequest(req);
    const sql = db(network);
    const rows = await sql`
      SELECT "marketId", amount, "txHash", "createdAt"
      FROM "FundingPayment"
      WHERE network = ${network} AND address = ${address}
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;
    const payments = rows.map((r) => ({
      marketId:  Number(r.marketId),
      amount:    Number(r.amount) / AMOUNT_SCALE,
      txHash:    String(r.txHash),
      createdAt: new Date(r.createdAt).getTime(),
    }));
    return NextResponse.json(payments, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json([], { status: 500 });
  }
}
