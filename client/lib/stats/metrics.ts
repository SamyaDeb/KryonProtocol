/**
 * The analytics maths: one address's indexed activity in, its `TraderStat`
 * rows and `AccountAnalytics` row out. Pure — no database, no clock — so every
 * definition below is unit-tested, and the incremental aggregator and the full
 * rebuild call the same function, which is what makes them agree.
 *
 * SOURCES (all from the indexer's projections, never the chain)
 * -------------------------------------------------------------
 *  fills        SETTLED `Fill` rows where the address is maker or taker.
 *               PENDING and REJECTED fills never count: a pending fill is an
 *               intent the chain may still reject.
 *  pnl          `PnlEvent` (1e18, signed, positive = credit): REALIZED_TRADE,
 *               LIQUIDATION, DELEVERAGE (position PnL from the engine),
 *               LIQUIDATION_PENALTY (negative), FEE (negative = paid, positive
 *               = rebate), FUNDING (positive = received).
 *  liquidations `LiquidationEvent` where the address was liquidated.
 *  balances     `BalanceChange` DEPOSIT / WITHDRAWAL (`internalAmount`, 1e18).
 *  referrals    SETTLED fills on an order whose `referrer` is the address.
 *
 * Every event is timed by its block timestamp (`ProtocolEvent.blockTimestamp`),
 * so a window never depends on when the indexer happened to write the row.
 *
 * SCALES AND ROUNDING
 * -------------------
 * Inputs are 1e18. Every money output is 1e6 USDC (the analytics scale),
 * summed at full precision first and converted ONCE, truncating toward zero:
 * a figure is never overstated, and a sum does not depend on how the rows were
 * batched. Notional is `size × price`, kept at 1e36 until that one division.
 * `winRate` and `roi` are 4-dp decimal strings, also truncated toward zero.
 *
 * SIGN CONVENTIONS (outputs)
 * --------------------------
 *  realizedPnl   signed; negative is a loss. Position PnL plus liquidation
 *                penalties, before fees and funding.
 *  feesPaid      positive = net fees paid; negative = net rebates received.
 *  fundingPaid   positive = net funding paid; negative = net received.
 *  maxDrawdown   ≥ 0, the largest fall of cumulative net PnL from its peak.
 *  peakEquity    ≥ 0, see `equityCurve`.
 *
 * WINDOWS
 * -------
 * UTC-midnight anchored: DAY is today since 00:00 UTC, WEEK the last 7 UTC days
 * including today, MONTH the last 30. ALL starts at the epoch. A window rolls
 * at 00:00 UTC exactly; a trade at 23:59:59.999 is in yesterday's DAY.
 */

export const STATS_PERIODS = ["DAY", "WEEK", "MONTH", "ALL"] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

const WINDOW_DAYS: Record<Exclude<StatsPeriod, "ALL">, number> = { DAY: 1, WEEK: 7, MONTH: 30 };
const DAY_MS = 86_400_000;
const E12 = 10n ** 12n;
const E30 = 10n ** 30n;

/** Inclusive start of a period's window at `now`. */
export function windowStart(period: StatsPeriod, now: Date): Date {
  if (period === "ALL") return new Date(0);
  const midnight = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return new Date(midnight - (WINDOW_DAYS[period] - 1) * DAY_MS);
}

/** 1e18 → 1e6, truncating toward zero (BigInt division already does). */
export function toUsd6(v: bigint): bigint {
  return v / E12;
}

/** A 1e36 notional sum (size × price) → 1e6. */
export function notionalToUsd6(v: bigint): bigint {
  return v / E30;
}

/** `num / den` as a 4-dp decimal string, truncated toward zero; "0.0000" when den ≤ 0. */
export function ratio4(num: bigint, den: bigint): string {
  if (den <= 0n) return "0.0000";
  const scaled = (num * 10_000n) / den;
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const s = `${abs / 10_000n}.${(abs % 10_000n).toString().padStart(4, "0")}`;
  return neg ? `-${s}` : s;
}

// ── inputs ──────────────────────────────────────────────────────────────────

/** Chain order: block, then log index. */
export interface Ordered {
  blockNumber: bigint;
  logIndex: number;
  at: Date;
}

export interface FillActivity extends Ordered {
  fillId: string;
  maker: string;
  taker: string;
  /** size × price, 1e36. */
  notional: bigint;
}

export type PnlKind = "REALIZED_TRADE" | "FUNDING" | "LIQUIDATION" | "LIQUIDATION_PENALTY" | "DELEVERAGE" | "FEE";

export interface PnlActivity extends Ordered {
  kind: PnlKind;
  /** 1e18, signed, positive = credit. */
  amount: bigint;
}

