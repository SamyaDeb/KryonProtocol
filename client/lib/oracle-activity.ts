/**
 * oracle-activity.ts — shared "does the protocol need fresh prices?" check,
 * used by the oracle keeper (publish gating) and the monitor (so the
 * freshness alert understands deliberate idleness).
 *
 * The protocol needs a fresh on-chain price whenever ANY of:
 *   1. an order is resting/unfilled (matcher band check),
 *   2. a settlement TxJob is in flight (executes against the oracle),
 *   3. any position is open (funding accrual + liquidation scanning),
 *   4. the vault holds deposits (withdrawal health checks read the oracle —
 *      a dormant depositor must always be able to exit).
 *
 * Every check FAILS OPEN: an unreachable DB or RPC reports "active" so an
 * infra outage can never silently stale the oracle while funds are at stake.
 */

import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  scValToNative,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { ASSETS, CONTRACTS, NETWORK } from "../config";

type NeonSql = (strings: TemplateStringsArray, ...params: unknown[]) => Promise<Record<string, unknown>[]>;

export interface ActivityStatus {
  active: boolean;
  reasons: string[];
}

/** DB-side signals: open orders, in-flight settlements, open positions. */
async function dbSignals(sql: NeonSql): Promise<string[]> {
  const reasons: string[] = [];
  const nowSecs = Math.floor(Date.now() / 1000);
  try {
    const orders = await sql`
      SELECT 1 FROM "Order"
      WHERE cancelled = false
        AND CAST("filledSize" AS NUMERIC) < CAST(size AS NUMERIC)
        AND "expiryTs" > ${nowSecs}
      LIMIT 1`;
    if (orders.length > 0) reasons.push("open-orders");
  } catch (e) {
    reasons.push(`order-check-error:${(e as Error).message?.slice(0, 40)}`);
  }
  try {
    const jobs = await sql`
      SELECT 1 FROM "TxJob" WHERE status IN ('QUEUED', 'SUBMITTED') LIMIT 1`;
    if (jobs.length > 0) reasons.push("pending-settlements");
  } catch (e) {
    reasons.push(`txjob-check-error:${(e as Error).message?.slice(0, 40)}`);
  }
  try {
    const positions = await sql`
      SELECT 1 FROM "Position" WHERE CAST(size AS NUMERIC) <> 0 LIMIT 1`;
    if (positions.length > 0) reasons.push("open-positions");
  } catch (e) {
    reasons.push(`position-check-error:${(e as Error).message?.slice(0, 40)}`);
  }
  return reasons;
}

/** On-chain signal: vault.total_deposited(USDC) > 0, via free simulated read. */
async function vaultDepositsSignal(server: sorobanRpc.Server): Promise<string[]> {
  try {
    // Read-only simulation: a synthetic account with a fake sequence is enough.
    const account = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: NETWORK.passphrase,
    })
      .addOperation(
        new Contract(CONTRACTS.vault).call(
          "total_deposited",
          new Address(ASSETS.usdc).toScVal()
        )
      )
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(sim)) {
      return [`vault-check-error:${sim.error?.slice(0, 40)}`];
    }
    const retval = (sim as sorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    const total = retval ? (scValToNative(retval) as bigint) : 0n;
    return total > 0n ? ["vault-deposits"] : [];
  } catch (e) {
    return [`vault-check-error:${(e as Error).message?.slice(0, 40)}`];
  }
}

/**
 * True activity check. Any reason string containing "-error" means a signal
 * source was unreachable — treated as active (fail-open).
 */
export async function checkProtocolActivity(
  sql: NeonSql,
  server: sorobanRpc.Server
): Promise<ActivityStatus> {
  const reasons = [
    ...(await dbSignals(sql)),
    ...(await vaultDepositsSignal(server)),
  ];
  return { active: reasons.length > 0, reasons };
}
