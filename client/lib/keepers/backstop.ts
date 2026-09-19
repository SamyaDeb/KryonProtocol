/**
 * Backstop unwinder (plan §4.4): closes the positions the Insurance backstop
 * took over in liquidations, through the ordinary order book.
 *
 * Insurance is an ERC-1271 signer. An order owned by the Insurance contract is
 * valid when it is reduce-only, expires within MAX_UNWIND_ORDER_TTL (1h), and
 * its EIP-712 digest is signed by a BACKSTOP_SIGNER_ROLE key. The signature
 * the gateway sees is `abi.encode(abi.encode(order), signerSignature)`. Every
 * fill then goes through `Insurance.onBackstopFill`, which rejects a fill
 * outside `maxUnwindDeviationBps` of the index or over the per-fill or daily
 * notional caps.
 *
 * So this service sends no transactions and needs no gas. It signs orders and
 * submits them through the same intake validation as `POST /api/orders`
 * (`validateOrderSubmission` + `insertOrder`, with the gas-capped ERC-1271
 * check), and the matcher treats them like any other order.
 *
 * One tick:
 *   1. Idle, and say why, while unwinding is disabled (deviation 0), the key
 *      lacks BACKSTOP_SIGNER_ROLE, or Engine / OrderGateway / Insurance is paused.
 *   2. Close out earlier intents from the indexer's Order rows (truth), never
 *      from what this process believes happened.
 *   3. Per held market: skip while an unwind order is still open, or while the
 *      index is unreadable (stale feed). Otherwise one reduce-only slice, sized so
 *      its worst-case fill notional fits within the per-fill cap and within what
 *      is left of the daily cap after today's usage *and* every open order.
 *
 * Keepers write intent: each order is a KeeperAction (`backstop.unwind`).
 * Nothing here marks a fill or an order settled.
 */

