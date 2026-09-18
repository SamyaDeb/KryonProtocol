import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { listFillsForAccount } from "@/lib/queries/fills";
import { formatFixed, parseAddress, parseLimit } from "@/lib/queries/scalars";
import { rateLimit, requestKey } from "@/lib/rate-limit";

/**
 * GET /api/fills?address=0x…&since=<unix-ms>&limit=20 — an account's fills on
 * either side, newest first, default window 24h.
 *
 * Every status is returned and labelled. A PENDING fill has been matched but
 * not settled: the gateway may still reject it, it has no `txHash`, and the UI
 * must not present it as a trade that happened. `rejectReason` is set once the
 * chain has refused the fill, sometimes before the status catches up.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const address = parseAddress(sp.get("address"));
  if (!address) return NextResponse.json([], { status: 400 });
  if (!(await rateLimit(requestKey(req, address), 120))) {
    return NextResponse.json([], { status: 429 });
  }

  const limit = parseLimit(sp.get("limit"), 20, 50);
  if (limit === null) return NextResponse.json({ error: "invalid_limit" }, { status: 400 });
  const sinceRaw = sp.get("since");
  const sinceMs = sinceRaw === null ? Date.now() - 24 * 3600 * 1000 : Number(sinceRaw);
  if (!Number.isFinite(sinceMs)) return NextResponse.json({ error: "invalid_since" }, { status: 400 });

  const network = networkFromRequest(req);
  try {
    const fills = await listFillsForAccount(db(network), network, address, new Date(sinceMs), limit);
    return NextResponse.json(
      fills.map((f) => {
        const isMaker = f.maker === address;
        return {
          id: f.fillId,
          status: f.status,
          rejectReason: f.rejectReason,
          marketId: f.marketId,
          isMaker,
          // This account's direction in the fill.
          side: (isMaker ? !f.takerIsBuy : f.takerIsBuy) ? "buy" : "sell",
          price: formatFixed(f.price),
          size: formatFixed(f.size),
          fee: formatFixed(isMaker ? f.makerFee : f.takerFee),
          orderHash: isMaker ? f.makerOrderHash : f.takerOrderHash,
          txHash: f.txHash,
          createdAt: f.createdAt.getTime(),
        };
      }),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("fills error:", e);
    return NextResponse.json([], { status: 500 });
  }
}
