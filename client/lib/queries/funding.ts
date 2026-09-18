/**
 * Typed read helpers for `FundingPayment` (from `Engine.FundingSettled`).
 * Amounts are 1e18, signed: positive means the account received funding.
 *
 * Server-side only.
 */

import type { ArcNetworkId } from "@/lib/network";
import type { Queryable } from "./client";
import { big } from "./scalars";

export interface FundingPaymentView {
  marketId: number;
  /** 1e18, signed (positive = received). */
  amount: bigint;
  txHash: string;
  blockNumber: bigint;
  createdAt: Date;
}

export async function listFundingPayments(
  q: Queryable,
  network: ArcNetworkId,
  address: string,
  limit: number
): Promise<FundingPaymentView[]> {
  const rows = await q.query(
    `SELECT "marketId", "amount"::text AS "amount", "txHash", "blockNumber"::text AS "blockNumber", "createdAt"
     FROM "FundingPayment"
     WHERE "network" = $1 AND "address" = $2
     ORDER BY "createdAt" DESC, "id" DESC
     LIMIT $3`,
    [network, address, limit]
  );
  return rows.map((r) => ({
    marketId: Number(r.marketId),
    amount: big(r.amount),
    txHash: String(r.txHash),
    blockNumber: big(r.blockNumber),
    createdAt: new Date(r.createdAt as string),
  }));
}
