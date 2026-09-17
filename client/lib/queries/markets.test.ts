// Row-mapping tests for the Market query helpers.
//
// These use a stub client and so prove only the half that does not need a
// database: that a row coming back from `pg` is decoded correctly, and that
// every statement is network-scoped and parameterised. The other half — that
// the SQL matches the schema — cannot be tested without Postgres and is covered
// by the integration suite.
//
// The decoding half still earns its place. `Decimal(78, 0)` arrives as a
// string; parsing one with `Number` instead of `BigInt` silently rounds any
// 1e18-scaled value past 2^53, which is every real balance on the venue.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Row, SqlClient } from "@/lib/sql";
import {
  getMarketBySymbol,
  listActiveMarkets,
  listMarkets,
  marketFromRow,
  riskFromParams,
} from "@/lib/queries/markets";

interface Call {
  text: string;
  params: unknown[];
}

/** A `SqlClient` that records what it was asked and replays canned rows. */
function stubSql(rows: Row[] = []): SqlClient & { calls: Call[] } {
  const calls: Call[] = [];
  const client = (async () => rows) as unknown as SqlClient & { calls: Call[] };
  client.query = async <T = Row[]>(text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    return rows as T;
  };
  client.unsafe = (text: string) => ({ text }) as never;
  client.end = async () => {};
  client.calls = calls;
  return client;
}

const UPDATED = new Date("2026-09-17T00:00:00.000Z");

function row(overrides: Record<string, unknown> = {}): Row {
  return {
    network: "arc-testnet",
    id: 2,
    symbol: "BTC-PERP",
    oracleId: `0x${"42".repeat(32)}`,
    active: true,
    params: {
      initialMarginBps: 200,
      maintenanceMarginBps: 100,
      liquidationFeeBps: 25,
      maxLeverageBps: 500000,
      maxOracleAge: 120,
      maxOpenInterest: "25000000000000000000",
      minFillNotional: "10000000000000000000",
    },
    makerRate: -50,
    takerRate: 200,
    lastMark: "77334000000000000000000",
    lastIndex: "77300000000000000000000",
    longFundingIndex: "0",
    shortFundingIndex: "0",
    fundingRatePerHour: "-1000000000000",
    longOpenInterest: "3000000000000000000",
    shortOpenInterest: "2000000000000000000",
    updatedAt: UPDATED,
    ...overrides,
  };
}

// ─── Decoding ────────────────────────────────────────────────────────────────

test("Decimal columns decode as bigint, not number", () => {
  const m = marketFromRow(row() as never);
  assert.equal(m.lastMark, 77334000000000000000000n);
  assert.equal(typeof m.lastMark, "bigint");
  // The value above is far past Number.MAX_SAFE_INTEGER; this is the assertion
  // that fails if anyone swaps BigInt for Number here.
  assert.ok(m.lastMark > BigInt(Number.MAX_SAFE_INTEGER));
});

test("signed Decimal columns keep their sign", () => {
  const m = marketFromRow(row() as never);
  assert.equal(m.fundingRatePerHour, -1000000000000n);
  assert.equal(m.makerRate, -50, "a maker rebate is negative");
});

test("risk parameters decode from the stored params JSON", () => {
  const m = marketFromRow(row() as never);
  assert.equal(m.risk.initialMarginBps, 200);
  assert.equal(m.risk.maxLeverageBps, 500000);
  assert.equal(m.risk.minFillNotional, 10000000000000000000n);
  assert.equal(m.risk.maxOpenInterest, 25000000000000000000n);
});

test("a market listed but never parameterised decodes to zeros, not NaN", () => {
  // `Market.params` defaults to '{}' in the schema, and `MarketListed` fires
  // before `MarketParamsSet`, so this row genuinely exists between two blocks.
  const m = marketFromRow(row({ params: {} }) as never);
  assert.equal(m.risk.initialMarginBps, 0);
  assert.equal(m.risk.minFillNotional, 0n);
  assert.ok(!Number.isNaN(m.risk.maxLeverageBps));
});

test("null params decode to zeros", () => {
  const r = riskFromParams(null);
  assert.equal(r.maxOpenInterest, 0n);
  assert.equal(r.maintenanceMarginBps, 0);
});

test("an unknown params field is ignored rather than fatal", () => {
  // The struct gains fields on chain; a client that predates one must not break.
  const m = marketFromRow(row({ params: { initialMarginBps: 200, somethingNew: "7" } }) as never);
  assert.equal(m.risk.initialMarginBps, 200);
});

test("display metadata is merged in, and the database wins on symbol", () => {
  const m = marketFromRow(row() as never);
  assert.equal(m.symbol, "BTC-PERP");
  assert.equal(m.priceDecimals, 1, "from MARKET_DISPLAY");
  assert.equal(m.tvSymbol, "COINBASE:BTCUSD");
});

test("a market with no display entry still decodes", () => {
  const m = marketFromRow(row({ symbol: "DOGE-PERP", id: 99 }) as never);
  assert.equal(m.symbol, "DOGE-PERP");
  assert.equal(m.marketId, 99);
  assert.ok(m.tickSizes.length > 0);
});

// ─── Statements ──────────────────────────────────────────────────────────────

test("every read is scoped to one network, as a parameter", async () => {
  for (const run of [
    (sql: SqlClient) => listMarkets(sql, "arc-testnet"),
    (sql: SqlClient) => listActiveMarkets(sql, "arc-testnet"),
    (sql: SqlClient) => getMarketBySymbol(sql, "arc-testnet", "BTC-PERP"),
  ]) {
    const sql = stubSql([]);
    await run(sql);
    const [call] = sql.calls;
    // Unscoped, these would return the other venue's markets — the rows are in
    // the same table, told apart only by this column.
    assert.match(call.text, /"network" = \$1/, call.text);
    assert.equal(call.params[0], "arc-testnet");
    assert.ok(!call.text.includes("arc-testnet"), "network must be bound, not interpolated");
  }
});

test("listActiveMarkets filters on active", async () => {
  const sql = stubSql([]);
  await listActiveMarkets(sql, "arc-testnet");
  assert.match(sql.calls[0].text, /"active" = true/);
});

test("listMarkets does not filter on active", async () => {
  // Listing every market, active or not, is what the admin views need;
  // narrowing it here would hide a market governance has listed but not yet
  // activated. `"active"` is still SELECTed — it is the WHERE that must not
  // mention it, so assert on the clause rather than the whole statement.
  const sql = stubSql([]);
  await listMarkets(sql, "arc-testnet");
  const where = sql.calls[0].text.slice(sql.calls[0].text.indexOf("WHERE"));
  assert.ok(!where.includes('"active"'), where);
});

test("the symbol lookup binds the symbol", async () => {
  const sql = stubSql([]);
  await getMarketBySymbol(sql, "arc-testnet", "BTC-PERP");
  assert.deepEqual(sql.calls[0].params, ["arc-testnet", "BTC-PERP"]);
});

test("a missing market is null, not a throw", async () => {
  assert.equal(await getMarketBySymbol(stubSql([]), "arc-testnet", "NOPE-PERP"), null);
});

test("rows map through in order", async () => {
  const sql = stubSql([row({ id: 1, symbol: "ETH-PERP" }), row({ id: 2, symbol: "BTC-PERP" })]);
  const markets = await listMarkets(sql, "arc-testnet");
  assert.deepEqual(markets.map((m) => m.symbol), ["ETH-PERP", "BTC-PERP"]);
});
