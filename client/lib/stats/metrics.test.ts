// The analytics definitions, one test per rule. No database: these are the
// pure functions the incremental aggregator and the full rebuild both call.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  computeAddressStats,
  emptyActivity,
  equityCurve,
  maxDrawdown,
  notionalToUsd6,
  peakEquity,
  ratio4,
  toUsd6,
  windowStart,
  type AddressActivity,
  type PnlKind,
  type StatsPeriod,
} from "./metrics";

const E18 = 10n ** 18n;
const ALICE = "0x00000000000000000000000000000000000a11ce";
const BOB = "0x0000000000000000000000000000000000000b0b";
const usd = (n: number | bigint) => BigInt(n) * E18;
const at = (iso: string) => new Date(iso);

// Chain order follows event time, as it does on chain.
let seq = 0;
const ordered = (when: string) => ({ blockNumber: BigInt(Math.floor(Date.parse(when) / 1000)), logIndex: seq++, at: at(when) });

function activity(v: Partial<AddressActivity> = {}): AddressActivity {
  return { ...emptyActivity(), ...v };
}

const fill = (when: string, size: bigint, price: bigint, v: Partial<{ fillId: string; maker: string; taker: string }> = {}) => ({
  ...ordered(when),
  fillId: v.fillId ?? `f${seq}`,
  maker: v.maker ?? BOB,
  taker: v.taker ?? ALICE,
  notional: size * price,
});

const pnl = (when: string, kind: PnlKind, amount: bigint) => ({ ...ordered(when), kind, amount });

const NOW = at("2026-09-19T12:00:00.000Z");

describe("scales and rounding", () => {
  test("1e18 → 1e6 truncates toward zero, in both directions", () => {
    assert.equal(toUsd6(1_999_999_999_999n), 1n);
    assert.equal(toUsd6(-1_999_999_999_999n), -1n);
    assert.equal(toUsd6(E18), 1_000_000n);
    assert.equal(toUsd6(999_999_999_999n), 0n, "sub-0.000001 USDC is not rounded up");
  });

  test("notional is size × price kept at 1e36 until one division", () => {
    // 0.3 BTC at 100,000.5 → 30,000.15 USDC.
    assert.equal(notionalToUsd6((3n * E18) / 10n * (100_000n * E18 + E18 / 2n)), 30_000_150_000n);
  });

  test("ratio4 truncates toward zero and guards a zero denominator", () => {
    assert.equal(ratio4(2n, 3n), "0.6666");
    assert.equal(ratio4(-2n, 3n), "-0.6666");
    assert.equal(ratio4(3n, 2n), "1.5000");
    assert.equal(ratio4(5n, 0n), "0.0000");
    assert.equal(ratio4(5n, -1n), "0.0000");
    assert.equal(ratio4(0n, 10n), "0.0000");
  });
});

describe("windows are UTC-midnight anchored", () => {
  const cases: [StatsPeriod, string][] = [
    ["DAY", "2026-09-19T00:00:00.000Z"],
    ["WEEK", "2026-09-13T00:00:00.000Z"],
    ["MONTH", "2026-08-21T00:00:00.000Z"],
    ["ALL", "1970-01-01T00:00:00.000Z"],
  ];
  for (const [period, start] of cases) {
    test(`${period} starts at ${start}`, () => {
      assert.equal(windowStart(period, NOW).toISOString(), start);
      // Anywhere in the same UTC day gives the same start.
      assert.equal(windowStart(period, at("2026-09-19T23:59:59.999Z")).toISOString(), start);
    });
  }

  test("a trade at 23:59:59.999 UTC is in the previous day's window", () => {
    const a = activity({ fills: [fill("2026-09-18T23:59:59.999Z", E18, usd(100))] });
    const day = computeAddressStats(ALICE, a, NOW).traderStats.find((r) => r.period === "DAY");
    assert.equal(day, undefined, "yesterday's trade is not in today's DAY window");
    const week = computeAddressStats(ALICE, a, NOW).traderStats.find((r) => r.period === "WEEK");
    assert.equal(week?.volume, 100_000_000n);
  });

  test("a trade ages out of DAY when the window rolls past midnight", () => {
    const a = activity({ fills: [fill("2026-09-19T10:00:00.000Z", E18, usd(100))] });
    const before = computeAddressStats(ALICE, a, NOW).traderStats.find((r) => r.period === "DAY");
    assert.equal(before?.tradeCount, 1);
    const after = computeAddressStats(ALICE, a, at("2026-09-20T00:00:00.000Z")).traderStats.find((r) => r.period === "DAY");
    assert.equal(after, undefined, "the DAY row disappears once the trade ages out");
  });
});

