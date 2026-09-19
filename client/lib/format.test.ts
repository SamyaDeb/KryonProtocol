// Arc formatting: bigint in, string out, no float on the way. These pin the
// scales (1e18 / 1e6 / millionths), the rounding direction, and the edges a
// float formatter gets wrong: dust, huge values, negative zero, carries.

import { test } from "node:test";
import assert from "node:assert/strict";

import { displayFor, MARKET_DISPLAY } from "@/lib/markets";
import {
  E18,
  E6,
  formatChange,
  formatCompactUsd,
  formatFixed,
  formatFundingRate,
  formatPrice,
  formatRateBps,
  formatRatePercent,
  formatSize,
  formatUsd,
  formatUsdc,
  formatUsdPrice,
  parseAmount,
  priceInput,
  rescale,
  shortenAddress,
  sizeInput,
  toChartNumber,
} from "./format";

const BTC = displayFor("BTC-PERP");
const ETH = displayFor("ETH-PERP");
const TRX = displayFor("TRX-PERP");
const px = (whole: bigint, frac = 0n, fracDigits = 0) => whole * E18 + (frac * E18) / 10n ** BigInt(fracDigits);

test("rescale rounds in the direction asked, symmetric around zero", () => {
  // 1.25 at 2dp → 1dp
  assert.equal(rescale(125n, 2, 1, "nearest"), 13n);
  assert.equal(rescale(125n, 2, 1, "down"), 12n);
  assert.equal(rescale(121n, 2, 1, "up"), 13n);
  assert.equal(rescale(-125n, 2, 1, "nearest"), -13n);
  assert.equal(rescale(-125n, 2, 1, "down"), -12n);
  assert.equal(rescale(-121n, 2, 1, "up"), -13n);
  assert.equal(rescale(120n, 2, 1, "up"), 12n, "exact values never round");
  assert.equal(rescale(5n, 0, 3), 5000n, "upscaling is exact");
});

test("formatFixed: zero, dust, negative zero and huge values", () => {
  assert.equal(formatFixed(0n, 18, 2), "0.00");
  assert.equal(formatFixed(1n, 18, 2), "0.00", "one wei is dust");
  assert.equal(formatFixed(1n, 18, 2, { rounding: "up" }), "0.01", "dust owed still shows");
  assert.equal(formatFixed(-1n, 18, 2), "0.00", "no '-0.00'");
  assert.equal(formatFixed(-1n, 18, 2, { sign: "always" }), "0.00", "no '+0.00' either");
  // 2^127 - 1 wei: the largest int128 the contracts store. A double cannot.
  const max128 = 2n ** 127n - 1n;
  assert.equal(formatFixed(max128, 18, 0, { grouping: false }), "170141183460469231732", "rounds .687 up");
  assert.equal(formatFixed(max128, 18, 18, { grouping: false }), "170141183460469231731.687303715884105727");
});

test("formatFixed groups thousands only in the integer part", () => {
  assert.equal(formatFixed(1_234_567_890_123n * E18 + E18 / 8n, 18, 4), "1,234,567,890,123.1250");
  assert.equal(formatFixed(1_234n * E18, 18, 0, { grouping: false }), "1234");
  assert.equal(formatFixed(-1_000n * E18, 18, 2), "-1,000.00");
  assert.equal(formatFixed(999n * E18, 18, 2), "999.00");
});

test("formatFixed carries through the integer part when rounding", () => {
  assert.equal(formatFixed(999_995n * 10n ** 13n, 18, 2), "10.00");
  assert.equal(formatFixed(9_999_999_995n * 10n ** 15n, 18, 2), "10,000,000.00");
});

test("prices render at each market's precision", () => {
  assert.equal(formatPrice(BTC, px(76_996n, 5n, 1)), "76,996.5");
  assert.equal(formatPrice(BTC, px(76_996n, 55n, 2)), "76,996.6", "half rounds away from zero");
  assert.equal(formatPrice(ETH, px(3_000n)), "3,000.00");
  assert.equal(formatPrice(TRX, px(0n, 24_187n, 5)), "0.24187");
  assert.equal(formatPrice(TRX, px(0n, 241_876n, 6)), "0.24188");
});

test("every listed market's finest tick stays distinguishable", () => {
  for (const d of Object.values(MARKET_DISPLAY)) {
    const tickWei = BigInt(Math.round(d.tickSizes[0] * 1e6)) * 10n ** 12n;
    const a = formatPrice(d, E18 + tickWei);
    const b = formatPrice(d, E18 + 2n * tickWei);
    assert.notEqual(a, b, `${d.symbol}: ${d.priceDecimals}dp cannot separate ${d.tickSizes[0]} ticks`);
  }
});

test("an unknown market falls back to 4dp", () => {
  assert.equal(formatPrice(displayFor("DOGE"), px(0n, 123_456n, 6)), "0.1235");
});

test("formatUsdPrice dashes missing or non-positive prices", () => {
  assert.equal(formatUsdPrice(BTC, null), "—");
  assert.equal(formatUsdPrice(BTC, undefined), "—");
  assert.equal(formatUsdPrice(BTC, 0n), "—");
  assert.equal(formatUsdPrice(BTC, -E18), "—");
  assert.equal(formatUsdPrice(BTC, px(65_000n)), "$65,000.0");
});

