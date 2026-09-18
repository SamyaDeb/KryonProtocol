/**
 * Liquidation and ADL keeper.
 *
 * One tick:
 *   1. Idle if Engine, Liquidation or Insurance is paused: every call would
 *      revert, and a keeper that burns gas on guaranteed reverts drains its key.
 *   2. Send nothing new while one of this key's transactions is still in
 *      flight (runtime.stillInFlight). A liquidation is not idempotent against
 *      an account still under water: a second send is a second penalty.
 *   3. Candidates: every trader with an open position in the indexer's
 *      `Position` table. Health via Multicall3 in batches of 200. An account
 *      whose health read fails holds a market with an unusable price: it is
 *      reported as blocked on the oracle, not retried in a loop.
 *   4. Liquidate the most under-water first (largest maintenance shortfall),
 *      at most `maxAccountsPerTick`. The contract sizes each step; after each
 *      one the keeper re-reads health and continues only while the account is
 *      still liquidatable.
 *   5. ADL, one step per tick, only while `Insurance.unfundedShortfall() > 0`,
 *      against the opposite-side position with the largest unrealized profit.
 *      `unfundedShortfall` reverting StaleOracle is "blocked", never zero.
 *   6. `settleBadDebt` for closed-out accounts with a negative balance that
 *      operating capital can now cover (or whose record is out of date).
 *   7. Reconcile confirmed actions against the indexer's LiquidationEvent /
 *      DeleverageEvent rows and report any the indexer has not written.
 *
 * Every decision is re-derived from chain state each tick; nothing is resent
 * from a job record. See docs/engineering/KEEPER_IDEMPOTENCY.md §4.
 */