import { encodeAbiParameters, keccak256, toHex, zeroAddress, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";

import { engineAbi, insuranceAbi, orderGatewayAbi } from "@/lib/chain/contracts";
import type { ArcNetworkId } from "@/lib/chain/networks";
import { ORDER_TYPES, orderTypedData, NO_REFERRER, type Order } from "@/lib/market/eip712";
import type { Queryable } from "@/lib/queries/client";
import { riskFromParams, type StoredMarketParams } from "@/lib/queries/markets";
import { insertOrder } from "@/lib/queries/orders";
import { validateOrderSubmission, type Erc1271Checker } from "@/lib/validation";

import { errorMessage, type KeeperActions, type Logger, type Metrics } from "./runtime";

export const BPS = 10_000n;
const E18 = 10n ** 18n;
/** Insurance.MAX_UNWIND_ORDER_TTL. */
export const MAX_UNWIND_TTL_SECONDS = 3_600n;
/** Roles.BACKSTOP_SIGNER_ROLE. */
export const BACKSTOP_SIGNER_ROLE: Hex = keccak256(toHex("BACKSTOP_SIGNER_ROLE"));
export const UNWIND_ACTION = "backstop.unwind";

// ─── pure planning ──────────────────────────────────────────────────────────

export interface UnwindLimits {
  maxDeviationBps: bigint;
  maxFillNotional: bigint;
  maxDailyNotional: bigint;
  /** Notional already unwound in the current UTC day (Insurance.unwoundOnDay). */
  usedToday: bigint;
}

export interface BackstopPosition {
  marketId: number;
  /** Signed, 1e18. Positive = long. */
  size: bigint;
}

export interface OpenUnwindOrder {
  orderHash: Hex;
  marketId: number;
  isLong: boolean;
  /** size − filledSize, 1e18. */
  remaining: bigint;
  limitPrice: bigint;
  expiry: bigint;
}

export interface PlanInput {
  positions: readonly BackstopPosition[];
  limits: UnwindLimits;
  /** null = the market's feed is stale or unreadable. */
  index: ReadonlyMap<number, bigint | null>;
  minFillNotional: ReadonlyMap<number, bigint | null>;
  open: readonly OpenUnwindOrder[];
  /** How far inside the band to price, in bps from the index; clamped to maxDeviationBps. */
  priceOffsetBps: bigint;
  maxOrdersPerTick: number;
}

export interface PlannedSlice {
  marketId: number;
  /** true = buy (closing a short). */
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  index: bigint;
  /** size × the highest price a fill could be accepted at: what the caps are checked against. */
  worstNotional: bigint;
}

export type SkipReason = "order-open" | "stale-index" | "no-budget" | "below-min-notional" | "not-configured" | "tick-limit";

export interface Plan {
  slices: PlannedSlice[];
  skipped: { marketId: number; reason: SkipReason }[];
  /** Daily budget left before this tick's slices: maxDaily − usedToday − open orders' worst case. */
  budget: bigint;
}

const abs = (x: bigint) => (x < 0n ? -x : x);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Band edges, rounded inwards, as Insurance tests them: |p − index| ≤ index × dev / 10000. */
export function unwindBand(index: bigint, deviationBps: bigint): { low: bigint; high: bigint } {
  const d = (index * deviationBps) / BPS;
  return { low: index - d, high: index + d };
}

/**
 * The highest price a fill of this order can be accepted at, and so the
 * price the notional caps are checked against. A buy fills at or below its
 * limit; a sell can fill above its limit, but never above the band's top,
 * since onBackstopFill rejects that fill.
 */
export function worstFillPrice(isLong: boolean, limitPrice: bigint, index: bigint, deviationBps: bigint): bigint {
  const { high } = unwindBand(index, deviationBps);
  return isLong ? min(limitPrice, high) : high;
}

/** Limit price `offset` bps inside the band, towards the counterparty. Always within the band. */
export function unwindLimitPrice(isLong: boolean, index: bigint, offsetBps: bigint, deviationBps: bigint): bigint {
  const off = offsetBps > deviationBps ? deviationBps : offsetBps < 0n ? 0n : offsetBps;
  const { low, high } = unwindBand(index, deviationBps);
  // Buying: willing to pay up to index + off. Selling: willing to go down to index − off.
  const p = isLong ? (index * (BPS + off)) / BPS : ceilDiv(index * (BPS - off), BPS);
  return p < low ? low : p > high ? high : p;
}

export function planUnwind(i: PlanInput): Plan {
  const { limits } = i;
  let reserved = 0n;
  for (const o of i.open) {
    const idx = i.index.get(o.marketId);
    // An open order in a market we can't price right now is reserved at its
    // limit plus the full band above it: over-reserving is safe, under is not.
    const worst = idx ? worstFillPrice(o.isLong, o.limitPrice, idx, limits.maxDeviationBps) : (o.limitPrice * (BPS + limits.maxDeviationBps)) / BPS;
    reserved += (o.remaining * worst) / E18 + 1n;
  }
  let budget = limits.maxDailyNotional - limits.usedToday - reserved;
  if (budget < 0n) budget = 0n;
  const plan: Plan = { slices: [], skipped: [], budget };

  const openMarkets = new Set(i.open.map((o) => o.marketId));
  // Largest exposure first, so a tight daily budget goes where it matters.
  const held = i.positions
    .filter((p) => p.size !== 0n)
    .map((p) => ({ p, idx: i.index.get(p.marketId) ?? null }))
    .sort((a, b) => {
      const na = a.idx ? abs(a.p.size) * a.idx : 0n;
      const nb = b.idx ? abs(b.p.size) * b.idx : 0n;
      return na === nb ? a.p.marketId - b.p.marketId : na > nb ? -1 : 1;
    });

  for (const { p, idx } of held) {
    if (openMarkets.has(p.marketId)) {
      plan.skipped.push({ marketId: p.marketId, reason: "order-open" });
      continue;
    }
    if (!idx || idx <= 0n) {
      plan.skipped.push({ marketId: p.marketId, reason: "stale-index" });
      continue;
    }
    const minNotional = i.minFillNotional.get(p.marketId);
    if (minNotional === null || minNotional === undefined) {
      plan.skipped.push({ marketId: p.marketId, reason: "not-configured" });
      continue;
    }
    if (plan.slices.length >= i.maxOrdersPerTick) {
      plan.skipped.push({ marketId: p.marketId, reason: "tick-limit" });
      continue;
    }
    const isLong = p.size < 0n;
    const limitPrice = unwindLimitPrice(isLong, idx, i.priceOffsetBps, limits.maxDeviationBps);
    const worst = worstFillPrice(isLong, limitPrice, idx, limits.maxDeviationBps);
    const cap = min(limits.maxFillNotional, budget);
    if (cap <= 0n) {
      plan.skipped.push({ marketId: p.marketId, reason: "no-budget" });
      continue;
    }
    // floor(cap / worst) so size × worst ≤ cap exactly, in the contract's arithmetic.
    const size = min(abs(p.size), (cap * E18) / worst);
    const worstNotional = (size * worst) / E18;
    // The intake and the matcher refuse orders under minFillNotional at the limit price.
    if (size === 0n || (size * limitPrice) / E18 < minNotional) {
      plan.skipped.push({ marketId: p.marketId, reason: size < abs(p.size) ? "no-budget" : "below-min-notional" });
      continue;
    }
    plan.slices.push({ marketId: p.marketId, isLong, size, limitPrice, index: idx, worstNotional });
    budget -= worstNotional + 1n;
  }
  return plan;
}

// ─── ERC-1271 envelope ──────────────────────────────────────────────────────

const ORDER_TUPLE = [{ type: "tuple", components: ORDER_TYPES.Order }] as const;

/** `abi.encode(abi.encode(order), signerSignature)`, what Insurance.isValidSignature decodes. */
export function backstopSignature(order: Order, signerSignature: Hex): Hex {
  const orderAbi = encodeAbiParameters(ORDER_TUPLE, [order]);
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [orderAbi, signerSignature]);
}

