import { NextRequest, NextResponse } from "next/server";
import { db, withRetry } from "@/lib/db";
import { getWsUrl } from "@/config";
import { networkFromRequest } from "@/lib/network-server";

export async function GET(req: NextRequest) {
  const network = networkFromRequest(req);
  try {
    const sql = db(network);

    // `markets` is read from the database, NOT from ACTIVE_MARKET_SYMBOLS.
    //
    // The config list is resolved at module scope from ACTIVE_NETWORK_ID,
    // which on the server is the deployment's PRIMARY network — so it ignored
    // the caller's `?network=` entirely — and it describes the markets the
    // deployment *intends* to list rather than the ones actually registered.
    // Together that made mainnet advertise all 8 symbols while only XLM-PERP
    // was registered, so anything enumerating markets from this endpoint got
    // a 404 on the other seven. A readiness probe that reports markets which
    // do not exist is worse than one that reports none.
    const rows = await withRetry(
      () => sql`SELECT symbol FROM "Market" WHERE active = true ORDER BY id ASC`,
      2
    );

    return NextResponse.json(
      {
        ok: true,
        network,
        markets: rows.map((r) => String(r.symbol)),
        websocketConfigured: Boolean(getWsUrl(network)),
        timestamp: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "readiness_unavailable",
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