import {
  decodeEventLog,
  encodeFunctionData,
  maxUint256,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";

import { engineAbi, insuranceAbi, liquidationAbi, vaultAbi } from "@/lib/chain/contracts";
import { readAccountHealth, type AccountHealth } from "@/lib/chain/collateral";
import type { TxJob } from "@/lib/chain/tx-store";
import type { TxOutcome, TxRequest } from "@/lib/chain/tx-sender";
import type { SqlClient } from "@/lib/sql";

import { decodeError } from "./reverts";
import { errorMessage, stillInFlight, type KeeperActions, type Logger, type Metrics } from "./runtime";

// ─── pure selection ─────────────────────────────────────────────────────────

export interface Candidate {
  trader: Address;
  health: AccountHealth;
  /** maintenanceMarginRequired - equity; > 0 for every liquidatable account. */
  shortfall: bigint;
}

/**
 * Liquidatable accounts, most under water first. Accounts whose health could
 * not be read are returned separately as blocked on the oracle.
 */
export function selectCandidates(
  health: Map<Address, AccountHealth | null>,
  maxAccounts: number
): { liquidatable: Candidate[]; blocked: Address[]; healthy: number } {
  const liquidatable: Candidate[] = [];
  const blocked: Address[] = [];
  let healthy = 0;
  for (const [trader, h] of health) {
    if (h === null) {
      blocked.push(trader);
      continue;
    }
    if (!h.liquidatable) {
      healthy += 1;
      continue;
    }
    liquidatable.push({ trader, health: h, shortfall: h.maintenanceMarginRequired - h.equity });
  }
  liquidatable.sort((a, b) => (a.shortfall === b.shortfall ? 0 : a.shortfall > b.shortfall ? -1 : 1));
  return { liquidatable: liquidatable.slice(0, maxAccounts), blocked, healthy };
}

export interface OpenPosition {
  marketId: number;
  size: bigint;
  openNotional: bigint;
}

/** Exact unrealized PnL at `price`, as `Liquidation.adl` computes it. */
export function unrealizedPnl(p: { size: bigint; openNotional: bigint }, price: bigint): bigint {
  const abs = p.size < 0n ? -p.size : p.size;
  const notional = (abs * price) / 10n ** 18n;
  return (p.size > 0n ? notional : -notional) - p.openNotional;
}

/** The position to liquidate first: the largest notional at the index. */
export function pickLiquidationMarket(positions: readonly OpenPosition[], index: Map<number, bigint>): number | null {
  let best: { marketId: number; notional: bigint } | null = null;
  for (const p of positions) {
    if (p.size === 0n) continue;
    const price = index.get(p.marketId) ?? 0n;
    const abs = p.size < 0n ? -p.size : p.size;
    const notional = (abs * price) / 10n ** 18n;
    if (!best || notional > best.notional) best = { marketId: p.marketId, notional };
  }
  return best?.marketId ?? null;
}

/** ADL counterparty: opposite side of the backstop, in profit, largest profit first. */
export function pickAdlCounterparty(
  backstopSize: bigint,
  candidates: readonly { trader: Address; size: bigint; openNotional: bigint }[],
  price: bigint
): { trader: Address; upnl: bigint } | null {
  let best: { trader: Address; upnl: bigint } | null = null;
  for (const c of candidates) {
    if (c.size === 0n || c.size > 0n === backstopSize > 0n) continue;
    const upnl = unrealizedPnl(c, price);
    if (upnl <= 0n) continue;
    if (!best || upnl > best.upnl) best = { trader: c.trader, upnl };
  }
  return best;
}

// ─── chain ──────────────────────────────────────────────────────────────────

export interface LiquidationChain {
  paused(): Promise<boolean>;
  health(accounts: readonly Address[]): Promise<Map<Address, AccountHealth | null>>;
  positionsOf(trader: Address): Promise<OpenPosition[]>;
  indexPrice(marketId: number): Promise<bigint | null>;
  /** null when the backstop cannot be priced (StaleOracle): blocked, not zero. */
  unfundedShortfall(): Promise<bigint | null>;
  badDebtState(trader: Address): Promise<{ positionCount: number; balance: bigint; recordedDebt: bigint; operating: bigint }>;
  solvency(): Promise<{ assets: bigint; liabilities: bigint }>;
}

export interface LiquidationSender {
  readonly address: Address;
  submit(req: TxRequest): Promise<TxJob>;
  wait(job: TxJob): Promise<TxOutcome>;
  openJobs(): Promise<TxJob[]>;
}

export interface LiquidationOptions {
  chain: LiquidationChain;
  sender: LiquidationSender;
  sql: SqlClient;
  network: string;
  contracts: { engine: Address; liquidation: Address; insurance: Address };
  log: Logger;
  metrics: Metrics;
  actions: KeeperActions;
  maxAccountsPerTick: number;
  /** Liquidation steps per account per tick. */
  maxStepsPerAccount: number;
  /** Report a confirmed action the indexer has not written after this long. */
  indexerGraceMs: number;
  /**
   * Below this unfunded shortfall (1e18 ledger units = $1) ADL is not
   * attempted. `adl` caps the close so the haircut never exceeds the
   * shortfall, and for dust that cap rounds to zero and reverts
   * NoBadDebtToOffset: retrying it every tick would only spam failures.
   */
  adlMinShortfall: bigint;
  now?: () => number;
}

export type LiqRevertClass = "healthy" | "oracle" | "paused" | "no-position" | "no-shortfall" | "not-in-profit" | "unknown";

export function classifyLiquidationRevert(errorName: string | null): LiqRevertClass {
  switch (errorName) {
    case "NotLiquidatable":
    case "InvalidAmount":
    case "LiquidationWouldNotImproveHealth":
      return "healthy";
    case "StaleOracle":
    case "OracleConfidenceTooWide":
    case "InvalidPrice":
      return "oracle";
    case "EnforcedPause":
    case "ExecutionPaused":
      return "paused";
    case "PositionNotFound":
    case "HasOpenPositions":
      return "no-position";
    case "NoBadDebtToOffset":
      return "no-shortfall";
    case "PositionNotInProfit":
    case "DirectionMismatch":
      return "not-in-profit";
    default:
      return "unknown";
  }
}

// ─── receipt events ─────────────────────────────────────────────────────────

function eventsFrom(receipt: TransactionReceipt, address: Address, abi: typeof liquidationAbi | typeof insuranceAbi) {
  const out: { eventName: string; args: Record<string, unknown> }[] = [];
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      out.push(decodeEventLog({ abi, data: l.data, topics: l.topics }) as unknown as (typeof out)[number]);
    } catch {
      continue;
    }
  }
  return out;
}

