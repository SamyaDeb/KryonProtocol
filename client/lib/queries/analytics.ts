/**
 * The statements the stats aggregator runs: read one address's indexed
 * activity, write its rollups, and move the cursor.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * Only the indexer's projections — `Fill`, `PnlEvent`, `LiquidationEvent`,
 * `BalanceChange` and the `Order.referrer` of a settled fill. Never the chain,
 * and never the matcher's PENDING rows: `status = 'SETTLED'` is in every fill
 * predicate here.
 *
 * WHY EVERY ROW CARRIES A BLOCK TIMESTAMP
 * ---------------------------------------
 * Each projection row shares `(network, txHash, logIndex)` with the
 * `ProtocolEvent` it came from, so its block timestamp is a join away. That is
 * the time a window is measured against: `createdAt` is when the indexer
 * happened to write the row, and a re-index (`resetProjections` deletes and
 * replays every derived table) rewrites it, which would silently move trades
 * between days. `COALESCE` back to `createdAt` only so a row whose event is
 * missing still lands somewhere sane.
 *
 * Server-side only.
 */

import type { ArcNetworkId } from "@/lib/network";
import type { Queryable, Rows } from "./client";
import { big } from "./scalars";
import type {
  AccountAnalyticsRow,
  AddressActivity,
  AddressStats,
  PnlKind,
  StatsPeriod,
  TraderStatRow,
} from "@/lib/stats/metrics";
import { emptyActivity } from "@/lib/stats/metrics";

/** The aggregator's `BlockCursor` stream name. */
export const STATS_CURSOR_STREAM = "stats";

export interface IndexedHead {
  blockNumber: bigint;
  blockHash: string;
}

const ordered = (r: Record<string, unknown>) => ({
  blockNumber: big(r.blockNumber),
  logIndex: Number(r.logIndex ?? 0),
  at: new Date(r.at as string),
});

/** Timestamp join: a projection row's own event. `$alias` is the row's alias. */
function eventTime(alias: string): string {
  return `LEFT JOIN "ProtocolEvent" pe
       ON pe."network" = ${alias}."network" AND pe."txHash" = ${alias}."txHash" AND pe."logIndex" = ${alias}."logIndex"`;
}

// ── cursor ──────────────────────────────────────────────────────────────────

/** The newest block the indexer has stored events for. */
export async function indexedHead(q: Queryable, network: ArcNetworkId): Promise<IndexedHead | null> {
  const rows = await q.query(
    // ORDER BY names the TABLE's column, not the ::text output alias above it:
    // an output-column reference would sort "9" after "12", lexically.
    `SELECT e."blockNumber"::text AS "blockNumber", e."blockHash" FROM "ProtocolEvent" e
     WHERE e."network" = $1 ORDER BY e."blockNumber" DESC LIMIT 1`,
    [network]
  );
  return rows.length === 0 ? null : { blockNumber: big(rows[0].blockNumber), blockHash: String(rows[0].blockHash) };
}

/** The hash stored for a block, or null if nothing is stored at that height any more. */
export async function blockHashAt(q: Queryable, network: ArcNetworkId, blockNumber: bigint): Promise<string | null> {
  const rows = await q.query(
    `SELECT "blockHash" FROM "ProtocolEvent" WHERE "network" = $1 AND "blockNumber" = $2 LIMIT 1`,
    [network, blockNumber.toString()]
  );
  return rows.length === 0 ? null : String(rows[0].blockHash);
}

export async function getStatsCursor(q: Queryable, network: ArcNetworkId): Promise<IndexedHead | null> {
  const rows = await q.query(
    `SELECT "blockNumber"::text AS "blockNumber", "blockHash" FROM "BlockCursor" WHERE "network" = $1 AND "stream" = $2`,
    [network, STATS_CURSOR_STREAM]
  );
  return rows.length === 0 ? null : { blockNumber: big(rows[0].blockNumber), blockHash: String(rows[0].blockHash) };
}

export async function setStatsCursor(q: Queryable, network: ArcNetworkId, head: IndexedHead): Promise<void> {
  await q.query(
    `INSERT INTO "BlockCursor" ("network", "stream", "blockNumber", "blockHash", "updatedAt")
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT ("network", "stream") DO UPDATE SET
       "blockNumber" = EXCLUDED."blockNumber", "blockHash" = EXCLUDED."blockHash", "updatedAt" = now()`,
    [network, STATS_CURSOR_STREAM, head.blockNumber.toString(), head.blockHash]
  );
}

// ── which addresses need recomputing ────────────────────────────────────────

const addressesFrom = (rows: Rows): string[] => [...new Set(rows.map((r) => String(r.address)))];

