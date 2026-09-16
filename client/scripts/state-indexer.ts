#!/usr/bin/env tsx
/**
 * State Indexer — polls deployed Soroban contracts and syncs state to Neon DB.
 *
 * Updates:
 *   - Market.lastOraclePrice    from perp-oracle-adapter
 *   - Market.longOpenInterest   from perp-engine
 *   - Market.shortOpenInterest  from perp-engine
 *   - Market.fundingLongIndex   from perp-engine
 *   - Market.fundingShortIndex  from perp-engine
 *   - Position rows             from perp-engine (for funded accounts)
 *
 * Runs independently of the oracle keeper. Safe to run 24/7.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/state-indexer.ts
 *   or via package.json: npm run dev:indexer
 */

import {
  Keypair,
  Account,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { neon, type NeonQueryFunction } from "../lib/sql";
import { ACTIVE_MARKETS, CONTRACTS, NETWORK } from "../config";

type Sql = NeonQueryFunction<false, false>;

const INDEXER_MARKETS = Object.values(ACTIVE_MARKETS).map((m) => ({
  id: m.marketId,
  symbol: m.symbol,
  oracleSymbol: m.oracleSymbol,
  settlementAsset: m.settlementAsset,
}));
const POLL_INTERVAL_MS = 5_000;
const PRICE_PRECISION = 1e18;

// ── Simulation helper (synthetic account — no on-chain lookup needed) ─────────

const _simKp = Keypair.random();
let _simSeq = 100;

function getSimAccount() {
  return new Account(_simKp.publicKey(), (_simSeq++).toString());
}

async function simulateRead(
  server: sorobanRpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<unknown | null> {
  const account = getSimAccount();
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: "500000", networkPassphrase: NETWORK.passphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(0)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) return null;
  const success = sim as sorobanRpc.Api.SimulateTransactionSuccessResponse;
  const retval = success.result?.retval;
  return retval ? scValToNative(retval) : null;
}

// ── Indexer tick ──────────────────────────────────────────────────────────────

async function indexMarket(
  server: sorobanRpc.Server,
  sql: Sql,
  market: { id: number; symbol: string; oracleSymbol: string; settlementAsset: string }
) {
  const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
  const marketId = market.id;

  const [fundingRaw, oraclePriceRaw] = await Promise.allSettled([
    simulateRead(server, CONTRACTS.engine, "funding_state",      [u32(marketId)]),
    simulateRead(server, CONTRACTS.oracleAdapter, "get_price",   [
      nativeToScVal(market.oracleSymbol, { type: "symbol" }),
      xdr.ScVal.scvVoid(),
    ]),
  ]);

  const funding = fundingRaw.status === "fulfilled" ? fundingRaw.value as Record<string, unknown> | null : null;
  const oraclePrice = oraclePriceRaw.status === "fulfilled" ? oraclePriceRaw.value as Record<string, unknown> | null : null;

  const longOI = await simulateRead(server, CONTRACTS.engine, "long_open_interest",  [u32(marketId)]);
  const shortOI = await simulateRead(server, CONTRACTS.engine, "short_open_interest", [u32(marketId)]);

  const updates: Record<string, string | number> = {
    updatedAt: new Date().toISOString(),
  };

  if (longOI !== null)  updates["longOpenInterest"]  = String(longOI);
  if (shortOI !== null) updates["shortOpenInterest"] = String(shortOI);

  if (funding) {
    updates["fundingLongIndex"]  = String(funding["long_index"]  ?? "0");
    updates["fundingShortIndex"] = String(funding["short_index"] ?? "0");
  }

  if (oraclePrice) {
    updates["lastOraclePrice"] = String((oraclePrice as Record<string,unknown>)["price"] ?? "0");
  }

  // Upsert (not a plain UPDATE): if the Market row is ever missing — a fresh
  // DB, a reset, a migration that never got a companion seed step — this
  // recreates it from the on-chain config within one poll tick instead of
  // silently no-op'ing forever. (Root cause of the mainnet incident where
  // "Market" had zero rows: the deploy pipeline never seeded it and every
  // prior tick here was an UPDATE ... WHERE id = X against a row that didn't
  // exist, so the matcher's oracle-band filter fail-closed on every order.)
  const dynamicCols = Object.keys(updates).filter((k) => k !== "updatedAt");
  const insertCols = ["id", "symbol", "settlementAsset", "active", ...dynamicCols, "updatedAt", "createdAt"];
  const insertVals = [
    String(marketId),
    `'${market.symbol.replace(/'/g, "''")}'`,
    `'${market.settlementAsset.replace(/'/g, "''")}'`,
    "true",
    ...dynamicCols.map((k) => `'${String(updates[k]).replace(/'/g, "''")}'`),
    "NOW()",
    "NOW()",
  ];
  const conflictSet = dynamicCols
    .map((k) => `"${k}" = EXCLUDED."${k}"`)
    .concat(`"updatedAt" = NOW()`)
    .join(", ");

  await sql`
    INSERT INTO "Market" (${sql.unsafe(insertCols.map((c) => `"${c}"`).join(", "))})
    VALUES (${sql.unsafe(insertVals.join(", "))})
    ON CONFLICT (id) DO UPDATE SET ${sql.unsafe(conflictSet)}
  `;

  // Update lastOraclePrice in market store to show in header
  if (oraclePrice) {
    const oraclePriceNum = Number((oraclePrice as Record<string,unknown>)["price"] ?? 0);
    const humanPrice = oraclePriceNum / PRICE_PRECISION;
    process.stdout.write(`  market ${marketId}: oracle=$${humanPrice.toFixed(4)} longOI=${String(longOI ?? 0).slice(0,6)} shortOI=${String(shortOI ?? 0).slice(0,6)}\n`);
  } else {
    process.stdout.write(`  market ${marketId}: oracle=stale longOI=${String(longOI ?? 0).slice(0,6)}\n`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("❌  DATABASE_URL is not set in your .env.local");
    process.exit(1);
  }

  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const sql = neon(dbUrl);

  console.log("✓ State indexer starting");
  console.log(`  Network  : ${NETWORK.name}`);
  console.log(`  Markets  : ${INDEXER_MARKETS.map((m) => m.symbol).join(", ")}`);
  console.log(`  Interval : ${POLL_INTERVAL_MS / 1000}s`);

  const { runAggregation } = await import("./stats-aggregator");
  let tickCount = 0;

  async function tick() {
    const now = new Date().toISOString().slice(11, 19);
    process.stdout.write(`[${now}] polling contracts...\n`);
    for (const market of INDEXER_MARKETS) {
      await indexMarket(server, sql, market).catch((e: Error) => {
        process.stdout.write(`  ✗ market ${market.id}: ${e.message?.slice(0, 80)}\n`);
      });
    }

    // Roll leaderboard/portfolio aggregates roughly every ~30s (every 6th tick
    // at the default 5s cadence) so stats stay fresh without hammering the DB.
    if (tickCount % 6 === 0) {
      await runAggregation(sql as never)
        .then((r) => process.stdout.write(`  ↳ stats: ${r.stats} trader rows, ${r.analytics} analytics\n`))
        .catch((e: Error) => process.stdout.write(`  ✗ stats aggregation: ${e.message?.slice(0, 80)}\n`));
    }
    tickCount++;
  }

  await tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

run().catch(console.error);
