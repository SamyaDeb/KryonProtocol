import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { listFundingPayments } from "@/lib/queries/funding";
import { parseAddress, parseLimit, toFloat } from "@/lib/queries/scalars";
import { rateLimit, requestKey } from "@/lib/rate-limit";

/**
 * GET /api/funding?address=0x…&limit=50 — funding payments, newest first.
 * `amount` is USDC as a float, positive when the account received funding;
 * `amountRaw` is the exact 1e18 value.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const address = parseAddress(sp.get("address"));
  if (!address) return NextResponse.json([], { status: 400 });
  if (!(await rateLimit(requestKey(req, address), 120))) {
    return NextResponse.json([], { status: 429 });
  }
  const limit = parseLimit(sp.get("limit"), 50, 100);
  if (limit === null) return NextResponse.json({ error: "invalid_limit" }, { status: 400 });

  const network = networkFromRequest(req);
  try {
    const payments = await listFundingPayments(db(network), network, address, limit);
    return NextResponse.json(
      payments.map((p) => ({
        marketId: p.marketId,
        amount: toFloat(p.amount),
        amountRaw: p.amount.toString(),
        txHash: p.txHash,
        createdAt: p.createdAt.getTime(),
      })),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("funding error:", e);
    return NextResponse.json([], { status: 500 });
  }
}
