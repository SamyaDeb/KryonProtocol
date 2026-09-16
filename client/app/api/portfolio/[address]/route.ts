import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { db } from "@/lib/db";
import { networkAwareCacheControl, networkFromRequest } from "@/lib/network-server";
import { rateLimit, requestKey } from "@/lib/rate-limit";

const AMOUNT_SCALE = 1e7;
const PRICE_SCALE = 1e18;

function n(v: unknown, scale = AMOUNT_SCALE): number {
  return Number(v ?? 0) / scale;
}

// GET /api/portfolio/<address>
// Returns denormalized analytics + recent history for the portfolio page.
export async function GET(req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  if (!StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }
  if (!(await rateLimit(requestKey(req, address), 120))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    const network = networkFromRequest(req);
    const sql = db(network);

    const [analyticsRows, pnlHistory, balanceHistory, fundingHistory, snapshots] = await Promise.all([
      sql`SELECT * FROM "AccountAnalytics" WHERE network = ${network} AND address = ${address} LIMIT 1`,
      sql`SELECT kind, amount, size, price, "marketId", "txHash", "createdAt"
          FROM "PnlEvent" WHERE network = ${network} AND address = ${address}
          ORDER BY "createdAt" DESC LIMIT 100`,
      sql`SELECT kind, asset, amount, "balanceAfter", "txHash", "createdAt"
          FROM "BalanceChange" WHERE network = ${network} AND address = ${address}
          ORDER BY "createdAt" DESC LIMIT 50`,
      sql`SELECT "marketId", amount, "fundingIndex", "txHash", "createdAt"
          FROM "FundingPayment" WHERE network = ${network} AND address = ${address}
          ORDER BY "createdAt" DESC LIMIT 50`,
      sql`SELECT equity, "unrealizedPnl", "realizedPnlCum", "freeCollateral",
                 "usedMargin", "openPositionCount", "longExposure", "shortExposure", "capturedAt"
          FROM "PortfolioSnapshot" WHERE network = ${network} AND address = ${address}
          ORDER BY "capturedAt" DESC LIMIT 200`,
    ]);

    const a = analyticsRows[0] as Record<string, unknown> | undefined;

    const analytics = a
      ? {
          realizedPnl: n(a.realizedPnlAll),
          volume: n(a.volumeAll),
          tradeCount: Number(a.tradeCountAll),
          winRate: Number(a.winRateAll),
          totalDeposited: n(a.totalDeposited),
          totalWithdrawn: n(a.totalWithdrawn),
          totalFundingPaid: n(a.totalFundingPaid),
          totalFeesPaid: n(a.totalFeesPaid),
          liquidationCount: Number(a.liquidationCount),
          firstTradeAt: a.firstTradeAt,
          lastTradeAt: a.lastTradeAt,
        }
      : null;

    return NextResponse.json(
      {
        address,
        analytics,
        pnlHistory: (pnlHistory as Record<string, unknown>[]).map((r) => ({
          kind: r.kind,
          amount: n(r.amount),
          size: n(r.size),
          price: n(r.price, PRICE_SCALE),
          marketId: Number(r.marketId),
          txHash: r.txHash,
          at: r.createdAt,
        })),
        balanceHistory: (balanceHistory as Record<string, unknown>[]).map((r) => ({
          kind: r.kind, asset: r.asset, amount: n(r.amount),
          balanceAfter: r.balanceAfter ? n(r.balanceAfter) : null, txHash: r.txHash, at: r.createdAt,
        })),
        fundingHistory: (fundingHistory as Record<string, unknown>[]).map((r) => ({
          marketId: Number(r.marketId), amount: n(r.amount), txHash: r.txHash, at: r.createdAt,
        })),
        equityCurve: (snapshots as Record<string, unknown>[]).reverse().map((r) => ({
          equity: n(r.equity), unrealizedPnl: n(r.unrealizedPnl), realizedPnlCum: n(r.realizedPnlCum),
          at: r.capturedAt,
        })),
      },
      { headers: { "Cache-Control": networkAwareCacheControl(req, "s-maxage=5, stale-while-revalidate=15") } }
    );
  } catch {
    return NextResponse.json({ address, analytics: null, error: "portfolio_unavailable" }, { status: 500 });
  }
}
