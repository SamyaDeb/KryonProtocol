import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkAwareCacheControl, networkFromRequest } from "@/lib/network-server";
import { listFundingPayments } from "@/lib/queries/funding";
import {
  getAccountAnalytics,
  listBalanceChanges,
  listPnlEvents,
  listPortfolioSnapshots,
} from "@/lib/queries/portfolio";
import { parseAddress, toFloat } from "@/lib/queries/scalars";
import { rateLimit, requestKey } from "@/lib/rate-limit";

/** Analytics tables are 1e6 USDC; event tables are 1e18. */
const usd6 = (v: bigint) => toFloat(v, 6);
const e18 = (v: bigint) => toFloat(v, 18);

// GET /api/portfolio/<address> — analytics plus recent history for the portfolio page.
export async function GET(req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  const address = parseAddress((await ctx.params).address);
  if (!address) return NextResponse.json({ error: "invalid address" }, { status: 400 });
  if (!(await rateLimit(requestKey(req, address), 120))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const network = networkFromRequest(req);
  try {
    const sql = db(network);
    const [a, pnl, balances, funding, snapshots] = await Promise.all([
      getAccountAnalytics(sql, network, address),
      listPnlEvents(sql, network, address, 100),
      listBalanceChanges(sql, network, address, 50),
      listFundingPayments(sql, network, address, 50),
      listPortfolioSnapshots(sql, network, address, 200),
    ]);

    return NextResponse.json(
      {
        address,
        analytics: a
          ? {
              realizedPnl: usd6(a.realizedPnlAll),
              volume: usd6(a.volumeAll),
              tradeCount: a.tradeCountAll,
              winRate: a.winRateAll,
              totalDeposited: usd6(a.totalDeposited),
              totalWithdrawn: usd6(a.totalWithdrawn),
              totalFundingPaid: usd6(a.totalFundingPaid),
              totalFeesPaid: usd6(a.totalFeesPaid),
              liquidationCount: a.liquidationCount,
              firstTradeAt: a.firstTradeAt,
              lastTradeAt: a.lastTradeAt,
            }
          : null,
        pnlHistory: pnl.map((r) => ({
          kind: r.kind,
          amount: e18(r.amount),
          size: e18(r.size),
          price: e18(r.price),
          marketId: r.marketId,
          txHash: r.txHash,
          at: r.createdAt,
        })),
        balanceHistory: balances.map((r) => ({
          kind: r.kind,
          // Arc has one collateral asset. Kept for the shape the page reads.
          asset: "USDC",
          amount: e18(r.internalAmount),
          counterparty: r.counterparty,
          // Not recorded per event on Arc; the page already renders null.
          balanceAfter: null,
          txHash: r.txHash,
          at: r.createdAt,
        })),
        fundingHistory: funding.map((r) => ({
          marketId: r.marketId,
          amount: e18(r.amount),
          txHash: r.txHash,
          at: r.createdAt,
        })),
        equityCurve: snapshots.map((r) => ({
          equity: usd6(r.equity),
          unrealizedPnl: usd6(r.unrealizedPnl),
          realizedPnlCum: usd6(r.realizedPnlCum),
          at: r.capturedAt,
        })),
      },
      { headers: { "Cache-Control": networkAwareCacheControl(req, "s-maxage=5, stale-while-revalidate=15") } }
    );
  } catch (e) {
    console.error("portfolio error:", e);
    return NextResponse.json({ address, analytics: null, error: "portfolio_unavailable" }, { status: 500 });
  }
}