// ─── the keeper ─────────────────────────────────────────────────────────────

export interface LiquidationTickResult {
  status: "paused" | "in-flight" | "ran";
  /** stillLiquidatable is null when the protocol paused mid-tick. */
  liquidated: { trader: Address; steps: number; stillLiquidatable: boolean | null }[];
  blocked: Address[];
  adl?: { counterparty: Address; marketId: number; haircut: bigint } | { skipped: string };
  badDebtSettled: Address[];
}

type SendResult =
  | { ok: true; receipt: TransactionReceipt; txHash: Hex }
  | { ok: false; cls: LiqRevertClass | "reverted" | "unconfirmed"; errorName?: string | null };

export class LiquidationKeeper {
  private readonly now: () => number;

  constructor(private readonly o: LiquidationOptions) {
    this.now = o.now ?? Date.now;
  }

  async tick(): Promise<LiquidationTickResult> {
    const { log, metrics } = this.o;
    const result: LiquidationTickResult = { status: "ran", liquidated: [], blocked: [], badDebtSettled: [] };

    const paused = await this.o.chain.paused();
    metrics.gauge("liq_paused", paused ? 1 : 0);
    if (paused) {
      log.info("protocol paused; idling");
      return { ...result, status: "paused" };
    }
    if (await stillInFlight(this.o.sender, log)) return { ...result, status: "in-flight" };

    // ── liquidations ──
    const traders = await this.openTraders();
    const health = await this.o.chain.health(traders);
    const sel = selectCandidates(health, this.o.maxAccountsPerTick);
    result.blocked = sel.blocked;
    metrics.gauge("liq_accounts_scanned", traders.length);
    metrics.gauge("liq_accounts_liquidatable", sel.liquidatable.length);
    metrics.gauge("liq_accounts_blocked_on_oracle", sel.blocked.length);
    if (sel.blocked.length > 0) {
      log.warn("accounts blocked on the oracle: health unreadable, liquidation impossible until prices are fresh", {
        count: sel.blocked.length,
        sample: sel.blocked.slice(0, 5),
      });
    }
    for (const c of sel.liquidatable) {
      const r = await this.liquidateAccount(c);
      result.liquidated.push(r);
      if (r.stillLiquidatable === null) break; // paused mid-tick
    }

    // ── ADL ──
    result.adl = await this.adlStep();

    // ── bad debt ──
    result.badDebtSettled = await this.settleBadDebts();

    // ── solvency and indexer reconciliation ──
    try {
      const s = await this.o.chain.solvency();
      metrics.gauge("vault_solvency_surplus", Number((s.assets - s.liabilities) / 10n ** 12n) / 1e6);
      if (s.assets < s.liabilities) {
        log.error("Vault insolvent: liabilities exceed assets", { alert: true, assets: s.assets, liabilities: s.liabilities });
      }
    } catch (err) {
      log.warn("solvency read failed", { error: errorMessage(err) });
    }
    await this.reconcileIndexed();
    return result;
  }

  // ─── liquidation ──────────────────────────────────────────────────────────