export interface LiquidationActivity extends Ordered {
  /** closeSize × price, 1e36. */
  notional: bigint;
}

export interface BalanceActivity extends Ordered {
  kind: "DEPOSIT" | "WITHDRAWAL";
  /** 1e18, positive. */
  amount: bigint;
}

export interface ReferralActivity extends Ordered {
  /** The referred order's owner. */
  trader: string;
  /** size × price, 1e36. */
  notional: bigint;
}

export interface AddressActivity {
  fills: FillActivity[];
  pnl: PnlActivity[];
  liquidations: LiquidationActivity[];
  balances: BalanceActivity[];
  referrals: ReferralActivity[];
}

export const emptyActivity = (): AddressActivity => ({ fills: [], pnl: [], liquidations: [], balances: [], referrals: [] });

// ── outputs ─────────────────────────────────────────────────────────────────

/** A `TraderStat` row. Money is 1e6. */
export interface TraderStatRow {
  address: string;
  period: StatsPeriod;
  periodStart: Date;
  realizedPnl: bigint;
  volume: bigint;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  winRate: string;
  roi: string;
  feesPaid: bigint;
  fundingPaid: bigint;
  liquidationCount: number;
  liquidatedVolume: bigint;
  peakEquity: bigint;
  referralCount: number;
  referralVolume: bigint;
  lastTradeAt: Date | null;
}

/** An `AccountAnalytics` row. Money is 1e6. */
export interface AccountAnalyticsRow {
  address: string;
  realizedPnlAll: bigint;
  volumeAll: bigint;
  volume30d: bigint;
  tradeCountAll: number;
  winRateAll: string;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  totalFundingPaid: bigint;
  totalFeesPaid: bigint;
  liquidationCount: number;
  maxDrawdown: bigint;
  firstTradeAt: Date | null;
  lastTradeAt: Date | null;
}

export interface AddressStats {
  /** Only the periods the address was active in; an inactive period has no row. */
  traderStats: TraderStatRow[];
  /** Null when the address has no activity at all. */
  analytics: AccountAnalyticsRow | null;
}

// ── definitions ─────────────────────────────────────────────────────────────

/** Kinds that close exposure: they decide a win or a loss. */
const POSITION_KINDS: ReadonlySet<PnlKind> = new Set(["REALIZED_TRADE", "LIQUIDATION", "DELEVERAGE"]);
/** Kinds in `realizedPnl`: position PnL and the liquidation penalty; not fees or funding. */
const REALIZED_KINDS: ReadonlySet<PnlKind> = new Set(["REALIZED_TRADE", "LIQUIDATION", "DELEVERAGE", "LIQUIDATION_PENALTY"]);

const byChainOrder = (a: Ordered, b: Ordered) =>
  a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex;

/**
 * Cash equity over time: net deposits plus every PnL event (position PnL,
 * penalties, fees, funding), in chain order. Unrealized PnL is not on it —
 * nothing indexed records mark-to-market history.
 */
export function equityCurve(a: AddressActivity): { at: Date; equity: bigint }[] {
  const steps: (Ordered & { delta: bigint })[] = [
    ...a.balances.map((b) => ({ ...b, delta: b.kind === "DEPOSIT" ? b.amount : -b.amount })),
    ...a.pnl.map((p) => ({ ...p, delta: p.amount })),
  ].sort(byChainOrder);
  let equity = 0n;
  return steps.map((s) => ({ at: s.at, equity: (equity += s.delta) }));
}

/**
 * The ROI denominator: the highest cash equity during the window, counting the
 * equity carried into it. Floored at zero.
 */
export function peakEquity(curve: { at: Date; equity: bigint }[], start: Date): bigint {
  let carried = 0n;
  let peak = 0n;
  let seenInWindow = false;
  for (const p of curve) {
    if (p.at < start) {
      carried = p.equity;
      continue;
    }
    if (!seenInWindow) {
      peak = carried > peak ? carried : peak;
      seenInWindow = true;
    }
    if (p.equity > peak) peak = p.equity;
  }
  if (!seenInWindow && carried > peak) peak = carried;
  return peak;
}

/** Largest fall of cumulative net PnL (all PnL kinds) from a running peak that starts at zero. */
export function maxDrawdown(pnl: PnlActivity[]): bigint {
  let cum = 0n;
  let peak = 0n;
  let worst = 0n;
  for (const p of [...pnl].sort(byChainOrder)) {
    cum += p.amount;
    if (cum > peak) peak = cum;
    if (peak - cum > worst) worst = peak - cum;
  }
  return worst;
}

