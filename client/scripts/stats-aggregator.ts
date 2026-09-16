#!/usr/bin/env tsx
/**
 * stats-aggregator.ts
 *
 * Rolls Fill + PnlEvent + BalanceChange rows into the leaderboard/portfolio
 * aggregate tables (TraderStat, AccountAnalytics) and writes periodic
 * LeaderboardSnapshot rows. Idempotent — safe to run repeatedly. Designed to
 * be invoked on a cadence (cron / the indexer loop) or standalone.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/stats-aggregator.ts          # one pass
 *   DATABASE_URL=... npx tsx scripts/stats-aggregator.ts --loop   # every 30s
 */

import { neon, type NeonQueryFunction } from "../lib/sql";
import { NETWORK } from "../config";

type Sql = NeonQueryFunction<false, false>;
const PERIODS = [
  { period: "DAY", since: () => new Date(Date.now() - 24 * 3600 * 1000) },
  { period: "WEEK", since: () => new Date(Date.now() - 7 * 24 * 3600 * 1000) },
  { period: "MONTH", since: () => new Date(Date.now() - 30 * 24 * 3600 * 1000) },
  { period: "ALL", since: () => new Date(0) },
] as const;

function cuid(): string {
  return "ts_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Volume + tradeCount + fees from Fills where the address is maker or taker. */
async function volumeStats(sql: Sql, since: Date) {
  return sql`
    SELECT addr AS address,
           SUM((("fillSize"::numeric) * ("fillPrice"::numeric) / 1e18))::text AS volume,
           COUNT(*)::int AS trade_count,
           MAX("createdAt") AS last_trade_at
    FROM (
      SELECT maker AS addr, "fillSize", "fillPrice", "createdAt" FROM "Fill"
        WHERE network = ${NETWORK.name} AND "createdAt" >= ${since.toISOString()}
      UNION ALL
      SELECT taker AS addr, "fillSize", "fillPrice", "createdAt" FROM "Fill"
        WHERE network = ${NETWORK.name} AND "createdAt" >= ${since.toISOString()}
    ) t
    GROUP BY addr
  `;
}

/** Realized PnL + win/loss counts + fees from PnlEvents. */
async function pnlStats(sql: Sql, since: Date) {
  return sql`
    SELECT address,
           SUM(CASE WHEN kind = 'REALIZED_TRADE' THEN amount::numeric ELSE 0 END)::text AS realized_pnl,
           SUM(CASE WHEN kind = 'FEE' THEN -amount::numeric ELSE 0 END)::text AS fees_paid,
           SUM(CASE WHEN kind = 'FUNDING' THEN amount::numeric ELSE 0 END)::text AS funding_paid,
           COUNT(*) FILTER (WHERE kind = 'REALIZED_TRADE' AND amount::numeric > 0)::int AS wins,
           COUNT(*) FILTER (WHERE kind = 'REALIZED_TRADE' AND amount::numeric < 0)::int AS losses,
           COUNT(*) FILTER (WHERE kind = 'LIQUIDATION')::int AS liq_count
    FROM "PnlEvent"
    WHERE network = ${NETWORK.name} AND "createdAt" >= ${since.toISOString()}
    GROUP BY address
  `;
}

/** Peak collateral (sum of deposits) per address — ROI denominator. */
async function depositStats(sql: Sql) {
  return sql`
    SELECT address,
           SUM(CASE WHEN kind = 'DEPOSIT' THEN amount::numeric ELSE 0 END)::text AS deposited,
           SUM(CASE WHEN kind = 'WITHDRAWAL' THEN amount::numeric ELSE 0 END)::text AS withdrawn
    FROM "BalanceChange"
    WHERE network = ${NETWORK.name}
    GROUP BY address
  `;
}

async function aggregatePeriod(sql: Sql, period: string, since: Date) {
  const [vol, pnl, dep] = await Promise.all([
    volumeStats(sql, since),
    pnlStats(sql, since),
    depositStats(sql),
  ]);

  const byAddr = new Map<string, Record<string, unknown>>();
  const get = (a: string) => {
    if (!byAddr.has(a)) byAddr.set(a, { address: a });
    return byAddr.get(a)!;
  };
  for (const r of vol) Object.assign(get(r.address as string), { volume: r.volume, tradeCount: r.trade_count, lastTradeAt: r.last_trade_at });
  for (const r of pnl) Object.assign(get(r.address as string), { realizedPnl: r.realized_pnl, feesPaid: r.fees_paid, fundingPaid: r.funding_paid, wins: r.wins, losses: r.losses, liqCount: r.liq_count });
  const depMap = new Map(dep.map((d) => [d.address as string, d]));

  let upserts = 0;
  for (const [addr, s] of byAddr) {
    const wins = Number(s.wins ?? 0);
    const losses = Number(s.losses ?? 0);
    const decided = wins + losses;
    const winRate = decided > 0 ? (wins / decided) : 0;
    const realized = Number(s.realizedPnl ?? 0);
    const deposited = Number(depMap.get(addr)?.deposited ?? 0);
    const peakCollateral = Math.max(deposited, 1);
    const roi = realized / peakCollateral;

    await sql`
      INSERT INTO "TraderStat" (
        id, network, address, period, "periodStart",
        "realizedPnl", volume, "tradeCount", "winningTrades", "losingTrades",
        "winRate", roi, "feesPaid", "fundingPaid", "liquidationCount",
        "peakCollateral", "lastTradeAt", "updatedAt"
      ) VALUES (
        ${cuid()}, ${NETWORK.name}, ${addr}, ${period}::"StatsPeriod", ${since.toISOString()},
        ${String(s.realizedPnl ?? "0")}, ${String(s.volume ?? "0")}, ${Number(s.tradeCount ?? 0)},
        ${wins}, ${losses}, ${winRate.toFixed(4)}, ${roi.toFixed(4)},
        ${String(s.feesPaid ?? "0")}, ${String(s.fundingPaid ?? "0")}, ${Number(s.liqCount ?? 0)},
        ${String(deposited)}, ${s.lastTradeAt ?? null}, NOW()
      )
      ON CONFLICT (network, address, period) DO UPDATE SET
        "realizedPnl" = EXCLUDED."realizedPnl",
        volume = EXCLUDED.volume,
        "tradeCount" = EXCLUDED."tradeCount",
        "winningTrades" = EXCLUDED."winningTrades",
        "losingTrades" = EXCLUDED."losingTrades",
        "winRate" = EXCLUDED."winRate",
        roi = EXCLUDED.roi,
        "feesPaid" = EXCLUDED."feesPaid",
        "fundingPaid" = EXCLUDED."fundingPaid",
        "liquidationCount" = EXCLUDED."liquidationCount",
        "peakCollateral" = EXCLUDED."peakCollateral",
        "lastTradeAt" = EXCLUDED."lastTradeAt",
        "updatedAt" = NOW()
    `;
    upserts++;
  }

  // Snapshot top-50 by realized PnL for historical boards.
  if (byAddr.size > 0) {
    const ranked = [...byAddr.values()]
      .map((s) => ({
        address: s.address,
        pnl: Number(s.realizedPnl ?? 0),
        volume: Number(s.volume ?? 0),
        roi: Number(depMap.get(s.address as string)?.deposited ?? 0) > 0
          ? Number(s.realizedPnl ?? 0) / Number(depMap.get(s.address as string)!.deposited)
          : 0,
      }))
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 50)
      .map((r, i) => ({ rank: i + 1, ...r }));

    await sql`
      INSERT INTO "LeaderboardSnapshot" (network, period, metric, rankings, "traderCount")
      VALUES (${NETWORK.name}, ${period}::"StatsPeriod", 'pnl', ${JSON.stringify(ranked)}::jsonb, ${byAddr.size})
    `;
  }

  return upserts;
}

