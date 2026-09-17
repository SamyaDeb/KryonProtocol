// Invariants over MARKET_DISPLAY — the presentation half of market metadata.
//
// The risk half lives on chain and is asserted against a real database in the
// query-layer tests; nothing here may assume a margin or a leverage cap, because
// this table deliberately no longer holds one. What is left is display, and
// display still has invariants worth failing a build over: a tick finer than
// the price format can render silently rounds an order-book level away.

import { test } from "node:test";
import assert from "node:assert/strict";

import { displayFor, MARKET_DISPLAY, type MarketDisplay } from "@/lib/markets";

const entries = Object.entries(MARKET_DISPLAY);

test("the table is non-empty", () => {
  assert.ok(entries.length > 0, "MARKET_DISPLAY must describe at least one market");
});

test("every key matches its own symbol", () => {
  for (const [key, m] of entries) assert.equal(key, m.symbol, `key ${key} != symbol ${m.symbol}`);
});

test("symbols are unique", () => {
  const symbols = entries.map(([, m]) => m.symbol);
  assert.equal(new Set(symbols).size, symbols.length, "duplicate symbol");
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

test("required string fields are non-empty", () => {
  const required: (keyof MarketDisplay)[] = [
    "symbol", "displayName", "baseAsset", "quoteAsset", "priceSourceSymbol", "tvSymbol",
  ];
  for (const [, m] of entries) {
    for (const f of required) {
      assert.ok(String(m[f]).length > 0, `${m.symbol}: ${String(f)} is empty`);
    }
  }
});

test("every market quotes in USDC", () => {
  // On Arc, USDC is both the collateral and the gas token, and the protocol
  // settles PnL in it. A market quoted in anything else has no settlement path.
  for (const [, m] of entries) assert.equal(m.quoteAsset, "USDC", `${m.symbol}: quote asset`);
});

test("tvSymbol is a well-formed EXCHANGE:TICKER pair charting the base asset", () => {
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

// ─── The fallback ────────────────────────────────────────────────────────────
// Governance can list a market on chain without a client deploy, so an unknown
// symbol has to render. These assert it renders *sanely*, not that it is
// pretty: the failure this guards against is a crash or a NaN in the ticket.

test("displayFor returns the table entry when there is one", () => {
  assert.equal(displayFor("BTC-PERP"), MARKET_DISPLAY["BTC-PERP"]);
});

test("displayFor derives a usable entry for an unlisted symbol", () => {
  const d = displayFor("DOGE-PERP");
  assert.equal(d.symbol, "DOGE-PERP");
  assert.equal(d.baseAsset, "DOGE");
  assert.equal(d.quoteAsset, "USDC");
  assert.equal(d.priceSourceSymbol, "DOGEUSDT");
  assert.ok(d.tickSizes.length > 0);
  assert.ok(Number.isInteger(d.priceDecimals));
});

test("the fallback satisfies the same invariants as the table", () => {
  for (const symbol of ["DOGE-PERP", "WEIRD", "", "A-B-C"]) {
    const d = displayFor(symbol);
    assert.ok(d.tickSizes.length > 0, `${symbol}: empty tickSizes`);
    const decimalsNeeded = Math.round(-Math.log10(d.tickSizes[0]));
    assert.ok(d.priceDecimals >= decimalsNeeded, `${symbol}: cannot render its own finest tick`);
    assert.ok(d.displayName.length > 0 || symbol === "", `${symbol}: empty displayName`);
  }
});
