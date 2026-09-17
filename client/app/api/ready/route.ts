import { NextRequest, NextResponse } from "next/server";
import { db, withRetry } from "@/lib/db";
import { getWsUrl } from "@/lib/network";
import { listActiveMarkets } from "@/lib/queries/markets";
import { networkFromRequest } from "@/lib/network-server";

export async function GET(req: NextRequest) {
  const network = networkFromRequest(req);
  try {
    const sql = db(network);

    // `markets` is read from the database, never from a config list.
    //
    // A config list is resolved at module scope from the deployment's PRIMARY
    // network — so it ignores the caller's `?network=` entirely — and it
    // describes the markets the deployment *intends* to list rather than the
    // ones actually registered. Together that made mainnet advertise all 8
    // symbols while only one was registered, so anything enumerating markets
    // from this endpoint got a 404 on the other seven. A readiness probe that
    // reports markets which do not exist is worse than one reporting none.
    //
    // The query is network-scoped: every Arc table is keyed by network, and an
    // unfiltered read here would list the other venue's markets.
    const markets = await withRetry(() => listActiveMarkets(sql, network), 2);

    return NextResponse.json(
      {
        ok: true,
        network,
        markets: markets.map((m) => m.symbol),
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
