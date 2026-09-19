/**
 * Projections: turn one stored protocol event into rows of the typed tables
 * (plan §9, §5.7). Applied inside the indexer's block-range transaction, in
 * (blockNumber, logIndex) order, both live and during a rebuild.
 *
 * Rules:
 * - Log-keyed tables insert with ON CONFLICT DO NOTHING, so applying an event
 *   twice is harmless.
 * - State tables (Market, Account, Position, Order, Fill, GovernanceOperation)
 *   are updated in event order; Position additionally ignores events older
 *   than the last one it applied.
 * - `rebuild` wipes only what events alone produce. Rows the matcher and
 *   intake API own (Order, Fill) are reset to their pre-chain state instead.
 */

import type { Query } from "./db";
import { bytes32ToString, decodeRevertReason, type ContractName, type EventArgs, type StoredEvent } from "./decode";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

type Ctx = { q: Query; ev: StoredEvent; a: EventArgs };
type Handler = (ctx: Ctx) => Promise<void>;

const s = (a: EventArgs, key: string): string => String(a[key]);
const n = (a: EventArgs, key: string): number => Number(a[key]);
const neg = (v: string): string => (v.startsWith("-") ? v.slice(1) : v === "0" ? "0" : `-${v}`);
const abs = (v: string): string => (v.startsWith("-") ? v.slice(1) : v);

function logKey(ev: StoredEvent) {
  return { network: ev.network, blockNumber: ev.blockNumber.toString(), txHash: ev.txHash, logIndex: ev.logIndex };
}

async function insertRow(q: Query, table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  await q.query(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT DO NOTHING`,
    Object.values(row)
  );
}

async function ensureAccount(q: Query, network: string, address: string): Promise<void> {
  await q.query(
    `INSERT INTO "Account" ("network", "address", "updatedAt") VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
    [network, address]
  );
}

async function pnl(
  { q, ev }: Ctx,
  address: string,
  marketId: number,
  kind: string,
  amount: string,
  size = "0",
  price = "0"
): Promise<void> {
  if (amount === "0") return;
  await insertRow(q, "PnlEvent", { ...logKey(ev), address, marketId, kind, amount, size, price });
}

/** Settled size per order from SETTLED fills; CANCELLED/EXPIRED orders keep their status. */
async function refreshOrders(q: Query, network: string, hashes: string[]): Promise<void> {
  await q.query(
    `UPDATE "Order" o SET
       "filledSize" = LEAST(o."size", f.filled),
       "status" = CASE
         WHEN o."status" IN ('CANCELLED', 'EXPIRED') THEN o."status"
         WHEN f.filled >= o."size" THEN 'FILLED'::"OrderStatus"
         WHEN f.filled > 0 THEN 'PARTIALLY_FILLED'::"OrderStatus"
         ELSE 'OPEN'::"OrderStatus" END,
       "updatedAt" = now()
     FROM (
       SELECT h AS "orderHash", COALESCE(SUM(fl."size"), 0) AS filled
       FROM unnest($2::text[]) h
       LEFT JOIN "Fill" fl ON fl."network" = $1 AND fl."status" = 'SETTLED'
         AND (fl."makerOrderHash" = h OR fl."takerOrderHash" = h)
       GROUP BY h
     ) f
     WHERE o."orderHash" = f."orderHash" AND o."network" = $1`,
    [network, hashes]
  );
}

