import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { listOrdersForOwner } from "@/lib/queries/orders";
import { parseAddress, parseLimit, parseMarketId } from "@/lib/queries/scalars";
import { rateLimit, requestKey } from "@/lib/rate-limit";

/**
 * GET /api/orders/list?address=0x…&status=open&market_id=1&limit=100
 *
 * An account's own orders. This is what makes a bot restartable: without it a
 * crashed bot cannot learn what it still has working, cannot cancel it, and
 * cannot reconcile against the book.
 *
 * `status`:
 *   open (default) — exactly what the matcher can still trade: OPEN or
 *                    PARTIALLY_FILLED, unexpired, nonce ≥ the account's
 *                    on-chain `minValidNonce`, and remaining size > 0
 *   all            — everything, newest first
 *
 * `remaining_size` = size − filled_size − pending_size, the matcher's own
 * definition: `filled_size` is settled on chain, `pending_size` is matched and
 * awaiting settlement. `status` is the indexer's, so an order whose fills are
 * all still PENDING reads OPEN with less remaining than its size.
 *
 * Sizes and prices are raw 1e18 strings, as signed.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const address = parseAddress(sp.get("address"));
  if (!address) return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  if (!(await rateLimit(requestKey(req, address), 120))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const status = sp.get("status") === "all" ? "all" : "open";
  const limit = parseLimit(sp.get("limit"), 100, 500);
  if (limit === null) return NextResponse.json({ error: "invalid_limit" }, { status: 400 });
  const marketRaw = sp.get("market_id");
  const marketId = marketRaw === null ? null : parseMarketId(marketRaw);
  if (marketRaw !== null && marketId === null) {
    return NextResponse.json({ error: "invalid_market_id" }, { status: 400 });
  }

  const network = networkFromRequest(req);
  try {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const rows = await listOrdersForOwner(db(network), network, address, {
      scope: status === "open" ? "working" : "all",
      marketId,
      limit,
      nowSec,
    });
    const orders = rows.map((o) => ({
      order_hash: o.orderHash,
      owner: o.owner,
      market_id: o.marketId,
      is_long: o.isLong,
      size: o.size.toString(),
      limit_price: o.limitPrice.toString(),
      filled_size: o.filledSize.toString(),
      pending_size: o.pendingSize.toString(),
      remaining_size: o.remainingSize.toString(),
      reduce_only: o.reduceOnly,
      // The nonce is the on-chain cancel handle (`cancelOrder` / `cancelUpTo`).
      nonce: o.nonce.toString(),
      expiry: o.expiry.toString(),
      referrer: o.referrer,
      status: o.status,
      expired: o.expiry <= nowSec,
      // Below `cancelUpTo`: dead on chain whatever `status` says.
      nonce_invalidated: o.nonce < o.minValidNonce,
      created_at: o.createdAt.getTime(),
      updated_at: o.updatedAt.getTime(),
    }));
    return NextResponse.json(
      { address, status, count: orders.length, orders },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("order listing error:", e);
    return NextResponse.json({ error: "orders_unavailable" }, { status: 500 });
  }
}