export async function signUnwindOrder(
  signer: Pick<LocalAccount, "signTypedData">,
  chainId: number,
  gateway: Address,
  order: Order
): Promise<Hex> {
  const inner = await signer.signTypedData!(orderTypedData(chainId, gateway, order));
  return backstopSignature(order, inner);
}

// ─── chain and book ─────────────────────────────────────────────────────────

export interface BackstopChain {
  paused(): Promise<boolean>;
  limits(): Promise<UnwindLimits>;
  positions(): Promise<BackstopPosition[]>;
  indexPrice(marketId: number): Promise<bigint | null>;
  hasSignerRole(account: Address): Promise<boolean>;
}

export interface BackstopBook {
  openOrders(owner: Address, nowSec: bigint): Promise<OpenUnwindOrder[]>;
  /** null when the market is not configured for matching (no params yet). */
  minFillNotional(marketId: number): Promise<bigint | null>;
  submit(body: Record<string, unknown>): Promise<{ ok: true; orderHash: Hex; duplicate: boolean } | { ok: false; code: string; error: string }>;
  orderState(orderHash: Hex): Promise<{ status: string; filledSize: bigint; expiry: bigint } | null>;
}

export function viemBackstopChain(o: {
  client: Pick<PublicClient, "multicall" | "readContract">;
  engine: Address;
  orderGateway: Address;
  insurance: Address;
}): BackstopChain {
  const read = <T>(address: Address, abi: unknown, functionName: string, args: readonly unknown[] = []) =>
    o.client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  return {
    async paused() {
      const [a, b, c] = await o.client.multicall({
        allowFailure: false,
        contracts: [
          { address: o.engine, abi: engineAbi, functionName: "paused" },
          { address: o.orderGateway, abi: orderGatewayAbi, functionName: "paused" },
          { address: o.insurance, abi: insuranceAbi, functionName: "paused" },
        ],
      });
      return Boolean(a || b || c);
    },
    async limits() {
      const [dev, fill, daily, used] = await read<[number, bigint, bigint, bigint]>(o.insurance, insuranceAbi, "unwindLimits");
      return { maxDeviationBps: BigInt(dev), maxFillNotional: fill, maxDailyNotional: daily, usedToday: used };
    },
    async positions() {
      const [ids, ps] = await read<[readonly (number | bigint)[], readonly { size: bigint }[]]>(o.engine, engineAbi, "positionsOf", [o.insurance]);
      return ids.map((id, k) => ({ marketId: Number(id), size: ps[k].size }));
    },
    async indexPrice(marketId) {
      try {
        return await read<bigint>(o.engine, engineAbi, "indexPrice", [marketId]);
      } catch {
        return null;
      }
    },
    hasSignerRole: (account) => read<boolean>(o.insurance, insuranceAbi, "hasRole", [BACKSTOP_SIGNER_ROLE, account]),
  };
}

