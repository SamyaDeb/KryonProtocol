/**
 * "Does the protocol need fresh prices right now?" — the shared check behind
 * the oracle publisher's idle gating and the monitor's freshness alert, so a
 * deliberately idle feed is not reported as a broken one.
 *
 * The protocol needs a fresh on-chain price whenever ANY of:
 *   1. an order is working (the matcher's band check reads the oracle),
 *   2. a settlement transaction is in flight (it executes against the oracle),
 *   3. any position is open (funding accrual and liquidation scanning),
 *   4. the vault holds collateral — a withdrawal's health check reads the
 *      oracle, so a dormant depositor must always be able to exit.
 *
 * All four are answered from the indexer's projections: `Account.ledgerBalance`
 * is the vault ledger as of the last indexed block, so the previous chain
 * deployment's simulated `total_deposited` call is no longer needed.
 *
 * Every check FAILS OPEN. An unreachable database reports "active", so an
 * infrastructure outage can never quietly stale the oracle while funds are at
 * stake. A reason containing "-error" is how a caller tells a real signal from
 * an unanswered one.
 */

import type { ArcNetworkId } from "@/lib/network";
import type { Queryable } from "@/lib/queries/client";

export interface ActivityStatus {
  active: boolean;
  reasons: string[];
}

interface Signal {
  reason: string;
  sql: string;
  params: (network: ArcNetworkId, nowSec: bigint) => unknown[];
}

const SIGNALS: Signal[] = [
  {
    reason: "open-orders",
    sql: `SELECT 1 FROM "Order"
          WHERE "network" = $1 AND "status" = ANY('{OPEN,PARTIALLY_FILLED}'::"OrderStatus"[]) AND "expiry" > $2
          LIMIT 1`,
    params: (network, nowSec) => [network, nowSec.toString()],
  },
  {
    reason: "pending-settlements",
    sql: `SELECT 1 FROM "TxJob" WHERE "network" = $1 AND "status" IN ('PENDING', 'SUBMITTED', 'REPLACED') LIMIT 1`,
    params: (network) => [network],
  },
  {
    reason: "open-positions",
    sql: `SELECT 1 FROM "Position" WHERE "network" = $1 AND "size" <> 0 LIMIT 1`,
    params: (network) => [network],
  },
  {
    reason: "vault-deposits",
    sql: `SELECT 1 FROM "Account" WHERE "network" = $1 AND "ledgerBalance" > 0 LIMIT 1`,
    params: (network) => [network],
  },
];

/** Whether anything on `network` still depends on a fresh price. */
export async function checkProtocolActivity(
  q: Queryable,
  network: ArcNetworkId,
  nowSec: bigint = BigInt(Math.floor(Date.now() / 1000))
): Promise<ActivityStatus> {
  const reasons: string[] = [];
  for (const signal of SIGNALS) {
    try {
      const rows = await q.query(signal.sql, signal.params(network, nowSec));
      if (rows.length > 0) reasons.push(signal.reason);
    } catch (e) {
      reasons.push(`${signal.reason}-error:${(e as Error).message?.slice(0, 40)}`);
    }
  }
  return { active: reasons.length > 0, reasons };
}