interface WindowTotals {
  realized: bigint;
  notional: bigint;
  trades: number;
  wins: number;
  losses: number;
  fees: bigint;
  funding: bigint;
  liquidations: number;
  liquidatedNotional: bigint;
  referred: Set<string>;
  referralNotional: bigint;
  lastTradeAt: Date | null;
  firstTradeAt: Date | null;
  active: boolean;
}

function totals(a: AddressActivity, start: Date): WindowTotals {
  const t: WindowTotals = {
    realized: 0n,
    notional: 0n,
    trades: 0,
    wins: 0,
    losses: 0,
    fees: 0n,
    funding: 0n,
    liquidations: 0,
    liquidatedNotional: 0n,
    referred: new Set(),
    referralNotional: 0n,
    lastTradeAt: null,
    firstTradeAt: null,
    active: false,
  };
  const seenFills = new Set<string>();
  for (const f of a.fills) {
    // A self-trade is one fill with the address on both sides: one trade.
    if (f.at < start || seenFills.has(f.fillId)) continue;
    seenFills.add(f.fillId);
    t.notional += f.notional;
    t.trades += 1;
    if (t.lastTradeAt === null || f.at > t.lastTradeAt) t.lastTradeAt = f.at;
    if (t.firstTradeAt === null || f.at < t.firstTradeAt) t.firstTradeAt = f.at;
    t.active = true;
  }
  for (const p of a.pnl) {
    if (p.at < start) continue;
    t.active = true;
    if (REALIZED_KINDS.has(p.kind)) t.realized += p.amount;
    if (POSITION_KINDS.has(p.kind)) {
      if (p.amount > 0n) t.wins += 1;
      else if (p.amount < 0n) t.losses += 1;
    }
    if (p.kind === "FEE") t.fees -= p.amount;
    if (p.kind === "FUNDING") t.funding -= p.amount;
  }
  for (const l of a.liquidations) {
    if (l.at < start) continue;
    t.active = true;
    t.liquidations += 1;
    t.liquidatedNotional += l.notional;
  }
  for (const r of a.referrals) {
    if (r.at < start) continue;
    t.active = true;
    t.referred.add(r.trader);
    t.referralNotional += r.notional;
  }
  return t;
}

/** Every row the aggregator writes for one address at `now`. */
export function computeAddressStats(address: string, a: AddressActivity, now: Date): AddressStats {
  const curve = equityCurve(a);
  const traderStats: TraderStatRow[] = [];
  const byPeriod = new Map<StatsPeriod, WindowTotals>();

  for (const period of STATS_PERIODS) {
    const start = windowStart(period, now);
    const t = totals(a, start);
    byPeriod.set(period, t);
    if (!t.active) continue;
    const peak = peakEquity(curve, start);
    traderStats.push({
      address,
      period,
      periodStart: start,
      realizedPnl: toUsd6(t.realized),
      volume: notionalToUsd6(t.notional),
      tradeCount: t.trades,
      winningTrades: t.wins,
      losingTrades: t.losses,
      winRate: ratio4(BigInt(t.wins), BigInt(t.wins + t.losses)),
      roi: ratio4(t.realized, peak),
      feesPaid: toUsd6(t.fees),
      fundingPaid: toUsd6(t.funding),
      liquidationCount: t.liquidations,
      liquidatedVolume: notionalToUsd6(t.liquidatedNotional),
      peakEquity: toUsd6(peak),
      referralCount: t.referred.size,
      referralVolume: notionalToUsd6(t.referralNotional),
      lastTradeAt: t.lastTradeAt,
    });
  }

  const all = byPeriod.get("ALL")!;
  const month = byPeriod.get("MONTH")!;
  const hasAny = all.active || a.balances.length > 0;
  let deposited = 0n;
  let withdrawn = 0n;
  for (const b of a.balances) {
    if (b.kind === "DEPOSIT") deposited += b.amount;
    else withdrawn += b.amount;
  }

  return {
    traderStats,
    analytics: hasAny
      ? {
          address,
          realizedPnlAll: toUsd6(all.realized),
          volumeAll: notionalToUsd6(all.notional),
          volume30d: notionalToUsd6(month.notional),
          tradeCountAll: all.trades,
          winRateAll: ratio4(BigInt(all.wins), BigInt(all.wins + all.losses)),
          totalDeposited: toUsd6(deposited),
          totalWithdrawn: toUsd6(withdrawn),
          totalFundingPaid: toUsd6(all.funding),
          totalFeesPaid: toUsd6(all.fees),
          liquidationCount: all.liquidations,
          maxDrawdown: toUsd6(maxDrawdown(a.pnl)),
          firstTradeAt: all.firstTradeAt,
          lastTradeAt: all.lastTradeAt,
        }
      : null,
  };
}
