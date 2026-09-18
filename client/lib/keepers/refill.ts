/**
 * keeper-refill: keep every service key's gas balance above a floor.
 *
 * On Arc the gas token is USDC, so a top-up is a plain native transfer from a
 * funder key; there is no swap step. An unattended keeper with an empty gas
 * balance does not crash, it just stops getting transactions included, which
 * for the oracle publisher means stale prices and a halted protocol. This
 * closes that loop.
 *
 * Safety:
 *   - The funder knows target *addresses*, never their keys.
 *   - Top up to `target` only when below `floor`, so a healthy key costs nothing.
 *   - Two caps: per run, and per target per UTC day (counted from this
 *     service's own CONFIRMED and SUBMITTED KeeperAction rows, so a transfer
 *     whose confirmation timed out still counts against the allowance). A runaway keeper burning gas
 *     in a loop gets its daily allowance and then an alert, not the treasury.
 *   - Dry run unless `execute` is set.
 *
 * Idempotency: each top-up is decided from the target's live balance. A
 * transfer that is still in flight has not raised that balance yet, so the
 * next run would send again; the in-flight guard (runtime.stillInFlight)
 * prevents that, exactly as for the liquidator.
 */

import type { Address, PublicClient } from "viem";

import type { TxJob } from "@/lib/chain/tx-store";
import type { TxOutcome, TxRequest } from "@/lib/chain/tx-sender";
import type { SqlClient } from "@/lib/sql";

import { errorMessage, stillInFlight, utcDay, type KeeperActions, type Logger, type Metrics } from "./runtime";

export const USDC18 = 10n ** 18n;

export interface RefillTarget {
  name: string;
  address: Address;
}

/** "oracle-1:0xabc...,funding:0xdef..." */
export function parseTargets(raw: string | undefined): RefillTarget[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, address] = entry.split(":").map((x) => x.trim());
      if (!name || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new Error(`REFILL_TARGETS entry "${entry}" is not name:0xaddress`);
      }
      return { name, address: address as Address };
    });
}

export interface RefillPolicy {
  floor: bigint;
  target: bigint;
  maxPerRun: bigint;
  maxPerTargetPerDay: bigint;
  /** Alert when the funder itself falls below this. */
  funderAlert: bigint;
}

export type RefillPlan =
  | { name: string; address: Address; action: "ok"; balance: bigint }
  | { name: string; address: Address; action: "top-up"; balance: bigint; amount: bigint }
  | { name: string; address: Address; action: "capped"; balance: bigint; wanted: bigint; reason: "run" | "day" | "funder" };

/** Pure: who gets what, most depleted first, within every cap. */
export function planRefills(
  targets: readonly (RefillTarget & { balance: bigint; spentToday: bigint })[],
  funderBalance: bigint,
  p: RefillPolicy
): RefillPlan[] {
  if (p.target <= p.floor) throw new Error("refill target must be above the floor");
  let runLeft = p.maxPerRun;
  // Keep enough for the funder's own gas.
  let funderLeft = funderBalance > USDC18 ? funderBalance - USDC18 : 0n;
  const ordered = [...targets].sort((a, b) => (a.balance < b.balance ? -1 : a.balance > b.balance ? 1 : 0));
  return ordered.map((t): RefillPlan => {
    if (t.balance >= p.floor) return { name: t.name, address: t.address, action: "ok", balance: t.balance };
    const wanted = p.target - t.balance;
    const dayLeft = p.maxPerTargetPerDay > t.spentToday ? p.maxPerTargetPerDay - t.spentToday : 0n;
    const amount = [wanted, dayLeft, runLeft, funderLeft].reduce((m, v) => (v < m ? v : m));
    if (amount <= 0n) {
      const reason = dayLeft <= 0n ? "day" : runLeft <= 0n ? "run" : "funder";
      return { name: t.name, address: t.address, action: "capped", balance: t.balance, wanted, reason };
    }
    runLeft -= amount;
    funderLeft -= amount;
    return { name: t.name, address: t.address, action: "top-up", balance: t.balance, amount };
  });
}