/**
 * Addresses touched by an event after `afterBlock` — the incremental work list.
 * A referrer counts as touched: a fill on a referred order moves its stats.
 */
export async function dirtyAddressesSince(
  q: Queryable,
  network: ArcNetworkId,
  afterBlock: bigint,
  upToBlock: bigint
): Promise<string[]> {
  const rows = await q.query(
    `SELECT "maker" AS "address" FROM "Fill"
       WHERE "network" = $1 AND "status" = 'SETTLED' AND "blockNumber" > $2 AND "blockNumber" <= $3
     UNION
     SELECT "taker" AS "address" FROM "Fill"
       WHERE "network" = $1 AND "status" = 'SETTLED' AND "blockNumber" > $2 AND "blockNumber" <= $3
     UNION
     SELECT o."referrer" AS "address" FROM "Fill" f
       JOIN "Order" o ON o."network" = f."network"
        AND o."orderHash" IN (f."makerOrderHash", f."takerOrderHash")
       WHERE f."network" = $1 AND f."status" = 'SETTLED' AND f."blockNumber" > $2 AND f."blockNumber" <= $3
         AND o."referrer" IS NOT NULL
     UNION
     SELECT "address" FROM "PnlEvent" WHERE "network" = $1 AND "blockNumber" > $2 AND "blockNumber" <= $3
     UNION
     SELECT "trader" AS "address" FROM "LiquidationEvent"
       WHERE "network" = $1 AND "blockNumber" > $2 AND "blockNumber" <= $3
     UNION
     SELECT "address" FROM "BalanceChange"
       WHERE "network" = $1 AND "blockNumber" > $2 AND "blockNumber" <= $3 AND "kind" IN ('DEPOSIT', 'WITHDRAWAL')`,
    [network, afterBlock.toString(), upToBlock.toString()]
  );
  return addressesFrom(rows);
}

/**
 * Addresses whose stored window no longer matches the current one — the rows
 * that must be recomputed because the window ROLLED, not because anything was
 * traded. This is what makes an aged-out trade leave the DAY board.
 */
export async function addressesWithStaleWindow(
  q: Queryable,
  network: ArcNetworkId,
  current: { period: StatsPeriod; start: Date }[]
): Promise<string[]> {
  if (current.length === 0) return [];
  const rows = await q.query(
    `SELECT DISTINCT "address" FROM "TraderStat"
     WHERE "network" = $1 AND "period" = ANY($2::"StatsPeriod"[]) AND "periodStart" <> ALL($3::timestamp[])`,
    [network, current.map((c) => c.period), current.map((c) => c.start.toISOString())]
  );
  return addressesFrom(rows);
}

/** Every address with any indexed activity, plus every address already holding a rollup. */
export async function allKnownAddresses(q: Queryable, network: ArcNetworkId): Promise<string[]> {
  const rows = await q.query(
    `SELECT "maker" AS "address" FROM "Fill" WHERE "network" = $1 AND "status" = 'SETTLED'
     UNION SELECT "taker" AS "address" FROM "Fill" WHERE "network" = $1 AND "status" = 'SETTLED'
     UNION SELECT o."referrer" AS "address" FROM "Order" o WHERE o."network" = $1 AND o."referrer" IS NOT NULL
     UNION SELECT "address" FROM "PnlEvent" WHERE "network" = $1
     UNION SELECT "trader" AS "address" FROM "LiquidationEvent" WHERE "network" = $1
     UNION SELECT "address" FROM "BalanceChange" WHERE "network" = $1 AND "kind" IN ('DEPOSIT', 'WITHDRAWAL')
     UNION SELECT "address" FROM "TraderStat" WHERE "network" = $1
     UNION SELECT "address" FROM "AccountAnalytics" WHERE "network" = $1`,
    [network]
  );
  return addressesFrom(rows);
}

// ── activity ────────────────────────────────────────────────────────────────

