import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { aggregateBook, listWorkingOrdersForMarket } from "@/lib/queries/orders";
import { formatFixed, parseMarketId } from "@/lib/queries/scalars";

/**
 * GET /api/markets/:id/orderbook — the public book, aggregated by price.
 *
 * Built from exactly the orders the matcher can trade (live status, unexpired,
 * nonce at or above the owner's `minValidNonce`), sized by REMAINING size:
 * `size − filledSize − PENDING reservations`, the matcher's own definition
 * (`lib/queries/orders.ts`). Showing gross size, or orders the matcher will
 * skip, is how a book ends up crossed with nobody able to trade it.
 *
 * `price`/`size` are display decimals for the UI; `price_raw`/`size_raw` are
 * the exact 1e18 values for bots.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = parseMarketId((await params).id);
  if (marketId === null) return NextResponse.json(null, { status: 400 });

  const network = networkFromRequest(req);
  try {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const orders = await listWorkingOrdersForMarket(db(network), network, marketId, nowSec);
    const { bids, asks } = aggregateBook(orders);
    const level = (l: { price: bigint; size: bigint; orders: number }) => ({
      price: formatFixed(l.price),
      size: formatFixed(l.size),
      price_raw: l.price.toString(),
      size_raw: l.size.toString(),
      orders: l.orders,
    });
    return NextResponse.json(
      { bids: bids.map(level), asks: asks.map(level), timestamp: Date.now() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("orderbook error:", e);
    return NextResponse.json(null, { status: 500 });
  }
}