test("sizes are signed and use sizeDecimals", () => {
  assert.equal(formatSize(BTC, px(0n, 12_345n, 5)), "0.1235");
  assert.equal(formatSize(BTC, -px(1n, 5n, 1)), "-1.5000");
  assert.equal(formatSize(TRX, px(1_234n, 6n, 1)), "1,235");
});

test("inputs carry no separators, and sizes never round up past the source", () => {
  assert.equal(priceInput(BTC, px(76_996n, 549n, 3)), "76996.5");
  assert.equal(sizeInput(BTC, px(0n, 99_999n, 5)), "0.9999");
  assert.equal(sizeInput(BTC, px(12_345n)), "12345.0000");
});

test("USD amounts: sign before the dollar, two decimals by default", () => {
  assert.equal(formatUsd(1_234n * E18 + E18 / 2n), "$1,234.50");
  assert.equal(formatUsd(-12n * E18 - E18 / 2n), "-$12.50");
  assert.equal(formatUsd(12n * E18, { sign: "always" }), "+$12.00");
  assert.equal(formatUsd(0n, { sign: "always" }), "$0.00");
  assert.equal(formatUsd(E18 / 3n, { dp: 4 }), "$0.3333");
});

test("USDC is 6 decimals, and withdrawable rounds down", () => {
  assert.equal(formatUsdc(1_000_000n), "$1.00");
  assert.equal(formatUsdc(1_999_999n, { rounding: "down" }), "$1.99");
  assert.equal(formatUsdc(1_999_999n), "$2.00");
  assert.equal(formatUsdc(250_000n * E6), "$250,000.00");
});

test("compact USD picks the unit after rounding", () => {
  assert.equal(formatCompactUsd(0n, 6), "$0.00");
  assert.equal(formatCompactUsd(994n * E6, 6), "$994.00");
  assert.equal(formatCompactUsd(999n * E6, 6), "$1.00K", "0.999K rounds to 1.00K, as 999,999 does to 1.00M");
  assert.equal(formatCompactUsd(999_995n * 10n ** 3n, 6), "$1.00K");
  assert.equal(formatCompactUsd(1_234_567n * E6, 6), "$1.23M");
  assert.equal(formatCompactUsd(999_999_999n * E6, 6), "$1.00B");
  assert.equal(formatCompactUsd(12_345_678_901_234n * E6, 6), "$12,345.68B");
  assert.equal(formatCompactUsd(-2_500n * E18, 18), "-$2.50K");
});

test("fee rates: millionths to bps and percent", () => {
  assert.equal(formatRateBps(350), "3.5 bps");
  assert.equal(formatRateBps(50), "0.5 bps");
  assert.equal(formatRateBps(100), "1 bps");
  assert.equal(formatRateBps(-50), "-0.5 bps");
  assert.equal(formatRateBps(1), "0.01 bps");
  assert.equal(formatRateBps(0), "0 bps");
  assert.equal(formatRatePercent(350), "0.035%");
  assert.equal(formatRatePercent(1), "0.0001%");
  assert.equal(formatRatePercent(10_000), "1%");
});

test("funding rate per hour: a 1e18 fraction, always signed", () => {
  assert.equal(formatFundingRate(E18 / 10_000n), "+0.0100%");
  assert.equal(formatFundingRate(-(5n * E18) / 10_000n), "-0.0500%");
  assert.equal(formatFundingRate(0n), "0.0000%");
  assert.equal(formatFundingRate(1n), "0.0000%", "dust is not a direction");
});

test("change percent from two bigints", () => {
  assert.equal(formatChange(px(100n), px(101n, 234n, 3)), "+1.23%");
  assert.equal(formatChange(px(100n), px(98n)), "-2.00%");
  assert.equal(formatChange(px(100n), px(100n)), "0.00%");
  assert.equal(formatChange(0n, px(1n)), "—");
});

test("parseAmount is strict and exact", () => {
  assert.equal(parseAmount("1.5", 18), 1_500_000_000_000_000_000n);
  assert.equal(parseAmount("0.000001", 6), 1n);
  assert.equal(parseAmount(".5", 6), 500_000n);
  assert.equal(parseAmount("5.", 6), 5_000_000n);
  assert.equal(parseAmount(" 1,000.25 ", 6), 1_000_250_000n);
  assert.equal(parseAmount("12345678901234567890", 18), 12345678901234567890n * E18);
  for (const bad of ["", ".", "-1", "1e3", "abc", "1.2.3", "0.0000001", "1,00", "1,0000", "0x10", "Infinity"]) {
    assert.equal(parseAmount(bad, 6), null, `"${bad}" must not parse`);
  }
});

test("EVM addresses shorten to 0x + 4 … 4", () => {
  assert.equal(shortenAddress("0x1234567890abcdef1234567890abcdef12345678"), "0x1234…5678");
  assert.equal(shortenAddress("0xshort"), "0xshort");
  assert.equal(shortenAddress(""), "");
});

test("toChartNumber is for charts: close, not exact", () => {
  assert.equal(toChartNumber(px(76_996n, 5n, 1), 18), 76_996.5);
  assert.equal(toChartNumber(1_500_000n, 6), 1.5);
});