/** Every event the metrics need, for a batch of addresses. */
export async function loadActivity(
  q: Queryable,
  network: ArcNetworkId,
  addresses: readonly string[]
): Promise<Map<string, AddressActivity>> {
  const out = new Map<string, AddressActivity>();
  const bucket = (address: string) => {
    let a = out.get(address);
    if (!a) out.set(address, (a = emptyActivity()));
    return a;
  };
  for (const address of addresses) bucket(address);
  if (addresses.length === 0) return out;
  const params = [network, addresses];

  const [fills, referrals, pnl, liquidations, balances] = await Promise.all([
    q.query(
      `SELECT f."fillId", f."maker", f."taker", (f."size" * f."price")::text AS "notional",
              f."blockNumber"::text AS "blockNumber", COALESCE(f."logIndex", 0) AS "logIndex",
              COALESCE(pe."blockTimestamp", f."createdAt") AS "at"
       FROM "Fill" f
       ${eventTime("f")}
       WHERE f."network" = $1 AND f."status" = 'SETTLED'
         AND (f."maker" = ANY($2::text[]) OR f."taker" = ANY($2::text[]))`,
      params
    ),
    q.query(
      `SELECT o."referrer" AS "address", o."owner" AS "trader", (f."size" * f."price")::text AS "notional",
              f."blockNumber"::text AS "blockNumber", COALESCE(f."logIndex", 0) AS "logIndex",
              COALESCE(pe."blockTimestamp", f."createdAt") AS "at"
       FROM "Fill" f
       JOIN "Order" o ON o."network" = f."network" AND o."orderHash" IN (f."makerOrderHash", f."takerOrderHash")
       ${eventTime("f")}
       WHERE f."network" = $1 AND f."status" = 'SETTLED' AND o."referrer" = ANY($2::text[])`,
      params
    ),
    q.query(
      `SELECT p."address", p."kind", p."amount"::text AS "amount",
              p."blockNumber"::text AS "blockNumber", p."logIndex",
              COALESCE(pe."blockTimestamp", p."createdAt") AS "at"
       FROM "PnlEvent" p
       ${eventTime("p")}
       WHERE p."network" = $1 AND p."address" = ANY($2::text[])`,
      params
    ),
    q.query(
      `SELECT l."trader" AS "address", (l."closeSize" * l."price")::text AS "notional",
              l."blockNumber"::text AS "blockNumber", l."logIndex",
              COALESCE(pe."blockTimestamp", l."createdAt") AS "at"
       FROM "LiquidationEvent" l
       ${eventTime("l")}
       WHERE l."network" = $1 AND l."trader" = ANY($2::text[])`,
      params
    ),
    q.query(
      `SELECT b."address", b."kind", b."internalAmount"::text AS "amount",
              b."blockNumber"::text AS "blockNumber", b."logIndex",
              COALESCE(pe."blockTimestamp", b."createdAt") AS "at"
       FROM "BalanceChange" b
       ${eventTime("b")}
       WHERE b."network" = $1 AND b."address" = ANY($2::text[])
         AND b."kind" IN ('DEPOSIT', 'WITHDRAWAL')`,
      params
    ),
  ]);

  const watched = new Set(addresses);
  for (const r of fills) {
    const row = { ...ordered(r), fillId: String(r.fillId), maker: String(r.maker), taker: String(r.taker), notional: big(r.notional) };
    for (const side of new Set([row.maker, row.taker])) if (watched.has(side)) bucket(side).fills.push(row);
  }
  for (const r of referrals) {
    bucket(String(r.address)).referrals.push({ ...ordered(r), trader: String(r.trader), notional: big(r.notional) });
  }
  for (const r of pnl) {
    bucket(String(r.address)).pnl.push({ ...ordered(r), kind: String(r.kind) as PnlKind, amount: big(r.amount) });
  }
  for (const r of liquidations) {
    bucket(String(r.address)).liquidations.push({ ...ordered(r), notional: big(r.notional) });
  }
  for (const r of balances) {
    bucket(String(r.address)).balances.push({
      ...ordered(r),
      kind: String(r.kind) as "DEPOSIT" | "WITHDRAWAL",
      amount: big(r.amount),
    });
  }
  return out;
}

// ── writes ──────────────────────────────────────────────────────────────────

const TRADER_STAT_COLUMNS = [
  "network",
  "address",
  "period",
  "periodStart",
  "realizedPnl",
  "volume",
  "tradeCount",
  "winningTrades",
  "losingTrades",
  "winRate",
  "roi",
  "feesPaid",
  "fundingPaid",
  "liquidationCount",
  "liquidatedVolume",
  "peakEquity",
  "referralCount",
  "referralVolume",
  "lastTradeAt",
  "updatedAt",
] as const;

const ANALYTICS_COLUMNS = [
  "network",
  "address",
  "realizedPnlAll",
  "volumeAll",
  "volume30d",
  "tradeCountAll",
  "winRateAll",
  "totalDeposited",
  "totalWithdrawn",
  "totalFundingPaid",
  "totalFeesPaid",
  "liquidationCount",
  "maxDrawdown",
  "firstTradeAt",
  "lastTradeAt",
  "updatedAt",
] as const;

