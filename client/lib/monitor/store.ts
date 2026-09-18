/**
 * Everything the monitor reads from Postgres. SELECTs only: the monitor's one
 * write is its own status snapshot (snapshot.ts), never a table another
 * service owns. In particular it does not reuse `scanUnaccountedFills`, which
 * records KeeperAction rows as a side effect.
 *
 * Timestamps come back as `Date`s and every age is computed by the caller
 * against the injected clock, so the checks are testable at any wall time.
 * Like every service, the monitor runs with TZ=UTC (node-postgres reads a
 * `timestamp` column as host-local time).
 */

import type { Address } from "viem";

import type { Queryable } from "@/lib/queries/client";

import type { ExpectedImpl } from "./roles";

const OPEN_JOB = ["PENDING", "SUBMITTED", "REPLACED"];
const TRADEABLE = ["OPEN", "PARTIALLY_FILLED"];

export interface OpenJob {
  id: string;
  service: string;
  fromAddress: string;
  nonce: number;
  label: string;
  status: string;
  createdAt: Date;
}

export interface CrossedBook {
  marketId: number;
  bestBid: bigint;
  bestAsk: bigint;
  /** When both sides of the cross were first on the book. */
  crossedSince: Date;
}

export type PendingFillKind = "in-flight" | "indexer-lag" | "not-in-receipt" | "batch-failed" | "never-submitted";

export interface PendingFill {
  fillId: string;
  marketId: number;
  kind: PendingFillKind;
  createdAt: Date;
}

export interface FundingRow {
  marketId: number;
  symbol: string;
  /** Block time of the market's latest indexed FundingUpdate; null if there is none. */
  lastAt: Date | null;
}

export interface OracleRun {
  oracleId: string;
  price: bigint;
  /** writeTime (unix s) of the first update in the current run of identical prices. */
  flatSince: number;
  updates: number;
}

export interface GovernanceRow {
  operationId: string;
  readyAt: Date;
  delaySeconds: bigint;
  description: string | null;
}

const big = (v: unknown): bigint => BigInt(String(v ?? "0").split(".")[0]);

export class MonitorStore {
  constructor(
    private readonly q: Queryable,
    readonly network: string
  ) {}

  /** Round trip in ms. */
  async ping(now: () => number): Promise<number> {
    const t0 = now();
    await this.q.query(`SELECT 1`);
    return now() - t0;
  }

  async cursor(stream: string): Promise<{ blockNumber: bigint; updatedAt: Date } | null> {
    const rows = await this.q.query(
      `SELECT "blockNumber"::text AS "blockNumber", "updatedAt" FROM "BlockCursor" WHERE "network" = $1 AND "stream" = $2`,
      [this.network, stream]
    );
    return rows.length ? { blockNumber: big(rows[0].blockNumber), updatedAt: new Date(rows[0].updatedAt as string) } : null;
  }

  /**
   * Markets whose best bid is at or above the best ask among live orders.
   * `crossedSince` is when the later of the two crossing sides arrived: the
   * earliest moment the matcher could have matched them.
   */
  async crossedBooks(nowSec: number): Promise<CrossedBook[]> {
    const rows = await this.q.query(
      `WITH live AS (
         SELECT "marketId", "isLong", "limitPrice", "createdAt" FROM "Order"
         WHERE "network" = $1 AND "status"::text = ANY($2::text[]) AND "expiry" > $3 AND "filledSize" < "size"
       ), top AS (
         SELECT "marketId",
                MAX("limitPrice") FILTER (WHERE "isLong") AS bid,
                MIN("limitPrice") FILTER (WHERE NOT "isLong") AS ask
         FROM live GROUP BY "marketId"
       )
       SELECT t."marketId", t.bid::text AS "bestBid", t.ask::text AS "bestAsk",
              GREATEST(
                (SELECT MIN(l."createdAt") FROM live l WHERE l."marketId" = t."marketId" AND l."isLong" AND l."limitPrice" >= t.ask),
                (SELECT MIN(l."createdAt") FROM live l WHERE l."marketId" = t."marketId" AND NOT l."isLong" AND l."limitPrice" <= t.bid)
              ) AS "crossedSince"
       FROM top t
       WHERE t.bid IS NOT NULL AND t.ask IS NOT NULL AND t.bid >= t.ask
       ORDER BY t."marketId"`,
      [this.network, TRADEABLE, nowSec]
    );
    return rows.map((r) => ({
      marketId: Number(r.marketId),
      bestBid: big(r.bestBid),
      bestAsk: big(r.bestAsk),
      crossedSince: new Date(r.crossedSince as string),
    }));
  }