  private async liquidateAccount(c: Candidate): Promise<LiquidationTickResult["liquidated"][number]> {
    const { log, metrics } = this.o;
    let steps = 0;
    let health: AccountHealth | null = c.health;
    while (health?.liquidatable && steps < this.o.maxStepsPerAccount) {
      const positions = await this.o.chain.positionsOf(c.trader);
      const prices = new Map<number, bigint>();
      for (const p of positions) prices.set(p.marketId, (await this.o.chain.indexPrice(p.marketId)) ?? 0n);
      const marketId = pickLiquidationMarket(positions, prices);
      if (marketId === null) break;

      const data = encodeFunctionData({
        abi: liquidationAbi,
        functionName: "liquidate",
        args: [c.trader, marketId, maxUint256],
      });
      const r = await this.send("liquidation.liquidate", data, this.o.contracts.liquidation, {
        trader: c.trader,
        marketId,
        step: steps + 1,
        equity: health.equity,
        maintenanceMarginRequired: health.maintenanceMarginRequired,
      });
      if (!r.ok) {
        if (r.cls === "paused") return { trader: c.trader, steps, stillLiquidatable: null };
        if (r.cls === "healthy") log.info("account no longer liquidatable (raced or recovered)", { trader: c.trader });
        break;
      }
      steps += 1;
      metrics.inc("liq_liquidations_total");
      health = (await this.o.chain.health([c.trader])).get(c.trader) ?? null;
    }
    const still = health?.liquidatable ?? false;
    if (still) log.warn("account still liquidatable after this tick's steps", { trader: c.trader, steps });
    return { trader: c.trader, steps, stillLiquidatable: still };
  }

  // ─── ADL ──────────────────────────────────────────────────────────────────

  private async adlStep(): Promise<LiquidationTickResult["adl"]> {
    const { log, metrics } = this.o;
    const shortfall = await this.o.chain.unfundedShortfall();
    if (shortfall === null) {
      metrics.inc("adl_blocked_on_oracle_total");
      log.warn("unfundedShortfall unreadable (backstop cannot be priced): ADL blocked on the oracle");
      return { skipped: "oracle" };
    }
    metrics.gauge("insurance_unfunded_shortfall", Number(shortfall / 10n ** 12n) / 1e6);
    if (shortfall <= 0n) return { skipped: "no-shortfall" };
    if (shortfall < this.o.adlMinShortfall) {
      metrics.gauge("insurance_unfunded_shortfall_dust", Number(shortfall));
      return { skipped: "dust" };
    }

    const backstop = await this.o.chain.positionsOf(this.o.contracts.insurance);
    for (const bs of backstop) {
      if (bs.size === 0n) continue;
      const price = await this.o.chain.indexPrice(bs.marketId);
      if (price === null) continue;
      const rows = (await this.o.sql.query(
        `SELECT "trader", "size"::text AS size, "openNotional"::text AS "openNotional"
         FROM "Position" WHERE "network" = $1 AND "marketId" = $2 AND "size" <> 0 AND "trader" <> $3`,
        [this.o.network, bs.marketId, this.o.contracts.insurance.toLowerCase()]
      )) as { trader: string; size: string; openNotional: string }[];
      // The index lags the chain; the contract re-checks, and a wrong pick reverts cheaply.
      const pick = pickAdlCounterparty(
        bs.size,
        rows.map((r) => ({ trader: r.trader as Address, size: BigInt(r.size), openNotional: BigInt(r.openNotional) })),
        price
      );
      if (!pick) continue;
      const data = encodeFunctionData({
        abi: liquidationAbi,
        functionName: "adl",
        args: [pick.trader, bs.marketId, maxUint256],
      });
      const r = await this.send("liquidation.adl", data, this.o.contracts.liquidation, {
        counterparty: pick.trader,
        marketId: bs.marketId,
        shortfall,
        expectedUpnl: pick.upnl,
      });
      if (!r.ok) return { skipped: r.cls };
      const ev = eventsFrom(r.receipt, this.o.contracts.liquidation, liquidationAbi).find((e) => e.eventName === "Deleveraged");
      const haircut = (ev?.args.haircut as bigint | undefined) ?? 0n;
      metrics.inc("adl_total");
      metrics.inc("adl_haircut_total_1e18", haircut);
      log.warn("ADL: counterparty deleveraged and haircut", { counterparty: pick.trader, marketId: bs.marketId, haircut, shortfall });
      return { counterparty: pick.trader, marketId: bs.marketId, haircut };
    }
    log.warn("unfunded shortfall with no ADL counterparty in profit", { shortfall });
    return { skipped: "no-counterparty" };
  }

  // ─── bad debt ─────────────────────────────────────────────────────────────