// ─── keeper ─────────────────────────────────────────────────────────────────

export type IdleReason = "limits-unset" | "paused" | "signer-lacks-role" | "flat";

export type BackstopTickResult =
  | { status: "idle"; reason: IdleReason; closed: number }
  | { status: "ran"; posted: { orderHash: Hex; marketId: number; isLong: boolean; size: bigint; limitPrice: bigint }[]; rejected: { marketId: number; code: string; error: string }[]; plan: Plan; closed: number };

export interface BackstopKeeperOptions {
  chain: BackstopChain;
  book: BackstopBook;
  signer: Pick<LocalAccount, "address" | "signTypedData">;
  chainId: number;
  gateway: Address;
  insurance: Address;
  log: Logger;
  metrics: Metrics;
  actions: KeeperActions;
  ttlSeconds?: bigint;
  priceOffsetBps?: bigint;
  maxOrdersPerTick?: number;
  nowSec?: () => bigint;
  newNonce?: () => bigint;
}

export class BackstopUnwinder {
  private readonly ttl: bigint;
  private readonly offset: bigint;
  private readonly maxOrders: number;
  private readonly now: () => bigint;
  private readonly newNonce: () => bigint;
  private lastIdle: IdleReason | null = null;
  private nonceSeq = 0n;

  constructor(private readonly o: BackstopKeeperOptions) {
    this.ttl = o.ttlSeconds ?? 1_800n;
    if (this.ttl <= 0n || this.ttl > MAX_UNWIND_TTL_SECONDS) {
      throw new Error(`unwind order TTL must be in (0, ${MAX_UNWIND_TTL_SECONDS}] seconds`);
    }
    this.offset = o.priceOffsetBps ?? 25n;
    this.maxOrders = o.maxOrdersPerTick ?? 4;
    this.now = o.nowSec ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    // Microsecond wall clock plus a sequence: unique across restarts without
    // storing a counter, and far below the gateway's nonce ceiling.
    this.newNonce = o.newNonce ?? (() => BigInt(Date.now()) * 1_000n + (this.nonceSeq++ % 1_000n));
  }

  private idle(reason: IdleReason, closed: number, fields: Record<string, unknown> = {}): BackstopTickResult {
    this.o.metrics.gauge("backstop_idle", 1);
    this.o.metrics.inc(`backstop_idle_${reason.replace(/-/g, "_")}_total`);
    // Log on change, so a long idle stretch is one line, not one per tick.
    if (this.lastIdle !== reason) this.o.log.info("backstop unwinder idle", { reason, ...fields });
    this.lastIdle = reason;
    return { status: "idle", reason, closed };
  }

  /** Close intents whose order has ended, from the indexer's Order row. */
  async closeFinished(nowSec: bigint): Promise<number> {
    let closed = 0;
    for (const a of await this.o.actions.open(UNWIND_ACTION)) {
      const hash = a.payload.orderHash as Hex | undefined;
      if (!hash) {
        await this.o.actions.update(a.id, { status: "FAILED", payload: { ...a.payload, error: "no orderHash" } });
        continue;
      }
      const st = await this.o.book.orderState(hash);
      const ended = !st || st.expiry <= nowSec || ["FILLED", "EXPIRED", "CANCELLED"].includes(st.status);
      if (!ended) continue;
      const filled = st?.filledSize ?? 0n;
      await this.o.actions.update(a.id, {
        status: filled > 0n ? "CONFIRMED" : "SKIPPED",
        payload: { ...a.payload, filledSize: filled, finalStatus: st?.status ?? "MISSING" },
      });
      closed += 1;
    }
    return closed;
  }

