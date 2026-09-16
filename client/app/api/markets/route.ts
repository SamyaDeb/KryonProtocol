import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { MARKETS } from "@/config";

/**
 * GET /api/markets — the market listing.
 *
 * This is the discovery endpoint for programmatic traders. It returns the
 * markets the venue ACTUALLY serves, read from the database, joined with the
 * static trading parameters a bot needs to size an order correctly.
 *
 * Why it reads the database rather than the config: `/api/ready` reports
 * `ACTIVE_MARKET_SYMBOLS`, which is derived from config at module scope and is
 * therefore both (a) the deployment's primary network rather than the caller's,
 * and (b) the *intended* market set rather than the registered one. As of
 * 2026-09-05 that made mainnet advertise all 8 symbols while only XLM-PERP was
 * registered, so a bot enumerating markets from `/api/ready` got a 404 on seven
 * of them. A listing that can lie is worse than no listing.
 *
 * Static fields (precision, tick sizes, margin bps, OI caps) come from the
 * config registry, which is the source of truth for them; the on-chain
 * contracts enforce the margin and OI values independently.
 */
export async function GET(req: NextRequest) {
  const network = networkFromRequest(req);

  try {
    const sql = db(network);
    const rows = await sql`
      SELECT
        id AS market_id,
        symbol,
        active,
        "lastPrice"         AS last_price,
        "volume"            AS volume,
        "longOpenInterest"  AS long_open_interest,
        "shortOpenInterest" AS short_open_interest,
        "fundingLongIndex"  AS funding_long_index,
        "fundingShortIndex" AS funding_short_index,
        "lastOraclePrice"   AS last_oracle_price,
        "lastOracleLedger"  AS last_oracle_ledger,
        "updatedAt"         AS updated_at
      FROM "Market"
      ORDER BY id ASC
    `;

    const markets = rows.map((r) => {
      const symbol = String(r.symbol);
      const config = MARKETS[symbol];

      return {
        market_id: Number(r.market_id),
        symbol,
        active: Boolean(r.active),

        // Live state — raw fixed-point, matching GET /api/markets/:id.
        last_price: String(r.last_price),
        volume: String(r.volume),
        long_open_interest: String(r.long_open_interest),
        short_open_interest: String(r.short_open_interest),
        funding_long_index: String(r.funding_long_index),
        funding_short_index: String(r.funding_short_index),
        last_oracle_price: String(r.last_oracle_price),
        last_oracle_ledger: Number(r.last_oracle_ledger),
        updated_at: new Date(r.updated_at as string).getTime(),

        // Static trading parameters. Null when a market is registered on chain
        // but absent from the config registry — a bot should treat that as
        // "tradable but size it yourself" rather than crash.
        base_asset: config?.baseAsset ?? null,
        quote_asset: config?.quoteAsset ?? null,
        price_decimals: config?.priceDecimals ?? null,
        size_decimals: config?.sizeDecimals ?? null,
        tick_sizes: config?.tickSizes ?? null,
        max_leverage_bps: config?.maxLeverageBps ?? null,
        initial_margin_bps: config?.initialMarginBps ?? null,
        maintenance_margin_bps: config?.maintenanceMarginBps ?? null,
        liquidation_fee_bps: config?.liquidationFeeBps ?? null,
        max_open_interest_base: config?.maxOpenInterestBase ?? null,
      };
    });

    return NextResponse.json(
      {
        network,
        // Precision is global, not per market, and is the single most common
        // thing an integrator gets wrong. State it in the payload.
        price_precision: "1000000000000000000",
        amount_precision: "10000000",
        markets,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("markets listing error:", e);
    return NextResponse.json({ error: "markets_unavailable" }, { status: 500 });
  }
}
