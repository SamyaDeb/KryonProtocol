// Market-aware formatting. These encode the display requirements from
// MULTI-MARKET-PLAN §11 step 11 directly, so a precision regression fails CI
// instead of needing to be spotted on screen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKETS } from "@/config";
import { formatMarketPrice, formatMarketSize, formatMarketUsd, priceFor, sizeFor, toPriceInput } from "./format";

const BTC = MARKETS["BTC-PERP"];
const TRX = MARKETS["TRX-PERP"];
const XLM = MARKETS["XLM-PERP"];

test("BTC renders 1dp with thousands separators, not 4dp", () => {
  assert.equal(formatMarketPrice(BTC, 76996.5), "76,996.5");
  assert.equal(formatMarketUsd(BTC, 76996.5), "$76,996.5");
  // The old behaviour, explicitly rejected.
  assert.notEqual(formatMarketPrice(BTC, 76996.5), "76996.5000");
});

test("TRX renders 5dp", () => {
  assert.equal(formatMarketPrice(TRX, 0.3456), "0.34560");
  // A 4dp formatter cannot express TRX's finest 0.00001 tick.
  assert.equal(formatMarketPrice(TRX, 0.34561), "0.34561");
  assert.notEqual(formatMarketPrice(TRX, 0.34561), formatMarketPrice(TRX, 0.3456));
});

test("XLM keeps its existing 4dp", () => {
  assert.equal(formatMarketPrice(XLM, 0.2038), "0.2038");
});

test("bigint prices are treated as 1e18", () => {
  assert.equal(formatMarketUsd(BTC, 76996500000000000000000n), "$76,996.5");
  assert.equal(formatMarketUsd(XLM, 203800000000000000n), "$0.2038");
});

test("formatMarketUsd renders a dash for absent or non-positive values", () => {
  assert.equal(formatMarketUsd(BTC, null), "—");
  assert.equal(formatMarketUsd(BTC, undefined), "—");
  assert.equal(formatMarketUsd(BTC, 0n), "—");
});

test("sizes use each market's sizeDecimals", () => {
  assert.equal(formatMarketSize(BTC, 0.12345), "0.1235"); // 4dp
  assert.equal(formatMarketSize(TRX, 1234.6), "1,235");   // 0dp
});

test("toPriceInput rounds a typed price to the market's precision", () => {
  // No thousands separators — this feeds an <input>, not a label.
  assert.equal(toPriceInput(BTC, 76996.549), "76996.5");
  assert.equal(toPriceInput(TRX, 0.345678), "0.34568");
});

test("priceFor / sizeFor resolve by market id", () => {
  assert.equal(priceFor(BTC.marketId, 76996.5), "$76,996.5");
  assert.equal(sizeFor(TRX.marketId, 1234.6), "1,235");
});

test("an unknown market id falls back to 4dp rather than throwing", () => {
  assert.equal(priceFor(9999, 1.23456789), "$1.2346");
  assert.equal(sizeFor(9999, 1.23456789), "1.2346");
});

test("every market's finest tick is distinguishable at its own precision", () => {
  for (const m of Object.values(MARKETS)) {
    const tick = m.tickSizes[0];
    const a = formatMarketPrice(m, 1 + tick);
    const b = formatMarketPrice(m, 1 + 2 * tick);
    assert.notEqual(a, b, `${m.symbol}: priceDecimals ${m.priceDecimals} cannot separate consecutive ${tick} ticks`);
  }
});