describe("metric definitions", () => {
  test("volume and trade count: settled fills, a self-trade counted once", () => {
    const a = activity({
      fills: [
        fill("2026-09-19T01:00:00.000Z", E18, usd(100)),
        fill("2026-09-19T02:00:00.000Z", E18 / 2n, usd(200)),
        { ...fill("2026-09-19T03:00:00.000Z", E18, usd(100), { fillId: "self", maker: ALICE, taker: ALICE }) },
      ],
    });
    const day = computeAddressStats(ALICE, a, NOW).traderStats.find((r) => r.period === "DAY")!;
    assert.equal(day.tradeCount, 3);
    assert.equal(day.volume, 300_000_000n); // 100 + 100 + 100
    assert.equal(day.lastTradeAt?.toISOString(), "2026-09-19T03:00:00.000Z");
  });

  test("realized PnL is position PnL and penalties; fees and funding are separate and signed", () => {
    const a = activity({
      pnl: [
        pnl("2026-09-19T01:00:00.000Z", "REALIZED_TRADE", usd(50)),
        pnl("2026-09-19T02:00:00.000Z", "REALIZED_TRADE", -usd(20)),
        pnl("2026-09-19T03:00:00.000Z", "LIQUIDATION", -usd(30)),
        pnl("2026-09-19T04:00:00.000Z", "LIQUIDATION_PENALTY", -usd(5)),
        pnl("2026-09-19T05:00:00.000Z", "DELEVERAGE", usd(7)),
        pnl("2026-09-19T06:00:00.000Z", "FEE", -usd(3)), // paid
        pnl("2026-09-19T07:00:00.000Z", "FEE", usd(1)), // rebate
        pnl("2026-09-19T08:00:00.000Z", "FUNDING", -usd(4)), // paid
        pnl("2026-09-19T09:00:00.000Z", "FUNDING", usd(6)), // received
      ],
    });
    const day = computeAddressStats(ALICE, a, NOW).traderStats.find((r) => r.period === "DAY")!;
    assert.equal(day.realizedPnl, toUsd6(usd(50) - usd(20) - usd(30) - usd(5) + usd(7)));
    assert.equal(day.feesPaid, toUsd6(usd(2)), "fees paid minus rebates, positive = paid");
    assert.equal(day.fundingPaid, toUsd6(-usd(2)), "net funding received is negative");
    assert.equal(day.winningTrades, 2, "penalties do not decide a trade");
    assert.equal(day.losingTrades, 2);
    assert.equal(day.winRate, "0.5000");
  });

  test("a negative realized PnL stays negative through the 1e6 conversion", () => {
    const a = activity({ pnl: [pnl("2026-09-19T01:00:00.000Z", "REALIZED_TRADE", -1_500_000_000_001n)] });
    const day = computeAddressStats(ALICE, a, NOW).traderStats.find((r) => r.period === "DAY")!;
    assert.equal(day.realizedPnl, -1n);
  });

  test("liquidations count and their notional", () => {
    const a = activity({
      liquidations: [{ ...ordered("2026-09-19T01:00:00.000Z"), notional: (E18 / 2n) * usd(100_000) }],
    });
    const day = computeAddressStats(ALICE, a, NOW).traderStats.find((r) => r.period === "DAY")!;
    assert.equal(day.liquidationCount, 1);
    assert.equal(day.liquidatedVolume, 50_000_000_000n);
  });

  test("referrals count distinct referred traders and their volume", () => {
    const a = activity({
      referrals: [
        { ...ordered("2026-09-19T01:00:00.000Z"), trader: BOB, notional: E18 * usd(100) },
        { ...ordered("2026-09-19T02:00:00.000Z"), trader: BOB, notional: E18 * usd(50) },
        { ...ordered("2026-09-19T03:00:00.000Z"), trader: ALICE, notional: E18 * usd(25) },
      ],
    });
    const day = computeAddressStats("0xref", a, NOW).traderStats.find((r) => r.period === "DAY")!;
    assert.equal(day.referralCount, 2);
    assert.equal(day.referralVolume, 175_000_000n);
  });
});