  /**
   * PENDING fills older than `cutoff`, classified the way the reconciler
   * classifies them (lib/reconciler/fills.ts), plus `in-flight` for a fill
   * whose batch is still open.
   */
  async pendingFills(cutoff: Date, limit = 500): Promise<PendingFill[]> {
    const high = await this.q.query(
      `SELECT MAX("blockNumber")::text AS "high" FROM "Fill" WHERE "network" = $1 AND "blockNumber" IS NOT NULL`,
      [this.network]
    );
    const highWater = high[0]?.high == null ? null : big(high[0].high);
    const rows = await this.q.query(
      `SELECT f."fillId", f."marketId", f."createdAt", j."status"::text AS "jobStatus", j."blockNumber"::text AS "jobBlock"
       FROM "Fill" f
       LEFT JOIN "TxJob" j ON j."id" = f."txJobId"
       WHERE f."network" = $1 AND f."status" = 'PENDING' AND f."createdAt" < $2
       ORDER BY f."createdAt" ASC
       LIMIT $3`,
      [this.network, cutoff, limit]
    );
    return rows.map((r) => {
      const status = (r.jobStatus ?? null) as string | null;
      const jobBlock = r.jobBlock == null ? null : big(r.jobBlock);
      let kind: PendingFillKind;
      if (status === null) kind = "never-submitted";
      else if (OPEN_JOB.includes(status)) kind = "in-flight";
      else if (status !== "CONFIRMED") kind = "batch-failed";
      else if (jobBlock !== null && highWater !== null && highWater >= jobBlock) kind = "not-in-receipt";
      else kind = "indexer-lag";
      return { fillId: String(r.fillId), marketId: Number(r.marketId), kind, createdAt: new Date(r.createdAt as string) };
    });
  }

  async openJobs(): Promise<OpenJob[]> {
    const rows = await this.q.query(
      `SELECT "id", "service", lower("fromAddress") AS "fromAddress", "nonce", "label", "status"::text AS "status", "createdAt"
       FROM "TxJob"
       WHERE "network" = $1 AND "status"::text = ANY($2::text[])
       ORDER BY "fromAddress", "nonce", "createdAt"`,
      [this.network, OPEN_JOB]
    );
    return rows.map((r) => ({
      id: String(r.id),
      service: String(r.service),
      fromAddress: String(r.fromAddress),
      nonce: Number(r.nonce),
      label: String(r.label),
      status: String(r.status),
      createdAt: new Date(r.createdAt as string),
    }));
  }

  /** Fills decided (settled or rejected) since `since`, rejections grouped by reason. */
  async fillOutcomes(since: Date): Promise<{ settled: number; rejected: Map<string, number> }> {
    const rows = await this.q.query(
      `SELECT "status"::text AS "status", COALESCE("rejectReason", '') AS "rejectReason", count(*)::int AS n
       FROM "Fill"
       WHERE "network" = $1 AND "status" <> 'PENDING' AND "updatedAt" >= $2
       GROUP BY 1, 2`,
      [this.network, since]
    );
    let settled = 0;
    const rejected = new Map<string, number>();
    for (const r of rows) {
      if (r.status === "SETTLED") settled += Number(r.n);
      else {
        const cls = reasonClass(String(r.rejectReason));
        rejected.set(cls, (rejected.get(cls) ?? 0) + Number(r.n));
      }
    }
    return { settled, rejected };
  }

