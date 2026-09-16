#!/usr/bin/env tsx
/**
 * seed-markets.ts — idempotent Market row seeding.
 *
 * The "Market" table needs one row per configured market (id, symbol,
 * settlementAsset, active) before the off-chain matcher or /api/markets/[id]
 * can do anything useful — the matcher's oracle-band safety filter fails
 * closed (refuses to match ANY order) if it can't read Market.lastOraclePrice,
 * and that column can only ever be populated by state-indexer.ts's poll loop
 * if the row already exists.
 *
 * Found missing entirely on mainnet 2026-07-08: the "kryon_mainnet" database
 * was created fresh (psql CREATE DATABASE + prisma migrate deploy) but no
 * step ever ran an initial INSERT — migrations create the schema, not data.
 * Every resting limit order silently sat unmatched forever as a result.
 *
 * This script is safe to run any number of times (ON CONFLICT DO NOTHING) —
 * run it once right after `prisma migrate deploy` against any fresh database
 * (testnet or mainnet), or any time you suspect the table might be empty.
 * state-indexer.ts also self-heals this on every 5s poll tick as of the same
 * fix, so this script is a belt-and-suspenders convenience, not the only
 * safety net.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/seed-markets.ts
 *   or: npm run db:seed-markets
 */

import { neon, type NeonQueryFunction } from "../lib/sql";
import { ACTIVE_MARKETS } from "../config";

type Sql = NeonQueryFunction<false, false>;

export async function seedMarkets(sql: Sql): Promise<{ id: number; symbol: string; inserted: boolean }[]> {
  const results: { id: number; symbol: string; inserted: boolean }[] = [];
  for (const m of Object.values(ACTIVE_MARKETS)) {
    const rows = await sql`
      INSERT INTO "Market" (id, symbol, "settlementAsset", active, "updatedAt", "createdAt")
      VALUES (${m.marketId}, ${m.symbol}, ${m.settlementAsset}, true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    results.push({ id: m.marketId, symbol: m.symbol, inserted: rows.length > 0 });
  }
  return results;
}

async function run() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("❌  DATABASE_URL is not set");
    process.exit(1);
  }
  const sql = neon(dbUrl);
  const results = await seedMarkets(sql);
  for (const r of results) {
    console.log(`  ${r.inserted ? "✓ seeded" : "· already present"}  market ${r.id} (${r.symbol})`);
  }
}

if (require.main === module) {
  run().catch((e) => { console.error("❌ ", e.message ?? e); process.exit(1); });
}