  private async settleBadDebts(): Promise<Address[]> {
    const rows = (await this.o.sql.query(
      `SELECT "address" FROM "Account" WHERE "network" = $1 AND "ledgerBalance" < 0 AND "address" <> $2 LIMIT 50`,
      [this.o.network, this.o.contracts.insurance.toLowerCase()]
    )) as { address: string }[];
    const settled: Address[] = [];
    for (const { address } of rows) {
      const trader = address as Address;
      const st = await this.o.chain.badDebtState(trader);
      if (st.positionCount !== 0 || st.balance >= 0n) continue;
      const deficit = -st.balance;
      // Only when something would change: capital to cover it, or a stale record.
      if (st.operating <= 0n && st.recordedDebt === deficit) continue;
      const data = encodeFunctionData({ abi: insuranceAbi, functionName: "settleBadDebt", args: [trader] });
      const r = await this.send("liquidation.settle-bad-debt", data, this.o.contracts.insurance, { trader, deficit });
      if (r.ok) {
        settled.push(trader);
        this.o.metrics.inc("bad_debt_settled_total");
      }
    }
    return settled;
  }

  // ─── send, record, confirm ────────────────────────────────────────────────

  private async send(kind: string, data: Hex, to: Address, payload: Record<string, unknown>): Promise<SendResult> {
    const { log, metrics } = this.o;
    const marketId = typeof payload.marketId === "number" ? payload.marketId : null;
    const account = (payload.trader ?? payload.counterparty ?? null) as string | null;
    const id = await this.o.actions.record({ kind, marketId, account, payload });

    let job: TxJob;
    try {
      job = await this.o.sender.submit({ to, data, label: kind });
    } catch (err) {
      const { errorName } = decodeError(err);
      const cls = classifyLiquidationRevert(errorName);
      metrics.inc(`liq_preflight_reverted_total.${cls}`);
      await this.o.actions.update(id, { status: "FAILED", payload: { ...payload, preflight: { errorName, cls, error: errorMessage(err) } } });
      if (cls === "unknown") log.error("keeper call refused in pre-flight", { kind, errorName, error: errorMessage(err) });
      return { ok: false, cls, errorName };
    }
    await this.o.actions.update(id, { status: "SUBMITTED", txJobId: job.id });

    let out: TxOutcome;
    try {
      out = await this.o.sender.wait(job);
    } catch (err) {
      log.warn("keeper call not confirmed in time; in-flight guard holds the next tick", { kind, error: errorMessage(err) });
      return { ok: false, cls: "unconfirmed" };
    }
    if (out.receipt.status !== "success") {
      await this.o.actions.update(id, { status: "FAILED", blockNumber: out.receipt.blockNumber });
      metrics.inc(`liq_reverted_total`);
      return { ok: false, cls: "reverted" };
    }
    const txHash = out.receipt.transactionHash;
    const events = [
      ...eventsFrom(out.receipt, this.o.contracts.liquidation, liquidationAbi),
      ...eventsFrom(out.receipt, this.o.contracts.insurance, insuranceAbi),
    ].map((e) => ({ event: e.eventName, args: e.args }));
    await this.o.actions.update(id, {
      status: "CONFIRMED",
      blockNumber: out.receipt.blockNumber,
      payload: { ...payload, txHash, events, indexed: kind === "liquidation.settle-bad-debt" ? null : false },
    });
    return { ok: true, receipt: out.receipt, txHash };
  }