export interface RefillSender {
  readonly address: Address;
  submit(req: TxRequest): Promise<TxJob>;
  wait(job: TxJob): Promise<TxOutcome>;
  openJobs(): Promise<TxJob[]>;
}

export interface RefillOptions {
  client: Pick<PublicClient, "getBalance">;
  sender: RefillSender;
  sql: SqlClient;
  network: string;
  targets: readonly RefillTarget[];
  policy: RefillPolicy;
  execute: boolean;
  log: Logger;
  metrics: Metrics;
  actions: KeeperActions;
  now?: () => Date;
}

export async function refillOnce(o: RefillOptions): Promise<{ plans: RefillPlan[]; sent: string[] }> {
  const { log, metrics } = o;
  if (o.execute && (await stillInFlight(o.sender, log))) return { plans: [], sent: [] };

  const today = utcDay((o.now ?? (() => new Date()))());
  const spent = (await o.sql.query(
    `SELECT lower("account") AS a, COALESCE(SUM(("payload"->>'amount')::numeric), 0)::text AS s
     FROM "KeeperAction"
     WHERE "network" = $1 AND "kind" = 'refill.top-up' AND "status"::text IN ('CONFIRMED', 'SUBMITTED')
       AND "updatedAt" >= $2::date AND "updatedAt" < $2::date + 1
     GROUP BY 1`,
    [o.network, today]
  )) as { a: string; s: string }[];
  const spentBy = new Map(spent.map((r) => [r.a, BigInt(r.s.split(".")[0])]));

  const funder = await o.client.getBalance({ address: o.sender.address });
  metrics.gauge("refill_funder_balance_usdc", Number(funder / 10n ** 12n) / 1e6);
  if (funder < o.policy.funderAlert) {
    log.error("refill funder is low: service keys will stop being topped up", { alert: true, funder: o.sender.address, balance: funder });
  }

  const withBalances = await Promise.all(
    o.targets.map(async (t) => {
      const balance = await o.client.getBalance({ address: t.address });
      metrics.gauge(`refill_target_balance_usdc.${t.name}`, Number(balance / 10n ** 12n) / 1e6);
      return { ...t, balance, spentToday: spentBy.get(t.address.toLowerCase()) ?? 0n };
    })
  );
  const plans = planRefills(withBalances, funder, o.policy);
  const sent: string[] = [];

  for (const p of plans) {
    if (p.action === "capped") {
      metrics.inc(`refill_capped_total.${p.reason}`);
      log.error("service key below its gas floor and refill is capped", {
        alert: true,
        target: p.name,
        address: p.address,
        balance: p.balance,
        wanted: p.wanted,
        cap: p.reason,
      });
      continue;
    }
    if (p.action !== "top-up") continue;
    if (!o.execute) {
      log.info("dry run: would top up", { target: p.name, address: p.address, balance: p.balance, amount: p.amount });
      continue;
    }
    const id = await o.actions.record({
      kind: "refill.top-up",
      account: p.address,
      payload: { target: p.name, balance: p.balance, amount: p.amount },
    });
    let job: TxJob;
    try {
      job = await o.sender.submit({ to: p.address, data: "0x", value: p.amount, gas: 21_000n, label: `refill ${p.name}` });
    } catch (err) {
      await o.actions.update(id, { status: "FAILED", payload: { target: p.name, amount: p.amount, error: errorMessage(err) } });
      log.error("top-up failed", { target: p.name, error: errorMessage(err) });
      continue;
    }
    await o.actions.update(id, { status: "SUBMITTED", txJobId: job.id });
    try {
      const out = await o.sender.wait(job);
      const ok = out.receipt.status === "success";
      await o.actions.update(id, { status: ok ? "CONFIRMED" : "FAILED", blockNumber: out.receipt.blockNumber });
      if (ok) {
        sent.push(p.name);
        metrics.inc(`refill_topups_total.${p.name}`);
        log.info("topped up", { target: p.name, address: p.address, amount: p.amount });
      }
    } catch (err) {
      // Possibly still landing: stays SUBMITTED, and the in-flight guard stops a second send.
      log.warn("top-up not confirmed in time", { target: p.name, error: errorMessage(err) });
    }
  }
  return { plans, sent };
}
