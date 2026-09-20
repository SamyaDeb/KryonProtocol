// Parsed against the real environment files: if one gains a construct this
// reader does not understand, that shows up here and not when an operator
// schedules a parameter change from it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { toHex } from "viem";

import { marketParamsFromToml, oracleIdFor, parseToml, readEnvironmentToml } from "./environment";

test("the subset: sections, strings, numbers, booleans, arrays, comments", () => {
  const doc = parseToml(`
# a comment
market_keys = ["btc", "eth"]

[network]
name = "arc-testnet"   # trailing comment
chain_id = 5042002

[markets.btc]
active = true
min_fill_notional_usd = 40
proposers = []
`);
  assert.deepEqual(doc[""].market_keys, ["btc", "eth"]);
  assert.equal(doc.network.name, "arc-testnet");
  assert.equal(doc.network.chain_id, 5042002);
  assert.equal(doc["markets.btc"].active, true);
  assert.equal(doc["markets.btc"].min_fill_notional_usd, 40);
  assert.deepEqual(doc["markets.btc"].proposers, []);
});

test("it refuses what it cannot read rather than guessing", () => {
  assert.throws(() => parseToml("value = 1.5"), /cannot read value/);
  assert.throws(() => parseToml("keys = [\n]"), /multi-line arrays/);
  assert.throws(() => parseToml("no equals sign here"), /cannot read line 1/);
});

test("every committed environment file parses", () => {
  for (const network of ["arc-local", "arc-testnet", "arc-mainnet"]) {
    const doc = readEnvironmentToml(network);
    assert.equal(doc.network.name, network, network);
    assert.ok(Array.isArray(doc[""].market_keys), `${network}: market_keys`);
  }
});

test("a market's parameters come out in the chain's units", () => {
  const doc = readEnvironmentToml("arc-testnet");
  const { marketId, params } = marketParamsFromToml(doc, "btc");
  assert.equal(marketId, 2);
  assert.equal(params.oracleId, toHex("BTC", { size: 32 }));
  assert.equal(params.initialMarginBps, 200);
  assert.equal(params.maintenanceMarginBps, 100);
  assert.equal(params.active, true);
  assert.equal(params.listed, true);
  // "25" base units and 40 USD in the file; 1e18 on chain.
  assert.equal(params.maxOpenInterest, 25n * 10n ** 18n);
  assert.equal(params.minFillNotional, 40n * 10n ** 18n);
  // An inactive market in the same file keeps its flag.
  assert.equal(marketParamsFromToml(doc, "sol").params.active, false);
  assert.equal(marketParamsFromToml(doc, "BTC").marketId, 2, "the key is case-insensitive");
});

test("an unknown market lists the ones that exist", () => {
  const doc = readEnvironmentToml("arc-testnet");
  assert.throws(() => marketParamsFromToml(doc, "doge"), /have: btc, eth/);
});

test("oracle ids are bytes32 of the symbol", () => {
  assert.equal(oracleIdFor("ETH"), toHex("ETH", { size: 32 }));
});
