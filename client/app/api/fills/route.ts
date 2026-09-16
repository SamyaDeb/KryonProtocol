import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { rateLimit, requestKey } from "@/lib/rate-limit";

const PRICE_SCALE  = 1e18;
const AMOUNT_SCALE = 1e7;

// GET /api/fills?address=G...&since=<unix-ms>&limit=10
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address || !StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json([], { status: 400 });
  }
  if (!(await rateLimit(requestKey(req, address), 120))) {
    return NextResponse.json([], { status: 429 });
  }

  // Reject a bad value rather than passing NaN into the query. `parseInt("x")`
  // is NaN, `Math.min(NaN, 50)` is NaN, and `LIMIT NaN` reaches Postgres as a
  // type error — so a malformed query string produced a 500 that read like a
  // server fault instead of a 400 that names the caller's mistake. Same for
  // `since`, where an unparseable value became an Invalid Date.
  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limitNum = limitRaw === null ? 20 : Number(limitRaw);
  if (!Number.isInteger(limitNum) || limitNum < 1) {
    return NextResponse.json({ error: "invalid_limit" }, { status: 400 });
  }
  const limit = Math.min(limitNum, 50);

  const since = req.nextUrl.searchParams.get("since");
  const sinceMs = since === null ? null : Number(since);
  if (sinceMs !== null && !Number.isFinite(sinceMs)) {
    return NextResponse.json({ error: "invalid_since" }, { status: 400 });
  }

  try {
    const sql = db(networkFromRequest(req));
    const sinceDate =
      sinceMs === null ? new Date(Date.now() - 24 * 3600 * 1000) : new Date(sinceMs);

    const rows = await sql`
      SELECT
        id,
        "marketId"   AS market_id,
        maker,
        taker,
        "makerNonce" AS maker_nonce,
        "takerNonce" AS taker_nonce,
        "fillPrice"  AS fill_price,
        "fillSize"   AS fill_size,
        "txHash"     AS tx_hash,
        "createdAt"  AS created_at
      FROM "Fill"
      WHERE (maker = ${address} OR taker = ${address})
        AND "createdAt" > ${sinceDate}
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;

    const fills = rows.map((r) => ({
      id:        String(r.id),
      marketId:  Number(r.market_id),
      isMaker:   r.maker === address,
      price:     (Number(r.fill_price) / PRICE_SCALE).toFixed(4),
      size:      (Number(r.fill_size)  / AMOUNT_SCALE).toFixed(4),
      txHash:    String(r.tx_hash),
      createdAt: new Date(r.created_at).getTime(),
    }));

    return NextResponse.json(fills, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json([], { status: 500 });
  }
}