  async tick(): Promise<BackstopTickResult> {
    const nowSec = this.now();
    const closed = await this.closeFinished(nowSec);

    const limits = await this.o.chain.limits();
    if (limits.maxDeviationBps === 0n) return this.idle("limits-unset", closed);
    if (await this.o.chain.paused()) return this.idle("paused", closed);
    if (!(await this.o.chain.hasSignerRole(this.o.signer.address))) {
      return this.idle("signer-lacks-role", closed, { signer: this.o.signer.address });
    }

    const positions = (await this.o.chain.positions()).filter((p) => p.size !== 0n);
    this.o.metrics.gauge("backstop_positions", positions.length);
    if (positions.length === 0) return this.idle("flat", closed);
    this.o.metrics.gauge("backstop_idle", 0);
    this.lastIdle = null;

    const open = await this.o.book.openOrders(this.o.insurance, nowSec);
    const markets = [...new Set([...positions.map((p) => p.marketId), ...open.map((x) => x.marketId)])];
    const index = new Map<number, bigint | null>();
    const minFill = new Map<number, bigint | null>();
    for (const m of markets) {
      index.set(m, await this.o.chain.indexPrice(m));
      minFill.set(m, await this.o.book.minFillNotional(m));
    }

    const plan = planUnwind({
      positions,
      limits,
      index,
      minFillNotional: minFill,
      open,
      priceOffsetBps: this.offset,
      maxOrdersPerTick: this.maxOrders,
    });
    this.o.metrics.gauge("backstop_daily_budget_usdc", Number(plan.budget / E18));
    for (const s of plan.skipped) this.o.metrics.inc(`backstop_skip_${s.reason.replace(/-/g, "_")}_total`);
    if (plan.skipped.some((s) => s.reason === "stale-index")) {
      this.o.log.warn("backstop market not priced: feed stale, not unwinding it", {
        markets: plan.skipped.filter((s) => s.reason === "stale-index").map((s) => s.marketId),
      });
    }

    const posted: Extract<BackstopTickResult, { status: "ran" }>["posted"] = [];
    const rejected: Extract<BackstopTickResult, { status: "ran" }>["rejected"] = [];
    for (const s of plan.slices) {
      const order: Order = {
        owner: this.o.insurance,
        marketId: s.marketId,
        isLong: s.isLong,
        size: s.size,
        limitPrice: s.limitPrice,
        reduceOnly: true,
        nonce: this.newNonce(),
        expiry: nowSec + this.ttl,
        referrer: NO_REFERRER,
      };
      const payload = {
        marketId: s.marketId,
        isLong: s.isLong,
        size: s.size,
        limitPrice: s.limitPrice,
        index: s.index,
        worstNotional: s.worstNotional,
        nonce: order.nonce,
        expiry: order.expiry,
        signer: this.o.signer.address,
        limits,
      };
      let res: Awaited<ReturnType<BackstopBook["submit"]>>;
      try {
        const signature = await signUnwindOrder(this.o.signer, this.o.chainId, this.o.gateway, order);
        res = await this.o.book.submit({
          owner: order.owner,
          marketId: order.marketId,
          isLong: order.isLong,
          size: order.size.toString(),
          limitPrice: order.limitPrice.toString(),
          reduceOnly: true,
          nonce: order.nonce.toString(),
          expiry: order.expiry.toString(),
          referrer: order.referrer,
          signature,
          chainId: this.o.chainId,
        });
      } catch (err) {
        res = { ok: false, code: "error", error: errorMessage(err) };
      }
      if (!res.ok) {
        rejected.push({ marketId: s.marketId, code: res.code, error: res.error });
        this.o.metrics.inc("backstop_orders_rejected_total");
        this.o.log.warn("backstop unwind order refused by intake", { marketId: s.marketId, code: res.code, error: res.error });
        await this.o.actions.record({ kind: UNWIND_ACTION, marketId: s.marketId, account: this.o.insurance, payload: { ...payload, rejected: res.code, error: res.error }, status: "FAILED" });
        continue;
      }
      await this.o.actions.record({ kind: UNWIND_ACTION, marketId: s.marketId, account: this.o.insurance, payload: { ...payload, orderHash: res.orderHash }, status: "SUBMITTED" });
      this.o.metrics.inc("backstop_orders_posted_total");
      this.o.log.info("backstop unwind order posted", { marketId: s.marketId, isLong: s.isLong, size: s.size, limitPrice: s.limitPrice, orderHash: res.orderHash });
      posted.push({ orderHash: res.orderHash, marketId: s.marketId, isLong: s.isLong, size: s.size, limitPrice: s.limitPrice });
    }
    return { status: "ran", posted, rejected, plan, closed };
  }
}

