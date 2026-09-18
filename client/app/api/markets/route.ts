import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { marketVolumes } from "@/lib/queries/fills";
import { E18_STRING, marketToJson } from "@/lib/queries/json";
import { listMarkets } from "@/lib/queries/markets";

/**
 * GET /api/markets — every market the indexer has seen on the caller's network.
 *
 * The discovery endpoint for programmatic traders. Everything in it is chain
 * state read from the database: risk parameters come from `Market.params`
 * (projected from `RiskParams.MarketParamsSet`), never from a config table, so
 * a bot sizing an order against `min_fill_notional` sees the value the gateway
 * will actually enforce. Presentation fields come from `lib/markets.ts`.
 *
 * Inactive markets are listed with `active: false` rather than hidden, so a
 * bot can tell "paused" from "does not exist". Order intake rejects both.
 */
export async function GET(req: NextRequest) {
  const network = networkFromRequest(req);
  try {
    const sql = db(network);
    const [markets, volumes] = await Promise.all([
      listMarkets(sql, network),
      marketVolumes(sql, network, new Date(Date.now() - 24 * 3600 * 1000)),
    ]);
    return NextResponse.json(
      {
        network,
        // Precision is global and the most common thing an integrator gets
        // wrong, so it is stated in the payload. Both are 1e18 on Arc.
        price_precision: E18_STRING,
        amount_precision: E18_STRING,
        markets: markets.map((m) => marketToJson(m, volumes.get(m.marketId))),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("markets listing error:", e);
    return NextResponse.json({ error: "markets_unavailable" }, { status: 500 });
  }
}
