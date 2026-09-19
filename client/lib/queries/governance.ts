/**
 * Typed read helpers for `GovernanceOperation` (the indexer's projection of
 * KryonTimelock `CallScheduled` / `CallExecuted` / `Cancelled`). Every change
 * to a live parameter or implementation passes through this queue with at
 * least 48 hours' notice, which is what the transparency page shows.
 *
 * Server-side only.
 */

import type { ArcNetworkId } from "@/lib/network";
import type { Queryable } from "./client";
import { big } from "./scalars";

export type GovernanceStatus = "SCHEDULED" | "EXECUTED" | "CANCELLED";

export interface GovernanceCall {
  target: string;
  value: string;
  data: string;
}

export interface GovernanceOperationView {
  operationId: string;
  status: GovernanceStatus;
  calls: GovernanceCall[];
  delaySeconds: bigint;
  readyAt: Date;
  description: string | null;
  scheduledTxHash: string;
  executedTxHash: string | null;
  cancelledTxHash: string | null;
  createdAt: Date;
}

/** Pending operations first (soonest ready first), then the most recent others. */
export async function listGovernanceOperations(
  q: Queryable,
  network: ArcNetworkId,
  limit: number
): Promise<GovernanceOperationView[]> {
  const rows = await q.query(
    `SELECT "operationId", "status"::text AS "status", "calls", "delaySeconds"::text AS "delaySeconds", "readyAt",
            "description", "scheduledTxHash", "executedTxHash", "cancelledTxHash", "createdAt"
     FROM "GovernanceOperation"
     WHERE "network" = $1
     ORDER BY ("status" = 'SCHEDULED') DESC,
              CASE WHEN "status" = 'SCHEDULED' THEN "readyAt" END ASC,
              "createdAt" DESC
     LIMIT $2`,
    [network, limit]
  );
  return rows.map((r) => ({
    operationId: String(r.operationId),
    status: String(r.status) as GovernanceStatus,
    calls: (Array.isArray(r.calls) ? r.calls : []) as GovernanceCall[],
    delaySeconds: big(r.delaySeconds),
    readyAt: new Date(r.readyAt as string),
    description: r.description === null ? null : String(r.description),
    scheduledTxHash: String(r.scheduledTxHash),
    executedTxHash: r.executedTxHash === null ? null : String(r.executedTxHash),
    cancelledTxHash: r.cancelledTxHash === null ? null : String(r.cancelledTxHash),
    createdAt: new Date(r.createdAt as string),
  }));
}