function traderStatValues(network: ArcNetworkId, r: TraderStatRow, now: Date): unknown[] {
  return [
    network,
    r.address,
    r.period,
    r.periodStart,
    r.realizedPnl.toString(),
    r.volume.toString(),
    r.tradeCount,
    r.winningTrades,
    r.losingTrades,
    r.winRate,
    r.roi,
    r.feesPaid.toString(),
    r.fundingPaid.toString(),
    r.liquidationCount,
    r.liquidatedVolume.toString(),
    r.peakEquity.toString(),
    r.referralCount,
    r.referralVolume.toString(),
    r.lastTradeAt,
    now,
  ];
}

function analyticsValues(network: ArcNetworkId, r: AccountAnalyticsRow, now: Date): unknown[] {
  return [
    network,
    r.address,
    r.realizedPnlAll.toString(),
    r.volumeAll.toString(),
    r.volume30d.toString(),
    r.tradeCountAll,
    r.winRateAll,
    r.totalDeposited.toString(),
    r.totalWithdrawn.toString(),
    r.totalFundingPaid.toString(),
    r.totalFeesPaid.toString(),
    r.liquidationCount,
    r.maxDrawdown.toString(),
    r.firstTradeAt,
    r.lastTradeAt,
    now,
  ];
}

/** One multi-row INSERT, chunked so a rebuild does not build a statement with 100k parameters. */
async function insertRows(q: Queryable, table: string, columns: readonly string[], rows: unknown[][]): Promise<void> {
  const perStatement = Math.max(1, Math.floor(60_000 / columns.length));
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    const params: unknown[] = [];
    const tuples = chunk.map((values) => {
      const placeholders = values.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await q.query(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES ${tuples.join(", ")}`,
      params
    );
  }
}

/**
 * Replace every rollup for `addresses` with `results`. Delete-then-insert, in
 * the caller's transaction: an address that has gone quiet loses its rows
 * (that is how an aged-out trader leaves the board), and re-running the same
 * window writes the same rows.
 */
export async function replaceAddressStats(
  q: Queryable,
  network: ArcNetworkId,
  addresses: readonly string[],
  results: readonly AddressStats[],
  now: Date
): Promise<{ traderStats: number; analytics: number }> {
  if (addresses.length === 0) return { traderStats: 0, analytics: 0 };
  const list = [...addresses];
  await q.query(`DELETE FROM "TraderStat" WHERE "network" = $1 AND "address" = ANY($2::text[])`, [network, list]);
  await q.query(`DELETE FROM "AccountAnalytics" WHERE "network" = $1 AND "address" = ANY($2::text[])`, [network, list]);
  const stats = results.flatMap((r) => r.traderStats).map((r) => traderStatValues(network, r, now));
  const analytics = results
    .map((r) => r.analytics)
    .filter((a): a is AccountAnalyticsRow => a !== null)
    .map((a) => analyticsValues(network, a, now));
  await insertRows(q, "TraderStat", TRADER_STAT_COLUMNS, stats);
  await insertRows(q, "AccountAnalytics", ANALYTICS_COLUMNS, analytics);
  return { traderStats: stats.length, analytics: analytics.length };
}

// ── reads for the nightly comparison ────────────────────────────────────────

export async function readTraderStats(q: Queryable, network: ArcNetworkId): Promise<TraderStatRow[]> {
  const rows = await q.query(
    `SELECT "address", "period", "periodStart", "realizedPnl"::text AS "realizedPnl", "volume"::text AS "volume",
            "tradeCount", "winningTrades", "losingTrades", "winRate"::text AS "winRate", "roi"::text AS "roi",
            "feesPaid"::text AS "feesPaid", "fundingPaid"::text AS "fundingPaid", "liquidationCount",
            "liquidatedVolume"::text AS "liquidatedVolume", "peakEquity"::text AS "peakEquity",
            "referralCount", "referralVolume"::text AS "referralVolume", "lastTradeAt"
     FROM "TraderStat" WHERE "network" = $1`,
    [network]
  );
  return rows.map((r) => ({
    address: String(r.address),
    period: String(r.period) as StatsPeriod,
    periodStart: new Date(r.periodStart as string),
    realizedPnl: big(r.realizedPnl),
    volume: big(r.volume),
    tradeCount: Number(r.tradeCount),
    winningTrades: Number(r.winningTrades),
    losingTrades: Number(r.losingTrades),
    winRate: String(r.winRate),
    roi: String(r.roi),
    feesPaid: big(r.feesPaid),
    fundingPaid: big(r.fundingPaid),
    liquidationCount: Number(r.liquidationCount),
    liquidatedVolume: big(r.liquidatedVolume),
    peakEquity: big(r.peakEquity),
    referralCount: Number(r.referralCount),
    referralVolume: big(r.referralVolume),
    lastTradeAt: r.lastTradeAt === null || r.lastTradeAt === undefined ? null : new Date(r.lastTradeAt as string),
  }));
}

export async function readAccountAnalytics(q: Queryable, network: ArcNetworkId): Promise<AccountAnalyticsRow[]> {
  const rows = await q.query(
    `SELECT "address", "realizedPnlAll"::text AS "realizedPnlAll", "volumeAll"::text AS "volumeAll",
            "volume30d"::text AS "volume30d", "tradeCountAll", "winRateAll"::text AS "winRateAll",
            "totalDeposited"::text AS "totalDeposited", "totalWithdrawn"::text AS "totalWithdrawn",
            "totalFundingPaid"::text AS "totalFundingPaid", "totalFeesPaid"::text AS "totalFeesPaid",
            "liquidationCount", "maxDrawdown"::text AS "maxDrawdown", "firstTradeAt", "lastTradeAt"
     FROM "AccountAnalytics" WHERE "network" = $1`,
    [network]
  );
  const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));
  return rows.map((r) => ({
    address: String(r.address),
    realizedPnlAll: big(r.realizedPnlAll),
    volumeAll: big(r.volumeAll),
    volume30d: big(r.volume30d),
    tradeCountAll: Number(r.tradeCountAll),
    winRateAll: String(r.winRateAll),
    totalDeposited: big(r.totalDeposited),
    totalWithdrawn: big(r.totalWithdrawn),
    totalFundingPaid: big(r.totalFundingPaid),
    totalFeesPaid: big(r.totalFeesPaid),
    liquidationCount: Number(r.liquidationCount),
    maxDrawdown: big(r.maxDrawdown),
    firstTradeAt: date(r.firstTradeAt),
    lastTradeAt: date(r.lastTradeAt),
  }));
}

// ── leaderboard snapshots ───────────────────────────────────────────────────

/** Sort keys, spliced into ORDER BY — only ever from this table, never from a request. */
export const SNAPSHOT_METRICS = {
  pnl: `t."realizedPnl"`,
  volume: `t."volume"`,
  roi: `t."roi"`,
} as const;
export type SnapshotMetric = keyof typeof SNAPSHOT_METRICS;

export interface RankedTrader {
  rank: number;
  address: string;
  /** The ranking metric's value, as the string form of that metric. */
  value: string;
  pnl: string;
  volume: string;
  roi: string;
  winRate: string;
}

export async function rankTraders(
  q: Queryable,
  network: ArcNetworkId,
  period: StatsPeriod,
  metric: SnapshotMetric,
  limit: number
): Promise<{ ranked: RankedTrader[]; traderCount: number }> {
  const [countRows, rows] = await Promise.all([
    q.query(`SELECT COUNT(*)::int AS "c" FROM "TraderStat" WHERE "network" = $1 AND "period" = $2::"StatsPeriod"`, [
      network,
      period,
    ]),
    q.query(
      // Ordered by the TABLE's numeric columns (`t.`), never by the ::text
      // output aliases: a query-level ORDER BY prefers the output column, and
      // "9000000" sorts above "12000000" as text.
      `SELECT t."address", t."realizedPnl"::text AS "realizedPnl", t."volume"::text AS "volume",
              t."roi"::text AS "roi", t."winRate"::text AS "winRate"
       FROM "TraderStat" t WHERE t."network" = $1 AND t."period" = $2::"StatsPeriod"
       ORDER BY ${SNAPSHOT_METRICS[metric]} DESC, t."address" ASC
       LIMIT $3`,
      [network, period, limit]
    ),
  ]);
  const ranked = rows.map((r, i) => {
    const row = {
      rank: i + 1,
      address: String(r.address),
      pnl: String(r.realizedPnl),
      volume: String(r.volume),
      roi: String(r.roi),
      winRate: String(r.winRate),
    };
    return { ...row, value: metric === "pnl" ? row.pnl : metric === "volume" ? row.volume : row.roi };
  });
  return { ranked, traderCount: Number(countRows[0]?.c ?? 0) };
}

export async function insertLeaderboardSnapshot(
  q: Queryable,
  network: ArcNetworkId,
  period: StatsPeriod,
  metric: SnapshotMetric,
  ranked: RankedTrader[],
  traderCount: number,
  capturedAt: Date
): Promise<void> {
  await q.query(
    `INSERT INTO "LeaderboardSnapshot" ("network", "period", "metric", "rankings", "traderCount", "capturedAt")
     VALUES ($1, $2::"StatsPeriod", $3, $4::jsonb, $5, $6)`,
    [network, period, metric, JSON.stringify(ranked), traderCount, capturedAt]
  );
}