const HANDLERS: Partial<Record<`${ContractName}.${string}`, Handler>> = {
  // ── Markets ───────────────────────────────────────────────────────────────
  "riskParams.MarketListed": async ({ q, ev, a }) => {
    const oracleId = s(a, "oracleId");
    await q.query(
      `INSERT INTO "Market" ("network", "id", "symbol", "oracleId", "updatedAt") VALUES ($1, $2, $3, $4, now())
       ON CONFLICT ("network", "id") DO UPDATE SET "oracleId" = EXCLUDED."oracleId", "updatedAt" = now()`,
      [ev.network, n(a, "marketId"), bytes32ToString(oracleId) || oracleId, oracleId]
    );
  },
  // `setMarket` stores the whole struct, `active` included, and emits only this
  // event, so it sets `Market.active` too; a later `MarketActiveSet` overrides
  // it. Applied in log order, the last of the two wins, as on chain.
  "riskParams.MarketParamsSet": async ({ q, ev, a }) => {
    const params = a.params as { active?: unknown };
    await q.query(
      `UPDATE "Market" SET "params" = $3, "active" = $4, "updatedAt" = now() WHERE "network" = $1 AND "id" = $2`,
      [ev.network, n(a, "marketId"), JSON.stringify(a.params), params.active === true]
    );
  },
  "riskParams.MarketActiveSet": async ({ q, ev, a }) => {
    await q.query(`UPDATE "Market" SET "active" = $3, "updatedAt" = now() WHERE "network" = $1 AND "id" = $2`, [
      ev.network,
      n(a, "marketId"),
      a.active === true,
    ]);
  },
  "feeRouter.MarketFeesSet": async ({ q, ev, a }) => {
    await q.query(
      `UPDATE "Market" SET "makerRate" = $3, "takerRate" = $4, "updatedAt" = now() WHERE "network" = $1 AND "id" = $2`,
      [ev.network, n(a, "marketId"), n(a, "makerRate"), n(a, "takerRate")]
    );
  },

  // ── Oracle and funding ────────────────────────────────────────────────────
  "oracleAdapter.PriceUpdated": async ({ q, ev, a }) => {
    await insertRow(q, "OracleSnapshot", {
      ...logKey(ev),
      oracleId: s(a, "id"),
      price: s(a, "price"),
      confidence: s(a, "confidence"),
      publishTime: s(a, "publishTime"),
      writeTime: s(a, "writeTime"),
      sourceCount: n(a, "sourceCount"),
    });
    await q.query(`UPDATE "Market" SET "lastIndex" = $3, "updatedAt" = now() WHERE "network" = $1 AND "oracleId" = $2`, [
      ev.network,
      s(a, "id"),
      s(a, "price"),
    ]);
  },
  "engine.FundingUpdated": async ({ q, ev, a }) => {
    const marketId = n(a, "marketId");
    const cols = ["longIndex", "shortIndex", "ratePerHour", "premium", "mark", "index"] as const;
    await insertRow(q, "FundingUpdate", { ...logKey(ev), marketId, ...Object.fromEntries(cols.map((c) => [c, s(a, c)])) });
    await q.query(
      `UPDATE "Market" SET "longFundingIndex" = $3, "shortFundingIndex" = $4, "fundingRatePerHour" = $5,
         "lastMark" = $6, "updatedAt" = now() WHERE "network" = $1 AND "id" = $2`,
      [ev.network, marketId, s(a, "longIndex"), s(a, "shortIndex"), s(a, "ratePerHour"), s(a, "mark")]
    );
  },
  "engine.FundingSettled": async (ctx) => {
    const { q, ev, a } = ctx;
    const row = { address: s(a, "trader"), marketId: n(a, "marketId"), amount: s(a, "amount") };
    await insertRow(q, "FundingPayment", { ...logKey(ev), ...row });
    await pnl(ctx, row.address, row.marketId, "FUNDING", row.amount);
  },

  // ── Positions ─────────────────────────────────────────────────────────────
  "engine.PositionChanged": async (ctx) => {
    const { q, ev, a } = ctx;
    const trader = s(a, "trader");
    const marketId = n(a, "marketId");
    await ensureAccount(q, ev.network, trader);
    const applied = await q.query(
      `INSERT INTO "Position" ("network", "trader", "marketId", "size", "openNotional", "lastPrice", "realizedPnlCum",
         "lastBlockNumber", "lastLogIndex", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT ("network", "trader", "marketId") DO UPDATE SET
         "size" = EXCLUDED."size", "openNotional" = EXCLUDED."openNotional", "lastPrice" = EXCLUDED."lastPrice",
         "realizedPnlCum" = "Position"."realizedPnlCum" + EXCLUDED."realizedPnlCum",
         "lastBlockNumber" = EXCLUDED."lastBlockNumber", "lastLogIndex" = EXCLUDED."lastLogIndex", "updatedAt" = now()
       WHERE ("Position"."lastBlockNumber", "Position"."lastLogIndex") < (EXCLUDED."lastBlockNumber", EXCLUDED."lastLogIndex")
       RETURNING 1`,
      [
        ev.network,
        trader,
        marketId,
        s(a, "size"),
        s(a, "openNotional"),
        s(a, "price"),
        s(a, "realizedPnl"),
        ev.blockNumber.toString(),
        ev.logIndex,
      ]
    );
    if (applied.length === 0) return;
    await q.query(
      `UPDATE "Market" m SET
         "longOpenInterest" = COALESCE((SELECT SUM("size") FROM "Position" WHERE "network" = $1 AND "marketId" = $2 AND "size" > 0), 0),
         "shortOpenInterest" = COALESCE((SELECT -SUM("size") FROM "Position" WHERE "network" = $1 AND "marketId" = $2 AND "size" < 0), 0),
         "updatedAt" = now()
       WHERE m."network" = $1 AND m."id" = $2`,
      [ev.network, marketId]
    );
    const reason = bytes32ToString(s(a, "reason"));
    const kind = reason === "LIQUIDATION" ? "LIQUIDATION" : reason === "ADL" ? "DELEVERAGE" : "REALIZED_TRADE";
    await pnl(ctx, trader, marketId, kind, s(a, "realizedPnl"), abs(s(a, "sizeDelta")), s(a, "price"));
  },

  // ── Orders and fills ──────────────────────────────────────────────────────
  "orderGateway.FillSettled": async ({ q, ev, a }) => {
    const row = {
      network: ev.network,
      fillId: s(a, "fillId"),
      marketId: n(a, "marketId"),
      maker: s(a, "maker"),
      taker: s(a, "taker"),
      makerOrderHash: s(a, "makerOrderHash"),
      takerOrderHash: s(a, "takerOrderHash"),
      takerIsBuy: a.takerIsBuy === true,
      size: s(a, "size"),
      price: s(a, "price"),
      makerFee: s(a, "makerFee"),
      takerFee: s(a, "takerFee"),
      makerTier: n(a, "makerTier"),
      takerTier: n(a, "takerTier"),
      blockNumber: ev.blockNumber.toString(),
      txHash: ev.txHash,
      logIndex: ev.logIndex,
    };
    const cols = Object.keys(row);
    const onChain = cols.filter((c) => !["network", "fillId"].includes(c));
    await q.query(
      `INSERT INTO "Fill" (${cols.map((c) => `"${c}"`).join(", ")}, "status", "updatedAt")
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, 'SETTLED', now())
       ON CONFLICT ("network", "fillId") DO UPDATE SET
         ${onChain.map((c) => `"${c}" = EXCLUDED."${c}"`).join(", ")},
         "status" = 'SETTLED', "rejectReason" = NULL, "updatedAt" = now()`,
      Object.values(row)
    );
    await refreshOrders(q, ev.network, [row.makerOrderHash, row.takerOrderHash]);
  },
  "orderGateway.FillRejected": async ({ q, ev, a }) => {
    // Only fills the matcher recorded can be marked; the event lacks the fill's terms.
    await q.query(
      `UPDATE "Fill" SET "status" = 'REJECTED', "rejectReason" = $3, "updatedAt" = now()
       WHERE "network" = $1 AND "fillId" = $2 AND "status" <> 'SETTLED'`,
      [ev.network, s(a, "fillId"), decodeRevertReason(s(a, "reason"))]
    );
  },
  "orderGateway.OrderCancelled": async ({ q, ev, a }) => {
    await q.query(
      `UPDATE "Order" SET "status" = 'CANCELLED', "updatedAt" = now()
       WHERE "network" = $1 AND "owner" = $2 AND "nonce" = $3 AND "status" IN ('OPEN', 'PARTIALLY_FILLED')`,
      [ev.network, s(a, "owner"), s(a, "nonce")]
    );
  },
  "orderGateway.NoncesCancelledUpTo": async ({ q, ev, a }) => {
    const owner = s(a, "owner");
    await ensureAccount(q, ev.network, owner);
    await q.query(
      `UPDATE "Account" SET "minValidNonce" = GREATEST("minValidNonce", $3), "updatedAt" = now()
       WHERE "network" = $1 AND "address" = $2`,
      [ev.network, owner, s(a, "minNonce")]
    );
    await q.query(
      `UPDATE "Order" SET "status" = 'CANCELLED', "updatedAt" = now()
       WHERE "network" = $1 AND "owner" = $2 AND "nonce" < $3 AND "status" IN ('OPEN', 'PARTIALLY_FILLED')`,
      [ev.network, owner, s(a, "minNonce")]
    );
  },

  // ── Vault balances ────────────────────────────────────────────────────────
  "vault.Deposited": async ({ q, ev, a }) => {
    await insertRow(q, "BalanceChange", {
      ...logKey(ev),
      address: s(a, "account"),
      kind: "DEPOSIT",
      counterparty: s(a, "payer"),
      amount: s(a, "amount"),
      internalAmount: s(a, "internalAmount"),
    });
  },
  "vault.Withdrawn": async ({ q, ev, a }) => {
    await insertRow(q, "BalanceChange", {
      ...logKey(ev),
      address: s(a, "account"),
      kind: "WITHDRAWAL",
      counterparty: s(a, "to"),
      amount: s(a, "amount"),
      internalAmount: s(a, "internalAmount"),
    });
  },
  "vault.InternalTransfer": async ({ q, ev, a }) => {
    let [from, to, amount] = [s(a, "from"), s(a, "to"), s(a, "amount")];
    if (amount.startsWith("-")) [from, to, amount] = [to, from, abs(amount)];
    const reason = s(a, "reason");
    await insertRow(q, "BalanceChange", { ...logKey(ev), address: from, kind: "TRANSFER_OUT", counterparty: to, internalAmount: amount, reason });
    await insertRow(q, "BalanceChange", { ...logKey(ev), address: to, kind: "TRANSFER_IN", counterparty: from, internalAmount: amount, reason });
  },

  // ── Liquidation, ADL, backstop ────────────────────────────────────────────
  "liquidation.Liquidated": async (ctx) => {
    const { q, ev, a } = ctx;
    const cols = ["closeSize", "price", "realizedPnl", "penalty", "reward", "equityBefore", "equityAfter"];
    await insertRow(q, "LiquidationEvent", {
      ...logKey(ev),
      trader: s(a, "trader"),
      liquidator: s(a, "liquidator"),
      marketId: n(a, "marketId"),
      ...Object.fromEntries(cols.map((c) => [c, s(a, c)])),
    });
    // realizedPnl is already recorded from the Engine's PositionChanged.
    await pnl(ctx, s(a, "trader"), n(a, "marketId"), "LIQUIDATION_PENALTY", neg(s(a, "penalty")));
  },
  "liquidation.Deleveraged": async ({ q, ev, a }) => {
    const cols = ["closeSize", "price", "realizedPnl", "haircut"];
    await insertRow(q, "DeleverageEvent", {
      ...logKey(ev),
      counterparty: s(a, "counterparty"),
      keeper: s(a, "keeper"),
      marketId: n(a, "marketId"),
      ...Object.fromEntries(cols.map((c) => [c, s(a, c)])),
    });
  },
  "insurance.BackstopUnwound": async ({ q, ev, a }) => {
    const cols = ["size", "price", "notional", "dayTotal"];
    await insertRow(q, "BackstopUnwind", {
      ...logKey(ev),
      marketId: n(a, "marketId"),
      ...Object.fromEntries(cols.map((c) => [c, s(a, c)])),
    });
  },

  // ── Fees ──────────────────────────────────────────────────────────────────
  "feeRouter.FeeAccrued": async (ctx) => {
    const { q, ev, a } = ctx;
    const referrer = s(a, "referrer");
    const cols = ["amount", "toTreasury", "toInsurance", "toReferral"];
    await insertRow(q, "FeeAccrual", {
      ...logKey(ev),
      marketId: n(a, "marketId"),
      payer: s(a, "payer"),
      referrer: referrer === ZERO_ADDRESS ? null : referrer,
      ...Object.fromEntries(cols.map((c) => [c, s(a, c)])),
    });
    // A negative fee is a rebate, i.e. a credit.
    await pnl(ctx, s(a, "payer"), n(a, "marketId"), "FEE", neg(s(a, "amount")));
  },
  "feeRouter.FeeClaimed": async ({ q, ev, a }) => {
    await insertRow(q, "FeeClaim", {
      ...logKey(ev),
      bucket: s(a, "bucket"),
      recipient: s(a, "recipient"),
      amount: s(a, "amount"),
      internalAmount: s(a, "internalAmount"),
    });
  },
  "feeRouter.FeeTierSet": async ({ q, ev, a }) => {
    const address = s(a, "account");
    await insertRow(q, "FeeTierAssignment", { ...logKey(ev), address, tier: n(a, "tier") });
    await ensureAccount(q, ev.network, address);
    await q.query(`UPDATE "Account" SET "feeTier" = $3, "updatedAt" = now() WHERE "network" = $1 AND "address" = $2`, [
      ev.network,
      address,
      n(a, "tier"),
    ]);
  },

  // ── Governance (OZ TimelockController) ────────────────────────────────────
  "timelock.CallScheduled": async ({ q, ev, a }) => {
    const call = { index: n(a, "index"), target: s(a, "target"), value: s(a, "value"), data: s(a, "data") };
    const readyAt = new Date(ev.blockTimestamp.getTime() + Number(s(a, "delay")) * 1000);
    // Index 0 starts a (re)schedule: OZ allows reusing an id after cancellation.
    await q.query(
      `INSERT INTO "GovernanceOperation" ("network", "operationId", "predecessor", "salt", "calls", "delaySeconds",
         "readyAt", "status", "scheduledTxHash", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'SCHEDULED', $8, now())
       ON CONFLICT ("network", "operationId") DO UPDATE SET
         "calls" = CASE WHEN $9 THEN EXCLUDED."calls" ELSE "GovernanceOperation"."calls" || EXCLUDED."calls" END,
         "predecessor" = EXCLUDED."predecessor", "delaySeconds" = EXCLUDED."delaySeconds", "readyAt" = EXCLUDED."readyAt",
         "status" = 'SCHEDULED', "scheduledTxHash" = EXCLUDED."scheduledTxHash",
         "salt" = CASE WHEN $9 THEN EXCLUDED."salt" ELSE "GovernanceOperation"."salt" END,
         "executedTxHash" = CASE WHEN $9 THEN NULL ELSE "GovernanceOperation"."executedTxHash" END,
         "cancelledTxHash" = CASE WHEN $9 THEN NULL ELSE "GovernanceOperation"."cancelledTxHash" END,
         "updatedAt" = now()`,
      [
        ev.network,
        s(a, "id"),
        s(a, "predecessor"),
        ZERO_BYTES32,
        JSON.stringify([call]),
        s(a, "delay"),
        readyAt,
        ev.txHash,
        call.index === 0,
      ]
    );
  },
  "timelock.CallSalt": async ({ q, ev, a }) => {
    await q.query(
      `UPDATE "GovernanceOperation" SET "salt" = $3, "updatedAt" = now() WHERE "network" = $1 AND "operationId" = $2`,
      [ev.network, s(a, "id"), s(a, "salt")]
    );
  },
  "timelock.CallExecuted": async ({ q, ev, a }) => {
    await q.query(
      `UPDATE "GovernanceOperation" SET "status" = 'EXECUTED', "executedTxHash" = $3, "updatedAt" = now()
       WHERE "network" = $1 AND "operationId" = $2`,
      [ev.network, s(a, "id"), ev.txHash]
    );
  },
  "timelock.Cancelled": async ({ q, ev, a }) => {
    await q.query(
      `UPDATE "GovernanceOperation" SET "status" = 'CANCELLED', "cancelledTxHash" = $3, "updatedAt" = now()
       WHERE "network" = $1 AND "operationId" = $2`,
      [ev.network, s(a, "id"), ev.txHash]
    );
  },
};