  /**
   * The block time of each market's latest indexed FundingUpdate. Only a
   * cross-check: the contract's own `fundingState.lastUpdate` is what funding
   * freshness is judged on, since a market's clock can start without an event.
   */
  async funding(): Promise<FundingRow[]> {
    const rows = await this.q.query(
      `SELECT m."id" AS "marketId", m."symbol",
              (SELECT e."blockTimestamp"
                 FROM "FundingUpdate" f
                 JOIN "ProtocolEvent" e
                   ON e."network" = f."network" AND e."txHash" = f."txHash" AND e."logIndex" = f."logIndex"
                WHERE f."network" = m."network" AND f."marketId" = m."id"
                ORDER BY f."blockNumber" DESC, f."logIndex" DESC
                LIMIT 1) AS "lastAt"
       FROM "Market" m
       WHERE m."network" = $1
       ORDER BY m."id"`,
      [this.network]
    );
    return rows.map((r) => ({
      marketId: Number(r.marketId),
      symbol: String(r.symbol),
      lastAt: r.lastAt == null ? null : new Date(r.lastAt as string),
    }));
  }

  /** Every trader holding a position, except `exclude` (the insurance backstop). */
  async positionHolders(exclude: string): Promise<Address[]> {
    const rows = await this.q.query(
      `SELECT DISTINCT "trader" FROM "Position" WHERE "network" = $1 AND "size" <> 0 AND "trader" <> $2 ORDER BY "trader"`,
      [this.network, exclude.toLowerCase()]
    );
    return rows.map((r) => r.trader as Address);
  }

  async positionsOf(trader: string): Promise<{ marketId: number; size: bigint; openNotional: bigint }[]> {
    const rows = await this.q.query(
      `SELECT "marketId", "size"::text AS "size", "openNotional"::text AS "openNotional"
       FROM "Position" WHERE "network" = $1 AND "trader" = $2 AND "size" <> 0 ORDER BY "marketId"`,
      [this.network, trader.toLowerCase()]
    );
    return rows.map((r) => ({ marketId: Number(r.marketId), size: big(r.size), openNotional: big(r.openNotional) }));
  }

  /** Fees accrued and gas spent per UTC day, both 1e18 USDC. */
  async feesAndGas(days: string[]): Promise<{ day: string; fees: bigint; gas: bigint }[]> {
    const rows = await this.q.query(
      `SELECT d::date::text AS "day",
              COALESCE((SELECT SUM(a."amount") FROM "FeeAccrual" a WHERE a."network" = $1 AND a."createdAt"::date = d::date), 0)::text AS fees,
              COALESCE((SELECT SUM(g."costWei") FROM "GasSpend" g WHERE g."network" = $1 AND g."day" = d::date), 0)::text AS gas
       FROM unnest($2::date[]) AS d
       ORDER BY 1`,
      [this.network, days]
    );
    return rows.map((r) => ({ day: String(r.day), fees: big(r.fees), gas: big(r.gas) }));
  }

  /**
   * What each key's next transaction may cost at most: the largest
   * gasLimit × maxFeePerGas among its recent jobs. A balance below this is a
   * key whose next send fails.
   */
  async nextTxCost(addresses: readonly string[], recent = 20): Promise<Map<string, bigint>> {
    if (addresses.length === 0) return new Map();
    const rows = await this.q.query(
      `SELECT j."fromAddress", MAX(j."gasLimit" * j."maxFeePerGas")::text AS cost
       FROM (
         SELECT lower("fromAddress") AS "fromAddress", "gasLimit", "maxFeePerGas",
                row_number() OVER (PARTITION BY lower("fromAddress") ORDER BY "createdAt" DESC) AS rn
         FROM "TxJob"
         WHERE "network" = $1 AND lower("fromAddress") = ANY($2::text[])
       ) j
       WHERE j.rn <= $3
       GROUP BY j."fromAddress"`,
      [this.network, addresses.map((a) => a.toLowerCase()), recent]
    );
    return new Map(rows.map((r) => [String(r.fromAddress), big(r.cost)]));
  }