/** Recompute AccountAnalytics (all-time, denormalized) for fast portfolio loads. */
async function aggregateAnalytics(sql: Sql) {
  const rows = await sql`
    WITH v AS (
      SELECT addr AS address,
             SUM((("fillSize"::numeric)*("fillPrice"::numeric)/1e18)) AS volume,
             COUNT(*) AS trades, MIN("createdAt") AS first_at, MAX("createdAt") AS last_at
      FROM (
        SELECT maker AS addr, "fillSize", "fillPrice", "createdAt" FROM "Fill" WHERE network = ${NETWORK.name}
        UNION ALL
        SELECT taker AS addr, "fillSize", "fillPrice", "createdAt" FROM "Fill" WHERE network = ${NETWORK.name}
      ) f GROUP BY addr
    ),
    p AS (
      SELECT address,
             SUM(CASE WHEN kind='REALIZED_TRADE' THEN amount::numeric ELSE 0 END) AS realized,
             SUM(CASE WHEN kind='FEE' THEN -amount::numeric ELSE 0 END) AS fees,
             SUM(CASE WHEN kind='FUNDING' THEN amount::numeric ELSE 0 END) AS funding,
             COUNT(*) FILTER (WHERE kind='REALIZED_TRADE' AND amount::numeric>0) AS wins,
             COUNT(*) FILTER (WHERE kind='REALIZED_TRADE' AND amount::numeric<0) AS losses,
             COUNT(*) FILTER (WHERE kind='LIQUIDATION') AS liqs
      FROM "PnlEvent" WHERE network = ${NETWORK.name} GROUP BY address
    ),
    b AS (
      SELECT address,
             SUM(CASE WHEN kind='DEPOSIT' THEN amount::numeric ELSE 0 END) AS deposited,
             SUM(CASE WHEN kind='WITHDRAWAL' THEN amount::numeric ELSE 0 END) AS withdrawn
      FROM "BalanceChange" WHERE network = ${NETWORK.name} GROUP BY address
    )
    SELECT COALESCE(v.address,p.address,b.address) AS address,
           COALESCE(v.volume,0)::text AS volume, COALESCE(v.trades,0)::int AS trades,
           v.first_at, v.last_at,
           COALESCE(p.realized,0)::text AS realized, COALESCE(p.fees,0)::text AS fees,
           COALESCE(p.funding,0)::text AS funding, COALESCE(p.wins,0)::int AS wins,
           COALESCE(p.losses,0)::int AS losses, COALESCE(p.liqs,0)::int AS liqs,
           COALESCE(b.deposited,0)::text AS deposited, COALESCE(b.withdrawn,0)::text AS withdrawn
    FROM v FULL OUTER JOIN p ON v.address=p.address FULL OUTER JOIN b ON COALESCE(v.address,p.address)=b.address
  `;

  for (const r of rows as Record<string, unknown>[]) {
    const wins = Number(r.wins), losses = Number(r.losses);
    const decided = wins + losses;
    const winRate = decided > 0 ? wins / decided : 0;
    await sql`
      INSERT INTO "AccountAnalytics" (
        network, address, "realizedPnlAll", "volumeAll", "tradeCountAll", "winRateAll",
        "totalDeposited", "totalWithdrawn", "totalFundingPaid", "totalFeesPaid",
        "liquidationCount", "firstTradeAt", "lastTradeAt", "updatedAt"
      ) VALUES (
        ${NETWORK.name}, ${r.address as string}, ${r.realized as string}, ${r.volume as string},
        ${Number(r.trades)}, ${winRate.toFixed(4)}, ${r.deposited as string}, ${r.withdrawn as string},
        ${r.funding as string}, ${r.fees as string}, ${Number(r.liqs)},
        ${(r.first_at as string) ?? null}, ${(r.last_at as string) ?? null}, NOW()
      )
      ON CONFLICT (network, address) DO UPDATE SET
        "realizedPnlAll" = EXCLUDED."realizedPnlAll", "volumeAll" = EXCLUDED."volumeAll",
        "tradeCountAll" = EXCLUDED."tradeCountAll", "winRateAll" = EXCLUDED."winRateAll",
        "totalDeposited" = EXCLUDED."totalDeposited", "totalWithdrawn" = EXCLUDED."totalWithdrawn",
        "totalFundingPaid" = EXCLUDED."totalFundingPaid", "totalFeesPaid" = EXCLUDED."totalFeesPaid",
        "liquidationCount" = EXCLUDED."liquidationCount", "lastTradeAt" = EXCLUDED."lastTradeAt",
        "updatedAt" = NOW()
    `;
  }
  return (rows as unknown[]).length;
}

export async function runAggregation(sql: Sql): Promise<{ stats: number; analytics: number }> {
  let stats = 0;
  for (const { period, since } of PERIODS) stats += await aggregatePeriod(sql, period, since());
  const analytics = await aggregateAnalytics(sql);
  return { stats, analytics };
}

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const loop = process.argv.includes("--loop");
  do {
    try {
      const { stats, analytics } = await runAggregation(sql);
      console.log(`[${new Date().toISOString().slice(11, 19)}] aggregated ${stats} trader-stat rows, ${analytics} analytics rows`);
    } catch (e) {
      console.error("aggregation error:", (e as Error).message);
    }
    if (loop) await new Promise((r) => setTimeout(r, 30_000));
  } while (loop);
}

if (process.argv[1]?.includes("stats-aggregator")) main().catch(console.error);
