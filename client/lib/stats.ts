// Trading-stats domain logic: realized-PnL computation and the DB writers that
// feed the leaderboard + portfolio tables. Pure functions are unit-testable;
// the writers take a Neon `sql` client so they work from scripts and routes.
//
// Precision: prices are 1e18, sizes/amounts are 1e7, monetary results are 1e7.
//
// NOT CURRENTLY WIRED. `recordFillPnl` is the only producer of `PnlEvent` rows
// anywhere in the repo, and nothing calls it — so the realized-PnL, fee and
// win/loss columns that `scripts/stats-aggregator.ts` reads out of `PnlEvent`
// are permanently zero on the leaderboard and portfolio pages. This file is
// kept deliberately: it is the intended implementation, and deleting it would
// only make the gap harder to close. Wiring it into the matcher's settlement
// path writes financial rows on every fill, so it is a deliberate change, not
// a cleanup.

import { NETWORK, PRICE_PRECISION } from "@/config";

export interface RawPos {
  marketId: number;
  isLong: boolean;
  size: bigint;        // 1e7
  entryPrice: bigint;  // 1e18
}

/**
 * Realized PnL (1e7) booked when `fillSize` of a trade in `fillIsLong`
 * direction settles against the account's existing positions.
 *
 * Only the portion that *reduces* an opposite-side position realizes PnL:
 *   long close:  size * (exit - entry) / 1e18
 *   short close: size * (entry - exit) / 1e18
 * The residual that opens/increases a position realizes nothing.
 */
export function realizedPnlForFill(
  positions: RawPos[],
  marketId: number,
  fillIsLong: boolean,
  fillSize: bigint,
  fillPrice: bigint
): bigint {
  const opposite = positions.find(
    (p) => p.marketId === marketId && p.isLong !== fillIsLong && p.size > 0n
  );
  if (!opposite) return 0n;
  const closeSize = opposite.size < fillSize ? opposite.size : fillSize;
  if (closeSize <= 0n) return 0n;
  // opposite is LONG when the incoming fill is SHORT → long PnL = exit-entry
  const priceDelta = opposite.isLong
    ? fillPrice - opposite.entryPrice
    : opposite.entryPrice - fillPrice;
  return (closeSize * priceDelta) / PRICE_PRECISION;
}

/** Notional value (1e7) of a fill: size(1e7) * price(1e18) / 1e18. */
export function notional1e7(size: bigint, price: bigint): bigint {
  return (size * price) / PRICE_PRECISION;
}

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * Record the per-account effects of a settled fill: a REALIZED_TRADE PnlEvent
 * for each side that closed exposure, plus a FEE event. Idempotent via the
 * (network,address,kind,refKey) unique index.
 */
export async function recordFillPnl(
  sql: Sql,
  args: {
    marketId: number;
    txHash: string;
    ledger: number;
    fillSize: bigint;
    fillPrice: bigint;
    maker: { address: string; isLong: boolean; positionsBefore: RawPos[]; fee: bigint };
    taker: { address: string; isLong: boolean; positionsBefore: RawPos[]; fee: bigint };
  }
): Promise<void> {
  const sides = [
    { who: args.maker, tag: "maker" },
    { who: args.taker, tag: "taker" },
  ];

  for (const { who, tag } of sides) {
    const realized = realizedPnlForFill(
      who.positionsBefore, args.marketId, who.isLong, args.fillSize, args.fillPrice
    );
    const refKey = `${args.txHash}:${tag}`;

    if (realized !== 0n) {
      await sql`
        INSERT INTO "PnlEvent" (network, address, "marketId", kind, amount, size, price, ledger, "txHash", "refKey")
        VALUES (${NETWORK.name}, ${who.address}, ${args.marketId}, 'REALIZED_TRADE',
                ${realized.toString()}, ${args.fillSize.toString()}, ${args.fillPrice.toString()},
                ${args.ledger}, ${args.txHash}, ${refKey})
        ON CONFLICT (network, address, kind, "refKey") DO NOTHING
      `;
    }
    if (who.fee > 0n) {
      await sql`
        INSERT INTO "PnlEvent" (network, address, "marketId", kind, amount, size, price, ledger, "txHash", "refKey")
        VALUES (${NETWORK.name}, ${who.address}, ${args.marketId}, 'FEE',
                ${(-who.fee).toString()}, '0', ${args.fillPrice.toString()},
                ${args.ledger}, ${args.txHash}, ${`${refKey}:fee`})
        ON CONFLICT (network, address, kind, "refKey") DO NOTHING
      `;
    }
  }
}

/** Rolling-window cutoff for a stats period. */
export function periodStart(period: "DAY" | "WEEK" | "MONTH" | "ALL"): Date {
  const now = Date.now();
  switch (period) {
    case "DAY":   return new Date(now - 24 * 3600 * 1000);
    case "WEEK":  return new Date(now - 7 * 24 * 3600 * 1000);
    case "MONTH": return new Date(now - 30 * 24 * 3600 * 1000);
    case "ALL":   return new Date(0);
  }
}