describe("equity, ROI and drawdown", () => {
  test("the curve is net deposits plus every PnL event, in chain order", () => {
    const a = activity({
      balances: [
        { ...ordered("2026-09-19T01:00:00.000Z"), kind: "DEPOSIT", amount: usd(1_000) },
        { ...ordered("2026-09-19T04:00:00.000Z"), kind: "WITHDRAWAL", amount: usd(200) },
      ],
      pnl: [pnl("2026-09-19T02:00:00.000Z", "REALIZED_TRADE", usd(100)), pnl("2026-09-19T03:00:00.000Z", "FEE", -usd(10))],
    });
    assert.deepEqual(
      equityCurve(a).map((p) => p.equity),
      [usd(1_000), usd(1_100), usd(1_090), usd(890)]
    );
  });

  test("peak equity counts the equity carried into the window", () => {
    const a = activity({
      balances: [{ ...ordered("2026-09-01T00:00:00.000Z"), kind: "DEPOSIT", amount: usd(1_000) }],
      pnl: [
        pnl("2026-09-02T00:00:00.000Z", "REALIZED_TRADE", usd(500)), // peak 1500, before the DAY window
        pnl("2026-09-19T01:00:00.000Z", "REALIZED_TRADE", -usd(200)),
      ],
    });
    const curve = equityCurve(a);
    assert.equal(peakEquity(curve, windowStart("DAY", NOW)), usd(1_500));
    assert.equal(peakEquity(curve, windowStart("ALL", NOW)), usd(1_500));
  });

  test("ROI is realized PnL over peak equity, and 0 when there is no equity", () => {
    const funded = activity({
      balances: [{ ...ordered("2026-09-19T01:00:00.000Z"), kind: "DEPOSIT", amount: usd(400) }],
      pnl: [pnl("2026-09-19T02:00:00.000Z", "REALIZED_TRADE", usd(100))],
    });
    const day = computeAddressStats(ALICE, funded, NOW).traderStats.find((r) => r.period === "DAY")!;
    assert.equal(day.peakEquity, toUsd6(usd(500)));
    assert.equal(day.roi, "0.2000");

    // A gain raises cash equity, so an unfunded winner's peak is its own gain.
    const unfunded = activity({ pnl: [pnl("2026-09-19T02:00:00.000Z", "REALIZED_TRADE", usd(100))] });
    const noDeposit = computeAddressStats(ALICE, unfunded, NOW).traderStats.find((r) => r.period === "DAY")!;
    assert.equal(noDeposit.peakEquity, toUsd6(usd(100)));
    assert.equal(noDeposit.roi, "1.0000");

    const lost = activity({ pnl: [pnl("2026-09-19T02:00:00.000Z", "REALIZED_TRADE", -usd(100))] });
    const negative = computeAddressStats(ALICE, lost, NOW).traderStats.find((r) => r.period === "DAY")!;
    assert.equal(negative.peakEquity, 0n, "peak equity is floored at zero");
    assert.equal(negative.roi, "0.0000", "no division by a zero peak");
  });

  test("max drawdown is the largest fall of cumulative net PnL", () => {
    const events = [
      pnl("2026-09-19T01:00:00.000Z", "REALIZED_TRADE", usd(100)), // 100 (peak)
      pnl("2026-09-19T02:00:00.000Z", "REALIZED_TRADE", -usd(40)), // 60  (dd 40)
      pnl("2026-09-19T03:00:00.000Z", "FEE", -usd(10)), // 50  (dd 50)
      pnl("2026-09-19T04:00:00.000Z", "REALIZED_TRADE", usd(200)), // 250 (peak)
      pnl("2026-09-19T05:00:00.000Z", "REALIZED_TRADE", -usd(30)), // 220 (dd 30)
    ];
    assert.equal(maxDrawdown(events), usd(50));
    assert.equal(maxDrawdown([]), 0n);
    assert.equal(maxDrawdown([pnl("2026-09-19T01:00:00.000Z", "REALIZED_TRADE", usd(10))]), 0n);
  });
});

describe("rows written", () => {
  test("only active periods get a row, and an inactive address gets none", () => {
    const a = activity({ fills: [fill("2026-09-10T00:00:00.000Z", E18, usd(100))] });
    const stats = computeAddressStats(ALICE, a, NOW);
    assert.deepEqual(
      stats.traderStats.map((r) => r.period),
      ["MONTH", "ALL"]
    );
    assert.deepEqual(computeAddressStats(ALICE, activity(), NOW), { traderStats: [], analytics: null });
  });

  test("analytics: all-time totals, volume30d, and a depositor who never traded", () => {
    const a = activity({
      fills: [fill("2026-09-19T01:00:00.000Z", E18, usd(100)), fill("2026-06-01T01:00:00.000Z", E18, usd(70))],
      balances: [
        { ...ordered("2026-05-01T00:00:00.000Z"), kind: "DEPOSIT", amount: usd(1_000) },
        { ...ordered("2026-06-02T00:00:00.000Z"), kind: "WITHDRAWAL", amount: usd(100) },
      ],
      pnl: [pnl("2026-06-01T02:00:00.000Z", "FUNDING", -usd(4)), pnl("2026-06-01T03:00:00.000Z", "FEE", -usd(1))],
    });
    const { analytics } = computeAddressStats(ALICE, a, NOW);
    assert.equal(analytics!.volumeAll, 170_000_000n);
    assert.equal(analytics!.volume30d, 100_000_000n, "only the last 30 UTC days");
    assert.equal(analytics!.tradeCountAll, 2);
    assert.equal(analytics!.totalDeposited, toUsd6(usd(1_000)));
    assert.equal(analytics!.totalWithdrawn, toUsd6(usd(100)));
    assert.equal(analytics!.totalFundingPaid, toUsd6(usd(4)));
    assert.equal(analytics!.totalFeesPaid, toUsd6(usd(1)));
    assert.equal(analytics!.firstTradeAt?.toISOString(), "2026-06-01T01:00:00.000Z");
    assert.equal(analytics!.lastTradeAt?.toISOString(), "2026-09-19T01:00:00.000Z");

    const depositor = activity({ balances: [{ ...ordered("2026-09-19T00:00:00.000Z"), kind: "DEPOSIT", amount: usd(10) }] });
    const d = computeAddressStats(BOB, depositor, NOW);
    assert.deepEqual(d.traderStats, [], "a deposit is not trading activity");
    assert.equal(d.analytics?.totalDeposited, toUsd6(usd(10)));
  });
});