// ─── Postgres book: the POST /api/orders code path ──────────────────────────

/**
 * Orders go through `validateOrderSubmission` and `insertOrder`, exactly as
 * `POST /api/orders` runs them (minus the HTTP rate limit, which guards against
 * strangers, not against the protocol's own service). The ERC-1271 check is
 * the same bounded, gas-capped `eth_call` a smart-wallet order gets.
 */
export function pgBackstopBook(o: {
  q: Queryable;
  network: ArcNetworkId;
  chainId: number;
  gateway: Address;
  erc1271: Erc1271Checker;
  nowSec?: () => bigint;
}): BackstopBook {
  const now = o.nowSec ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  return {
    async openOrders(owner, nowSec) {
      const rows = await o.q.query(
        `SELECT "orderHash", "marketId", "isLong", "size"::text AS "size", "filledSize"::text AS "filledSize",
                "limitPrice"::text AS "limitPrice", "expiry"::text AS "expiry"
           FROM "Order"
          WHERE "network" = $1 AND "owner" = $2 AND "status" IN ('OPEN', 'PARTIALLY_FILLED') AND "expiry" > $3`,
        [o.network, owner.toLowerCase(), nowSec.toString()]
      );
      return rows.map((r) => ({
        orderHash: r.orderHash as Hex,
        marketId: Number(r.marketId),
        isLong: Boolean(r.isLong),
        remaining: BigInt(String(r.size)) - BigInt(String(r.filledSize)),
        limitPrice: BigInt(String(r.limitPrice)),
        expiry: BigInt(String(r.expiry)),
      }));
    },
    async minFillNotional(marketId) {
      const rows = await o.q.query(
        `SELECT "active", "params", "params" ? 'minFillNotional' AS "configured" FROM "Market" WHERE "network" = $1 AND "id" = $2`,
        [o.network, marketId]
      );
      const m = rows[0];
      if (!m || m.active !== true || m.configured !== true) return null;
      return riskFromParams(m.params as StoredMarketParams).minFillNotional;
    },
    async submit(body) {
      const v = await validateOrderSubmission(body, {
        network: o.network,
        chainId: o.chainId,
        gateway: o.gateway,
        nowSec: now(),
        erc1271: o.erc1271,
        q: o.q,
      });
      if (!v.ok) return { ok: false, code: v.code, error: v.error };
      const ord = v.order;
      const outcome = await insertOrder(o.q, o.network, {
        orderHash: v.orderHash,
        owner: ord.owner.toLowerCase(),
        marketId: ord.marketId,
        isLong: ord.isLong,
        size: ord.size,
        limitPrice: ord.limitPrice,
        reduceOnly: ord.reduceOnly,
        nonce: ord.nonce,
        expiry: ord.expiry,
        referrer: ord.referrer === zeroAddress ? null : ord.referrer.toLowerCase(),
        signature: v.signature,
      });
      if (outcome === "nonce_reused") return { ok: false, code: "nonce_reused", error: `nonce ${ord.nonce} already used` };
      return { ok: true, orderHash: v.orderHash, duplicate: outcome === "duplicate" };
    },
    async orderState(orderHash) {
      const rows = await o.q.query(
        `SELECT "status"::text AS "status", "filledSize"::text AS "filledSize", "expiry"::text AS "expiry"
           FROM "Order" WHERE "orderHash" = $1`,
        [orderHash.toLowerCase()]
      );
      const r = rows[0];
      return r ? { status: String(r.status), filledSize: BigInt(String(r.filledSize)), expiry: BigInt(String(r.expiry)) } : null;
    },
  };
}
