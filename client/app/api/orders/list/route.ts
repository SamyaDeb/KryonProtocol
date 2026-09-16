import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { rateLimit, requestKey } from "@/lib/rate-limit";

/**
 * GET /api/orders/list?address=G…&status=open&market_id=1&limit=100
 *
 * An account's own orders.
 *
 * This is what makes a bot restartable. Without it, an order's nonce exists
 * only in the process that created it: a bot that crashes has no way to learn
 * what it still has resting, cannot cancel those orders, and cannot reconcile
 * its position against the book. Every serious integration needs this on
 * startup, and several need it on every loop.
 *
 * Mounted at /api/orders/list rather than /api/orders because that path is
 * already the POST intake and Next routes both verbs to one handler file; a
 * separate path keeps the read and the write independently cacheable and
 * independently rate-limited.
 *
 * `status`:
 *   open   (default) — not cancelled, not fully filled, not expired
 *   all              — everything, newest first
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

  const status = params.get("status") === "all" ? "all" : "open";
  const limit = Math.min(
    Math.max(parseInt(params.get("limit") ?? "100", 10) || 100, 1),
    500
  );

  const marketIdRaw = params.get("market_id");
  const marketId = marketIdRaw === null ? null : Number(marketIdRaw);
  if (marketId !== null && !Number.isInteger(marketId)) {
    return NextResponse.json({ error: "invalid_market_id" }, { status: 400 });
  }

  try {
    const sql = db(networkFromRequest(req));
    const nowSec = Math.floor(Date.now() / 1000);

    // Two shapes rather than a dynamic WHERE: the template-literal client
    // parameterises fragments, not predicates, and hand-concatenating a
    // predicate here is how an injection gets in.
    const rows =
      status === "open"
        ? marketId === null
          ? await sql`
              SELECT id, owner, "marketId", "isLong", size, "limitPrice",
                     "reduceOnly", nonce, "expiryTs", cancelled, "filledSize",
                     "createdAt", "updatedAt"
              FROM "Order"
              WHERE owner = ${address}
                AND cancelled = false
                AND "expiryTs" > ${nowSec}
                AND "filledSize"::numeric < size::numeric
              ORDER BY "createdAt" DESC
              LIMIT ${limit}
            `
          : await sql`
              SELECT id, owner, "marketId", "isLong", size, "limitPrice",
                     "reduceOnly", nonce, "expiryTs", cancelled, "filledSize",
                     "createdAt", "updatedAt"
              FROM "Order"
              WHERE owner = ${address}
                AND "marketId" = ${marketId}
                AND cancelled = false
                AND "expiryTs" > ${nowSec}
                AND "filledSize"::numeric < size::numeric
              ORDER BY "createdAt" DESC
              LIMIT ${limit}
            `
        : marketId === null
          ? await sql`
              SELECT id, owner, "marketId", "isLong", size, "limitPrice",
                     "reduceOnly", nonce, "expiryTs", cancelled, "filledSize",
                     "createdAt", "updatedAt"
              FROM "Order"
              WHERE owner = ${address}
              ORDER BY "createdAt" DESC
              LIMIT ${limit}
            `
          : await sql`
              SELECT id, owner, "marketId", "isLong", size, "limitPrice",
                     "reduceOnly", nonce, "expiryTs", cancelled, "filledSize",
                     "createdAt", "updatedAt"
              FROM "Order"
              WHERE owner = ${address} AND "marketId" = ${marketId}
              ORDER BY "createdAt" DESC
              LIMIT ${limit}
            `;

    const orders = rows.map((r) => {
      const size = String(r.size);
      const filled = String(r.filledSize);
      const expiry = String(r.expiryTs);

      return {
        id: String(r.id),
        owner: String(r.owner),
        market_id: Number(r.marketId),
        is_long: Boolean(r.isLong),
        // Raw fixed-point, consistent with the order intake payload: this is
        // the shape a bot signed, so it is the shape it can reconcile against.
        size,
        limit_price: String(r.limitPrice),
        filled_size: filled,
        remaining_size: (BigInt(size) - BigInt(filled)).toString(),
        reduce_only: Boolean(r.reduceOnly),
        // The nonce is the cancel handle — the reason this endpoint exists.
        nonce: String(r.nonce),
        expiry_ts: expiry,
        cancelled: Boolean(r.cancelled),
        expired: Number(expiry) <= nowSec,
        created_at: new Date(r.createdAt as string).getTime(),
        updated_at: new Date(r.updatedAt as string).getTime(),
      };
    });

    return NextResponse.json(
      { address, status, count: orders.length, orders },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("order listing error:", e);
    return NextResponse.json({ error: "orders_unavailable" }, { status: 500 });
  }
}
