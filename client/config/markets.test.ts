// Registry invariants over MARKETS. Run: npm run test:config
//
// On `max_leverage_bps`: the contracts do NOT enforce its relationship to
// `initial_margin_bps`. validate_engine_market (perp-engine/src/lib.rs) never
// inspects the field, and perp-vault's validate_market_config only rejects
// zero. The margin engine derives effective leverage from initial_margin_bps
// alone — risk-engine/src/margin.rs:168, `10_000 * PRECISION / initial_margin_bps`.
//
// So a drifted max_leverage_bps does NOT revert at registration. It is stored
// and displayed, and the UI would advertise leverage the margin engine will
// never grant — a silent mismatch with nothing on-chain to catch it. This file
// is the only enforcement point, which is exactly why the invariant is tested
// here rather than assumed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKETS, type MarketConfig } from "./index";

const entries = Object.entries(MARKETS);

test("every market key matches its own symbol", () => {
  for (const [key, m] of entries) assert.equal(key, m.symbol, `key ${key} != symbol ${m.symbol}`);
});

test("maxLeverageBps === 1e8 / initialMarginBps", () => {
  for (const [, m] of entries) {
    assert.equal(
      m.maxLeverageBps * m.initialMarginBps,
      1e8,
      `${m.symbol}: ${m.maxLeverageBps} * ${m.initialMarginBps} !== 1e8`
    );
  }
});

test("marketIds are unique and positive", () => {
  const ids = entries.map(([, m]) => m.marketId);
  assert.equal(new Set(ids).size, ids.length, "duplicate marketId");
  for (const id of ids) assert.ok(id > 0, `marketId ${id} must be > 0 (engine rejects 0)`);
});

test("symbols are unique", () => {
  const symbols = entries.map(([, m]) => m.symbol);
  assert.equal(new Set(symbols).size, symbols.length, "duplicate symbol");
});

test("maintenance margin is below initial margin", () => {
  for (const [, m] of entries) {
    assert.ok(
      m.maintenanceMarginBps < m.initialMarginBps,
      `${m.symbol}: maintenance ${m.maintenanceMarginBps} must be < initial ${m.initialMarginBps}`
    );
  }
});

test("tickSizes are non-empty, positive and strictly ascending", () => {
  for (const [, m] of entries) {
    assert.ok(m.tickSizes.length > 0, `${m.symbol}: tickSizes must be non-empty`);
    for (let i = 0; i < m.tickSizes.length; i++) {
      assert.ok(m.tickSizes[i] > 0, `${m.symbol}: tick ${m.tickSizes[i]} must be > 0`);
      if (i > 0) {
        assert.ok(
          m.tickSizes[i] > m.tickSizes[i - 1],
          `${m.symbol}: tickSizes must ascend (${m.tickSizes[i - 1]} → ${m.tickSizes[i]})`
        );
      }
    }
  }
});

test("the finest tick is representable at priceDecimals", () => {
  for (const [, m] of entries) {
    const finest = m.tickSizes[0];
    const decimalsNeeded = Math.round(-Math.log10(finest));
    assert.ok(
      m.priceDecimals >= decimalsNeeded,
      `${m.symbol}: priceDecimals ${m.priceDecimals} cannot render tick ${finest}`
    );
  }
});

test("display precisions are sane integers", () => {
  for (const [, m] of entries) {
    for (const [field, v] of [["priceDecimals", m.priceDecimals], ["sizeDecimals", m.sizeDecimals]] as const) {
      assert.ok(Number.isInteger(v) && v >= 0 && v <= 8, `${m.symbol}: ${field}=${v} out of range`);
    }
  }
});

test("open-interest caps are positive", () => {
  for (const [, m] of entries) {
    assert.ok(m.maxOpenInterestBase > 0, `${m.symbol}: maxOpenInterestBase must be > 0`);
    assert.ok(m.maxOpenInterestUsd > 0, `${m.symbol}: maxOpenInterestUsd must be > 0`);
  }
});

test("required string fields are non-empty", () => {
  const required: (keyof MarketConfig)[] = [
    "symbol", "displayName", "baseAsset", "quoteAsset",
    "oracleSymbol", "priceSourceSymbol", "settlementAsset", "tvSymbol",
  ];
  for (const [, m] of entries) {
    for (const f of required) {
      assert.ok(String(m[f]).length > 0, `${m.symbol}: ${String(f)} is empty`);
    }
  }
});

test("tvSymbol is a well-formed EXCHANGE:TICKER pair", () => {
  // Existence cannot be checked offline, and a wrong one fails loudly at
  // runtime with TradingView's "This symbol doesn't exist" — which is exactly
  // how COINBASE:TRXUSD was caught (Coinbase has no TRX pair). This guards the
  // shape; verify existence against
  // https://symbol-search.tradingview.com/symbol_search/?text=<T>&exchange=<E>
  // whenever a market is added or its tvSymbol changed.
  for (const [, m] of entries) {
    assert.match(m.tvSymbol, /^[A-Z]+:[A-Z0-9]+$/, `${m.symbol}: malformed tvSymbol "${m.tvSymbol}"`);
    const ticker = m.tvSymbol.split(":")[1];
    assert.ok(
      ticker.startsWith(m.baseAsset),
      `${m.symbol}: tvSymbol "${m.tvSymbol}" does not chart ${m.baseAsset}`
    );
  }
});

test("priceSourceSymbol is the Binance pair for baseAsset", () => {
  for (const [, m] of entries) {
    assert.equal(m.priceSourceSymbol, `${m.baseAsset}USDT`, `${m.symbol}: priceSourceSymbol mismatch`);
  }
});
