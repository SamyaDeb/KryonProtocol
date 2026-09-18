import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SourceHealth,
  binanceSource,
  coinbaseSource,
  collectQuotes,
  krakenSource,
  parsePrice,
  type FetchJson,
  type PriceSource,
} from "./sources";

const E18 = 10n ** 18n;
const NOW = 1_700_000_000_000;

function fake(routes: Record<string, unknown | Error>): { fetchJson: FetchJson; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchJson: async (url) => {
      urls.push(url);
      for (const [needle, body] of Object.entries(routes)) {
        if (url.includes(needle)) {
          if (body instanceof Error) throw body;
          return body;
        }
      }
      throw new Error(`no route for ${url}`);
    },
  };
}

describe("parsePrice", () => {
  test("exact decimal to 1e18, no float round-trip", () => {
    assert.equal(parsePrice("80802.53000000"), 80_802_530_000_000_000_000_000n);
    assert.equal(parsePrice("0.3384070"), 338_407_000_000_000_000n);
  });
  test("rejects junk, negatives and zero", () => {
    for (const bad of ["", "abc", "-1", "0", "1e5", null, undefined, {}]) assert.throws(() => parsePrice(bad));
  });
});

describe("binance", () => {
  test("one call for every symbol, USDC-quoted; the de-peg reading uses USDCUSDT", async () => {
    const f = fake({
      "api.binance.com": [
        { symbol: "BTCUSDC", price: "80802.53" },
        { symbol: "USDCUSDT", price: "1.00025" },
      ],
    });
    const r = await binanceSource({ ...f, now: () => NOW }).fetch(["BTC", "USDC", "ETH"]);
    assert.equal(f.urls.length, 1);
    assert.match(decodeURIComponent(f.urls[0]), /\["BTCUSDC","USDCUSDT","ETHUSDC"\]/);
    assert.deepEqual(
      r.quotes.map((q) => [q.symbol, q.price]),
      [
        ["BTC", 80_802_530_000_000_000_000_000n],
        ["USDC", 1_000_250_000_000_000_000n],
      ]
    );
    assert.deepEqual(r.errors, [{ symbol: "ETH", error: "pair missing from response" }]);
  });

  test("a failed request fails every symbol it was asked for", async () => {
    const r = await binanceSource(fake({ "api.binance.com": new Error("HTTP 451") })).fetch(["BTC", "ETH"]);
    assert.equal(r.quotes.length, 0);
    assert.deepEqual(r.errors.map((e) => e.error), ["HTTP 451", "HTTP 451"]);
  });
});

describe("coinbase", () => {
  test("uses the venue's trade time, and reports NotFound per product", async () => {
    const f = fake({
      "BTC-USD": { price: "80805.73", time: new Date(NOW - 2_000).toISOString() },
      "TRX-USD": { message: "NotFound" },
    });
    const r = await coinbaseSource(f).fetch(["BTC", "TRX"]);
    assert.equal(r.quotes[0].ts, NOW - 2_000);
    assert.equal(r.quotes[0].price, 80_805_730_000_000_000_000_000n);
    assert.deepEqual(r.errors, [{ symbol: "TRX", error: "NotFound" }]);
  });

  test("is never asked for USDC: Coinbase pins USDC-USD at 1.00", () => {
    assert.equal(coinbaseSource().supports("USDC"), false);
    assert.equal(coinbaseSource().supports("TRX"), false);
  });
});

describe("kraken", () => {
  test("maps XBT and Kraken's legacy result keys back to our symbols", async () => {
    const f = fake({
      "api.kraken.com": {
        error: [],
        result: {
          XXBTZUSD: { c: ["80802.00000", "1"] },
          XETHZUSD: { c: ["2589.85", "1"] },
          SOLUSD: { c: ["111.47", "95"] },
        },
      },
    });
    const r = await krakenSource({ ...f, now: () => NOW }).fetch(["BTC", "ETH", "SOL", "TRX"]);
    assert.match(f.urls[0], /pair=XBTUSD,ETHUSD,SOLUSD,TRXUSD$/);
    assert.deepEqual(r.quotes.map((q) => q.symbol), ["BTC", "ETH", "SOL"]);
    assert.equal(r.quotes[0].price, 80_802n * E18);
    assert.equal(r.errors[0].symbol, "TRX");
  });
});

describe("collectQuotes", () => {
  test("drops stale quotes, tracks health per venue and symbol, survives a throwing venue", async () => {
    const good: PriceSource = {
      name: "good",
      supports: () => true,
      fetch: async (symbols) => ({
        quotes: symbols.map((symbol) => ({ source: "good", symbol, price: E18, ts: symbol === "ETH" ? NOW - 60_000 : NOW })),
        errors: [],
      }),
    };
    const broken: PriceSource = {
      name: "broken",
      supports: (s) => s === "BTC",
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const health = new SourceHealth();
    const out = await collectQuotes([good, broken], ["BTC", "ETH"], health, { now: NOW, maxQuoteAgeMs: 5_000 });
    assert.equal(out.get("BTC")?.length, 1);
    assert.equal(out.get("ETH")?.length, 0);
    assert.equal(health.healthy("good", "BTC"), true);
    assert.equal(health.healthy("good", "ETH"), false);
    assert.equal(health.get("broken", "BTC").lastError, "boom");
  });
});