  async pendingGovernance(): Promise<GovernanceRow[]> {
    const rows = await this.q.query(
      `SELECT "operationId", "readyAt", "delaySeconds"::text AS "delaySeconds", "description"
       FROM "GovernanceOperation"
       WHERE "network" = $1 AND "status" = 'SCHEDULED'
       ORDER BY "readyAt" ASC`,
      [this.network]
    );
    return rows.map((r) => ({
      operationId: String(r.operationId),
      readyAt: new Date(r.readyAt as string),
      delaySeconds: big(r.delaySeconds),
      description: (r.description ?? null) as string | null,
    }));
  }

  /** The active implementation recorded for each proxy (newest row wins). */
  async deploymentArtifacts(): Promise<Map<string, ExpectedImpl>> {
    const rows = await this.q.query(
      `SELECT lower("proxy") AS "proxy", lower("implementation") AS "implementation", lower("codeHash") AS "codeHash"
       FROM "DeploymentArtifact"
       WHERE "network" = $1 AND "active"
       ORDER BY "createdAt" DESC, "id" DESC`,
      [this.network]
    );
    const out = new Map<string, ExpectedImpl>();
    for (const r of rows) {
      const proxy = String(r.proxy);
      if (!out.has(proxy)) {
        out.set(proxy, { implementation: String(r.implementation), codeHash: String(r.codeHash), source: "DeploymentArtifact" });
      }
    }
    return out;
  }

  /** For each feed, its latest price and since when it has not changed. */
  async oracleRuns(): Promise<OracleRun[]> {
    const rows = await this.q.query(
      `WITH latest AS (
         SELECT DISTINCT ON ("oracleId") "oracleId", "price"
         FROM "OracleSnapshot" WHERE "network" = $1
         ORDER BY "oracleId", "writeTime" DESC, "id" DESC
       ), changed AS (
         SELECT s."oracleId", MAX(s."writeTime") AS "lastDifferent"
         FROM "OracleSnapshot" s JOIN latest l ON l."oracleId" = s."oracleId"
         WHERE s."network" = $1 AND s."price" <> l."price"
         GROUP BY s."oracleId"
       )
       SELECT l."oracleId", l."price"::text AS "price",
              MIN(s."writeTime")::text AS "flatSince", count(*)::int AS "updates"
       FROM latest l
       LEFT JOIN changed c ON c."oracleId" = l."oracleId"
       JOIN "OracleSnapshot" s
         ON s."network" = $1 AND s."oracleId" = l."oracleId" AND s."writeTime" > COALESCE(c."lastDifferent", -1)
       GROUP BY l."oracleId", l."price"`,
      [this.network]
    );
    return rows.map((r) => ({
      oracleId: String(r.oracleId),
      price: big(r.price),
      flatSince: Number(r.flatSince),
      updates: Number(r.updates),
    }));
  }
}

/** "OrderExpired(0x…)" → "OrderExpired"; empty → "unknown". */
export function reasonClass(reason: string): string {
  const name = reason.trim().split("(")[0].trim();
  return name || "unknown";
}

/** Replication lag of a read replica, in seconds; null when the server is not a replica. */
export async function replicaLagSecs(q: Queryable): Promise<number | null> {
  const rows = await q.query(
    `SELECT pg_is_in_recovery() AS replica,
            COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())), 0)::float AS lag`
  );
  return rows[0]?.replica ? Number(rows[0].lag) : null;
}