  /**
   * Confirmed liquidations and ADLs should appear in the indexer's event
   * tables. Mark them once they do; report any still missing after the grace
   * period. Never writes the event rows itself: the indexer owns on-chain truth.
   */
  private async reconcileIndexed(): Promise<void> {
    const pending = (await this.o.sql.query(
      `SELECT "id", "kind", "payload", "updatedAt" FROM "KeeperAction"
       WHERE "network" = $1 AND "status" = 'CONFIRMED'
         AND "kind" IN ('liquidation.liquidate', 'liquidation.adl')
         AND ("payload"->>'indexed') = 'false'
       ORDER BY "id" ASC LIMIT 200`,
      [this.o.network]
    )) as { id: string; kind: string; payload: Record<string, unknown>; updatedAt: Date }[];
    let missing = 0;
    for (const a of pending) {
      const table = a.kind === "liquidation.adl" ? "DeleverageEvent" : "LiquidationEvent";
      const hit = await this.o.sql.query(
        `SELECT 1 FROM "${table}" WHERE "network" = $1 AND lower("txHash") = lower($2) LIMIT 1`,
        [this.o.network, String(a.payload.txHash)]
      );
      if (hit.length > 0) {
        await this.o.actions.update(BigInt(a.id), { payload: { ...a.payload, indexed: true } });
      } else if (this.now() - new Date(a.updatedAt).getTime() > this.o.indexerGraceMs) {
        missing += 1;
      }
    }
    this.o.metrics.gauge("liq_unindexed_actions", missing);
    if (missing > 0) {
      this.o.log.warn("confirmed keeper actions not yet in the indexer's event tables", { missing });
    }
  }

  private async openTraders(): Promise<Address[]> {
    const rows = (await this.o.sql.query(
      `SELECT DISTINCT "trader" FROM "Position" WHERE "network" = $1 AND "size" <> 0 AND "trader" <> $2`,
      [this.o.network, this.o.contracts.insurance.toLowerCase()]
    )) as { trader: string }[];
    return rows.map((r) => r.trader as Address);
  }
}

// ─── chain, over viem ───────────────────────────────────────────────────────

export function viemLiquidationChain(o: {
  client: Pick<PublicClient, "multicall" | "readContract">;
  engine: Address;
  liquidation: Address;
  insurance: Address;
  vault: Address;
}): LiquidationChain {
  const read = <T>(address: Address, abi: unknown, functionName: string, args: readonly unknown[] = []) =>
    o.client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  return {
    async paused() {
      const [a, b, c] = await o.client.multicall({
        allowFailure: false,
        contracts: [
          { address: o.engine, abi: engineAbi, functionName: "paused" },
          { address: o.liquidation, abi: liquidationAbi, functionName: "paused" },
          { address: o.insurance, abi: insuranceAbi, functionName: "paused" },
        ],
      });
      return Boolean(a || b || c);
    },
    health: (accounts) => readAccountHealth(o.client, o.engine, accounts),
    async positionsOf(trader) {
      const [ids, ps] = await read<[readonly (number | bigint)[], readonly { size: bigint; openNotional: bigint }[]]>(
        o.engine,
        engineAbi,
        "positionsOf",
        [trader]
      );
      return ids.map((id, i) => ({ marketId: Number(id), size: ps[i].size, openNotional: ps[i].openNotional }));
    },
    async indexPrice(marketId) {
      try {
        return await read<bigint>(o.engine, engineAbi, "indexPrice", [marketId]);
      } catch {
        return null;
      }
    },
    async unfundedShortfall() {
      try {
        return await read<bigint>(o.insurance, insuranceAbi, "unfundedShortfall");
      } catch (err) {
        if (decodeError(err).errorName === "StaleOracle" || /StaleOracle/.test(String(err))) return null;
        throw err;
      }
    },
    async badDebtState(trader) {
      const [positionCount, balance, recordedDebt, operating] = await o.client.multicall({
        allowFailure: false,
        contracts: [
          { address: o.engine, abi: engineAbi, functionName: "positionCount", args: [trader] },
          { address: o.vault, abi: vaultAbi, functionName: "balanceOf", args: [trader] },
          { address: o.insurance, abi: insuranceAbi, functionName: "recordedDebt", args: [trader] },
          { address: o.insurance, abi: insuranceAbi, functionName: "operatingBalance" },
        ],
      });
      return {
        positionCount: Number(positionCount),
        balance: balance as bigint,
        recordedDebt: recordedDebt as bigint,
        operating: operating as bigint,
      };
    },
    async solvency() {
      const [assets, liabilities] = await read<[bigint, bigint]>(o.vault, vaultAbi, "solvency");
      return { assets, liabilities };
    },
  };
}