/** Apply one event. Events without a handler are only kept in ProtocolEvent. */
export async function applyEvent(q: Query, contract: ContractName | undefined, ev: StoredEvent): Promise<boolean> {
  const handler = contract ? HANDLERS[`${contract}.${ev.eventName}`] : undefined;
  if (!handler) return false;
  await handler({ q, ev, a: ev.args });
  return true;
}

/** Tables produced purely from events; a rebuild deletes and replays them. */
export const DERIVED_TABLES = [
  "OracleSnapshot",
  "FundingUpdate",
  "FundingPayment",
  "LiquidationEvent",
  "DeleverageEvent",
  "BackstopUnwind",
  "FeeAccrual",
  "FeeClaim",
  "FeeTierAssignment",
  "BalanceChange",
  "PnlEvent",
  "Position",
  "GovernanceOperation",
] as const;

/** Reset every event-derived value for one network, ready for a replay. */
export async function resetProjections(q: Query, network: string): Promise<void> {
  for (const table of DERIVED_TABLES) await q.query(`DELETE FROM "${table}" WHERE "network" = $1`, [network]);
  // Fills with no matcher-side order (created by the indexer) are recreated on replay.
  await q.query(
    `UPDATE "Fill" SET "status" = 'PENDING', "rejectReason" = NULL, "blockNumber" = NULL, "txHash" = NULL,
       "logIndex" = NULL, "updatedAt" = now() WHERE "network" = $1`,
    [network]
  );
  await q.query(
    `UPDATE "Order" SET "filledSize" = 0, "status" = CASE WHEN "status" IN ('PARTIALLY_FILLED', 'FILLED') THEN 'OPEN'::"OrderStatus" ELSE "status" END,
       "updatedAt" = now() WHERE "network" = $1`,
    [network]
  );
  await q.query(
    `UPDATE "Account" SET "feeTier" = 0, "minValidNonce" = 0, "updatedAt" = now() WHERE "network" = $1`,
    [network]
  );
  await q.query(
    `UPDATE "Market" SET "active" = false, "params" = '{}', "makerRate" = 0, "takerRate" = 0, "lastMark" = 0,
       "lastIndex" = 0, "longFundingIndex" = 0, "shortFundingIndex" = 0, "fundingRatePerHour" = 0,
       "longOpenInterest" = 0, "shortOpenInterest" = 0, "updatedAt" = now() WHERE "network" = $1`,
    [network]
  );
}
