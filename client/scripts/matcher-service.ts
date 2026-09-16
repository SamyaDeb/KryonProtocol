#!/usr/bin/env tsx
/**
 * matcher-service.ts
 *
 * Off-chain CLOB matching engine. Polls the DB for resting limit orders,
 * runs price-time priority matching, writes Fill records, and updates
 * Order.filledSize. The trade feed, candlesticks, and orderbook all update
 * in real time once this is running.
 *
 * On-chain settlement (settle_fill on perp-order-gateway) requires signed
 * auth entries from both maker and taker — this service handles the
 * off-chain matching and DB state; settlement is submitted when both parties'
 * Freighter auth entries are collected (see settle-fill route, future work).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/matcher-service.ts
 *   or: npm run dev:matcher
 */

import { neon, neonConfig, type NeonQueryFunction } from "../lib/sql";

// Keep fetch connections alive — prevents "fetch failed" on Neon serverless
// after idle periods by re-establishing the HTTP connection as needed.
neonConfig.fetchConnectionCache = true;
import { ACTIVE_MARKETS, NETWORK } from "../config";
import { simulateSettleFill, submitSettleFillSigned } from "../lib/stellar/settlement";
import { assertRequiredSecrets, assertNoPublicSecretLeak } from "../lib/secrets-check";
import { verifySignedMessage } from "../lib/market/signed-intent";
import { orderSettlementMessage, pubkeyHexFromAddress } from "../lib/market/signing-message";
assertRequiredSecrets(["DATABASE_URL"]);
assertNoPublicSecretLeak();

/**
 * The settlement fee-payer / operator key for THIS network.
 *
 * Accepts the network-suffixed name as well as the legacy unsuffixed one, the
 * same precedence `lib/network-server.ts#matcherOperatorSecret` uses for the
 * API. The two had drifted: the API learned `MATCHER_OPERATOR_SECRET_TESTNET`
 * when the deployment went multi-network, this script never did, and it never
 * falls back to the other network's key — that would sign a settlement with an
 * account that cannot pay on the target chain.
 *
 * Missing it is FATAL rather than tolerated. Without a key `executeSettlement`
 * returns false for every match, and the caller's `if (!settled) rollbackFill`
 * then deletes each fill it just wrote. The service goes on logging "fill"
 * lines while leaving no fills behind, the book stays visibly crossed because
 * nothing ever clears, and every downstream volume/trader figure reads zero —
 * a silent, total outage that looks like a healthy process. Crash instead.
 */
const OPERATOR_SECRET = (() => {
  const suffixed =
    NETWORK.name === "mainnet"
      ? process.env.MATCHER_OPERATOR_SECRET_MAINNET
      : process.env.MATCHER_OPERATOR_SECRET_TESTNET;
  const secret = suffixed || process.env.MATCHER_OPERATOR_SECRET;
  if (!secret) {
    const suffixedName = `MATCHER_OPERATOR_SECRET_${NETWORK.name.toUpperCase()}`;
    console.error(
      `❌  No settlement operator key for network "${NETWORK.name}". ` +
        `Set ${suffixedName} or MATCHER_OPERATOR_SECRET.\n` +
        `    Without it every match is written and then immediately rolled back, ` +
        `so the venue silently records no trades at all.`
    );
    process.exit(1);
  }
  return secret;
})();

type Sql = NeonQueryFunction<false, false>;
const NETWORK_NAME = NETWORK.name;
const PRICE_PRECISION = 1e18;
const AMOUNT_PRECISION = 1e7;
const POLL_INTERVAL_MS = Number(process.env.MATCHER_INTERVAL_MS ?? "1000");
const MATCHER_MARKETS = Object.values(ACTIVE_MARKETS).map((m) => ({ id: m.marketId, symbol: m.symbol }));

// ── Types ────────────────────────────────────────────────────────────────────

interface RestingOrder {
  id: string;
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;        // raw 1e7
  limitPrice: bigint;  // raw 1e18; 0 = market order
  reduceOnly: boolean;
  nonce: bigint;
  expiryTs: bigint;
  filledSize: bigint;
  createdAt: Date;
  signature: string | null;
}

interface MatchResult {
  maker: RestingOrder;
  taker: RestingOrder;
  fillSize: bigint;
  fillPrice: bigint;
}

// ── Order loading ─────────────────────────────────────────────────────────────

function mapOrderRow(r: Record<string, unknown>): RestingOrder {
  return {
    id:         String(r.id),
    owner:      String(r.owner),
    marketId:   Number(r.marketId),
    isLong:     Boolean(r.isLong),
    size:       BigInt(r.size as string),
    limitPrice: BigInt(r.limitPrice as string),
    reduceOnly: Boolean(r.reduceOnly),
    nonce:      BigInt(r.nonce as string),
    expiryTs:   BigInt(r.expiryTs as string),
    filledSize: BigInt(r.filledSize as string),
    createdAt:  new Date(r.createdAt as string),
    signature:  r.signature != null ? String(r.signature) : null,
  };
}

async function loadRestingOrders(sql: Sql, marketId: number): Promise<RestingOrder[]> {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const rows = await sql`
    SELECT
      id, owner, "marketId", "isLong",
      size::text, "limitPrice"::text, "reduceOnly",
      nonce::text, "expiryTs"::text, "filledSize"::text,
      "createdAt", signature
    FROM "Order"
    WHERE
      "marketId"   = ${marketId}
      AND cancelled = false
      AND "limitPrice" <> '0'
      AND "filledSize"::numeric < size::numeric
      AND ("expiryTs"::numeric = 0 OR "expiryTs"::numeric > ${nowSec.toString()})
    ORDER BY "limitPrice"::numeric ASC, "createdAt" ASC
  `;
  return rows.map(mapOrderRow);
}

async function loadMarketOrders(sql: Sql, marketId: number): Promise<RestingOrder[]> {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const rows = await sql`
    SELECT
      id, owner, "marketId", "isLong",
      size::text, "limitPrice"::text, "reduceOnly",
      nonce::text, "expiryTs"::text, "filledSize"::text,
      "createdAt", signature
    FROM "Order"
    WHERE
      "marketId"   = ${marketId}
      AND cancelled = false
      AND "limitPrice" = '0'
      AND "filledSize"::numeric < size::numeric
      AND ("expiryTs"::numeric = 0 OR "expiryTs"::numeric > ${nowSec.toString()})
    ORDER BY "createdAt" ASC
  `;
  return rows.map(mapOrderRow);
}

// ── Price-time priority matching ─────────────────────────────────────────────

/**
 * Single-pass matching engine supporting both limit and market orders.
 *
 * Pass 1 – market orders vs resting limit orders
 *   Market orders are always taker; fill price = resting limit order's price.
 *   Market buys  hit the cheapest available ask.
 *   Market sells hit the highest available bid.
 *
 * Pass 2 – limit vs limit (price-time priority, unchanged behaviour)
 *
 * A shared pendingFills map carries partial-fill accounting across both passes
 * so the same liquidity is never consumed twice.
 */
function matchAll(limitOrders: RestingOrder[], marketOrders: RestingOrder[]): MatchResult[] {
  const pendingFills = new Map<string, bigint>();
  const results: MatchResult[] = [];

  const remaining = (o: RestingOrder) =>
    o.size - o.filledSize - (pendingFills.get(o.id) ?? 0n);

  const add = (a: string, delta: bigint) =>
    pendingFills.set(a, (pendingFills.get(a) ?? 0n) + delta);

  // Pre-sort limit sides once
  const limitBids = limitOrders
    .filter((o) => o.isLong)
    .sort((a, b) => Number(b.limitPrice - a.limitPrice) || a.createdAt.getTime() - b.createdAt.getTime());

  const limitAsks = limitOrders
    .filter((o) => !o.isLong)
    .sort((a, b) => Number(a.limitPrice - b.limitPrice) || a.createdAt.getTime() - b.createdAt.getTime());

  // ── Pass 1: market orders vs limit resting book ──────────────────────────

  // Market SELLS → hit best bids (highest first)
  for (const mo of marketOrders.filter((o) => !o.isLong)) {
    for (const bid of limitBids) {
      if (bid.owner === mo.owner) continue;
      const bidRem = remaining(bid);
      const moRem  = remaining(mo);
      if (bidRem <= 0n || moRem <= 0n) continue;
      const fillSize = bidRem < moRem ? bidRem : moRem;
      add(bid.id, fillSize);
      add(mo.id,  fillSize);
      results.push({ maker: bid, taker: mo, fillSize, fillPrice: bid.limitPrice });
      if (remaining(mo) <= 0n) break;
    }
  }

  // Market BUYS → hit best asks (lowest first)
  for (const mo of marketOrders.filter((o) => o.isLong)) {
    for (const ask of limitAsks) {
      if (ask.owner === mo.owner) continue;
      const askRem = remaining(ask);
      const moRem  = remaining(mo);
      if (askRem <= 0n || moRem <= 0n) continue;
      const fillSize = askRem < moRem ? askRem : moRem;
      add(ask.id, fillSize);
      add(mo.id,  fillSize);
      results.push({ maker: ask, taker: mo, fillSize, fillPrice: ask.limitPrice });
      if (remaining(mo) <= 0n) break;
    }
  }

  // ── Pass 2: limit vs limit (price-time priority) ──────────────────────────

  for (const bid of limitBids) {
    for (const ask of limitAsks) {
      if (bid.owner === ask.owner) continue;
      if (bid.limitPrice < ask.limitPrice) break;
      const bidRem = remaining(bid);
      const askRem = remaining(ask);
      if (bidRem <= 0n || askRem <= 0n) continue;
      const fillSize   = bidRem < askRem ? bidRem : askRem;
      const makerFirst = bid.createdAt <= ask.createdAt;
      const maker      = makerFirst ? bid : ask;
      const taker      = makerFirst ? ask : bid;
      add(bid.id, fillSize);
      add(ask.id, fillSize);
      results.push({ maker, taker, fillSize, fillPrice: maker.limitPrice });
      if (remaining(bid) <= 0n) break;
    }
  }

  return results;
}

// ── Persist a fill ────────────────────────────────────────────────────────────

function pseudoTxHash(maker: RestingOrder, taker: RestingOrder, fillSize: bigint): string {
  // Deterministic fake hash for off-chain fills — prefixed so they're identifiable
  const raw = `db:${maker.owner}:${maker.nonce}:${taker.owner}:${taker.nonce}:${fillSize}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = Math.imul(31, h) + raw.charCodeAt(i) | 0;
  }
  return "dbfill" + Math.abs(h).toString(16).padStart(58, "0");
}

async function persistFill(sql: Sql, match: MatchResult): Promise<boolean> {
  const { maker, taker, fillSize, fillPrice } = match;
  const txHash = pseudoTxHash(maker, taker, fillSize);

  try {
    const inserted = await sql`
      INSERT INTO "Fill" (
        network, "marketId",
        maker, "makerNonce",
        taker, "takerNonce",
        "fillSize", "fillPrice",
        "feeMaker", "feeTaker",
        "txHash", ledger,
        "createdAt"
      ) VALUES (
        ${NETWORK_NAME},
        ${maker.marketId},
        ${maker.owner}, ${maker.nonce.toString()},
        ${taker.owner}, ${taker.nonce.toString()},
        ${fillSize.toString()}, ${fillPrice.toString()},
        '0', '0',
        ${txHash}, 0,
        NOW()
      )
      ON CONFLICT (network, "txHash", maker, "makerNonce", taker, "takerNonce") DO NOTHING
      RETURNING id
    `;

    // If DO NOTHING fired (duplicate fill), skip the filledSize updates
    if (!inserted || inserted.length === 0) return false;

    // H3: Atomic filledSize increment — read-modify-write in a single statement.
    // The WHERE guard ensures we never overflow size (treats as duplicate if it would).
    const makerUpdated = await sql`
      UPDATE "Order"
      SET "filledSize" = ("filledSize"::numeric + ${fillSize.toString()}::numeric)::text,
          "updatedAt"  = NOW()
      WHERE id = ${maker.id}
        AND "filledSize"::numeric + ${fillSize.toString()}::numeric <= size::numeric
      RETURNING id
    `;
    if (!makerUpdated || makerUpdated.length === 0) return false;

    const takerUpdated = await sql`
      UPDATE "Order"
      SET "filledSize" = ("filledSize"::numeric + ${fillSize.toString()}::numeric)::text,
          "updatedAt"  = NOW()
      WHERE id = ${taker.id}
        AND "filledSize"::numeric + ${fillSize.toString()}::numeric <= size::numeric
      RETURNING id
    `;
    if (!takerUpdated || takerUpdated.length === 0) return false;

    // Update Market.lastPrice and volume
    const fillValue = (fillSize * fillPrice) / BigInt(Math.round(PRICE_PRECISION));
    await sql`
      UPDATE "Market"
      SET
        "lastPrice" = ${fillPrice.toString()},
        volume      = (volume::numeric + ${fillValue.toString()}::numeric)::text,
        "updatedAt" = NOW()
      WHERE id = ${maker.marketId}
    `;

    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Duplicate fill is fine — another instance may have processed it
    if (msg.includes("unique") || msg.includes("duplicate")) return false;
    process.stderr.write(`  ✗ persist fill: ${msg.slice(0, 100)}\n`);
    return false;
  }
}

// Undo a persisted fill when on-chain settlement permanently fails, so the
// orders return to the book and get re-matched on a later tick. Keeps the DB
// orderbook/trade feed consistent with on-chain truth.
async function rollbackFill(sql: Sql, match: MatchResult): Promise<void> {
  const { maker, taker, fillSize, fillPrice } = match;
  const txHash = pseudoTxHash(maker, taker, fillSize);
  try {
    await sql`DELETE FROM "Fill" WHERE network = ${NETWORK_NAME} AND "txHash" = ${txHash}`;

    // Give back the volume `persistFill` added. This was missing, so the
    // counter only ever went up: a rolled-back fill left its notional behind
    // permanently, and a venue that rolled back every match still accumulated
    // "volume" indefinitely. That is why Market.volume reads ~$384M on mainnet
    // against ~$455 of real fills, and ~$19.6M on a testnet with none at all.
    // GREATEST(0, …) because an already-corrupted counter must not go negative.
    const fillValue = (fillSize * fillPrice) / BigInt(Math.round(PRICE_PRECISION));
    await sql`
      UPDATE "Market"
      SET volume = GREATEST(0, volume::numeric - ${fillValue.toString()}::numeric)::text,
          "updatedAt" = NOW()
      WHERE id = ${maker.marketId}
    `;
    await sql`
      UPDATE "Order"
      SET "filledSize" = GREATEST(0, ("filledSize"::numeric - ${fillSize.toString()}::numeric))::text,
          "updatedAt"  = NOW()
      WHERE id = ${maker.id}
    `;
    await sql`
      UPDATE "Order"
      SET "filledSize" = GREATEST(0, ("filledSize"::numeric - ${fillSize.toString()}::numeric))::text,
          "updatedAt"  = NOW()
      WHERE id = ${taker.id}
    `;
    process.stderr.write(`  ↩ rolled back fill — orders returned to book for retry\n`);
  } catch (e) {
    process.stderr.write(`  ✗ rollback failed: ${(e as Error).message?.slice(0, 100)}\n`);
  }
}

// ── Queue on-chain settlement after a fill ────────────────────────────────────
// settle_fill requires the matcher/operator auth plus maker/taker Soroban auth
// entries. The matcher simulates the tx, stores auth entries in TxJob, and the
// connected clients sign via /api/settlements/[id]/sign.

/**
 * Leave a durable trace when a settlement attempt fails.
 *
 * Every failure path used to just `return false`, whereupon the caller rolled
 * the fill back and deleted it. Nothing was written anywhere, so from outside
 * the process a venue that settled perfectly and one that had been discarding
 * every trade for days looked *identical*: no fills, no jobs, no errors — just
 * an empty database and a book that never cleared. Diagnosing it required
 * reading container logs, which is exactly what nobody has during an incident.
 *
 * A FAILED TxJob makes it queryable instead: it feeds `settlementsFailed` on
 * the activity dashboard and carries `lastError` for whoever investigates. The
 * unique key is (network, kind, payloadHash), so a match that keeps failing
 * updates one row rather than accumulating thousands, and a later success
 * flips that same row to CONFIRMED.
 */
async function recordSettlementFailure(sql: Sql, fillHash: string, reason: string): Promise<void> {
  try {
    await sql`
      INSERT INTO "TxJob" (
        network, kind, "payloadHash", status, "lastError", attempts,
        "nextAttemptAt", "createdAt", "updatedAt"
      ) VALUES (
        ${NETWORK_NAME}, 'settle_fill', ${fillHash}, 'FAILED', ${reason}, 1,
        NOW(), NOW(), NOW()
      )
      ON CONFLICT (network, kind, "payloadHash") DO UPDATE SET
        status      = 'FAILED',
        "lastError" = EXCLUDED."lastError",
        attempts    = "TxJob".attempts + 1,
        "updatedAt" = NOW()
    `;
  } catch (e) {
    // Never let bookkeeping mask the original failure.
    process.stderr.write(`  ✗ could not record settlement failure: ${(e as Error).message?.slice(0, 80)}\n`);
  }
}

async function executeSettlement(sql: Sql, match: MatchResult): Promise<boolean> {
  // Key separation: settlement uses ONLY the dedicated operator key. No
  // fallback to the oracle key — one key must never serve two roles.
  // Presence is guaranteed at startup (see OPERATOR_SECRET), so there is no
  // longer a "no key" branch here quietly returning false and binning the fill.
  const feePayerSecret = OPERATOR_SECRET;

  const fillHash = pseudoTxHash(match.maker, match.taker, match.fillSize);

  // C2 fast path: both parties have stored settlement signatures — submit directly.
  if (match.maker.signature && match.taker.signature) {
    const settled = await submitSettleFillSigned({
      maker: {
        owner:      match.maker.owner,
        marketId:   match.maker.marketId,
        isLong:     match.maker.isLong,
        size:       match.maker.size,
        limitPrice: match.maker.limitPrice,
        reduceOnly: match.maker.reduceOnly,
        nonce:      match.maker.nonce,
        expiryTs:   match.maker.expiryTs,
      },
      taker: {
        owner:      match.taker.owner,
        marketId:   match.taker.marketId,
        isLong:     match.taker.isLong,
        size:       match.taker.size,
        limitPrice: match.taker.limitPrice,
        reduceOnly: match.taker.reduceOnly,
        nonce:      match.taker.nonce,
        expiryTs:   match.taker.expiryTs,
      },
      fillSize:      match.fillSize,
      fillPrice:     match.fillPrice,
      fillHash,
      feePayerSecret,
      makerSig: match.maker.signature,
      takerSig: match.taker.signature,
    });

    if (settled.hash) {
      process.stdout.write(`  ✓ settled signed: ${settled.hash.slice(0, 12)}...\n`);
      await sql`
        INSERT INTO "TxJob" (network, kind, "payloadHash", "unsignedXdr", status, "submittedHash", "nextAttemptAt", "createdAt", "updatedAt")
        VALUES (${NETWORK_NAME}, 'settle_fill', ${fillHash}, '{}', 'CONFIRMED', ${settled.hash}, NOW(), NOW(), NOW())
        ON CONFLICT (network, kind, "payloadHash") DO UPDATE SET status = 'CONFIRMED', "submittedHash" = EXCLUDED."submittedHash", "updatedAt" = NOW()
      `;
      return true;
    }
    // The specific reason, not just "returned no tx hash": a job that retries
    // for hours is useless to debug without it.
    await recordSettlementFailure(sql, fillHash, `signed fast path: ${settled.reason}`);
    return false;
  }

  // Fallback: auth-entry queue (old path for orders without stored signatures).
  const pending = await simulateSettleFill({
    maker: {
      owner:      match.maker.owner,
      marketId:   match.maker.marketId,
      isLong:     match.maker.isLong,
      size:       match.maker.size,
      limitPrice: match.maker.limitPrice,
      reduceOnly: match.maker.reduceOnly,
      nonce:      match.maker.nonce,
      expiryTs:   match.maker.expiryTs,
    },
    taker: {
      owner:      match.taker.owner,
      marketId:   match.taker.marketId,
      isLong:     match.taker.isLong,
      size:       match.taker.size,
      limitPrice: match.taker.limitPrice,
      reduceOnly: match.taker.reduceOnly,
      nonce:      match.taker.nonce,
      expiryTs:   match.taker.expiryTs,
    },
    fillSize:      match.fillSize,
    fillPrice:     match.fillPrice,
    fillHash,
    feePayerSecret,
  });

  if (!pending) {
    process.stderr.write(`  ✗ settlement simulation failed\n`);
    await recordSettlementFailure(sql, fillHash, "simulateSettleFill returned null (auth-entry path)");
    return false;
  }

  const payload = {
    ...pending,
    pendingTxHash: fillHash,
    makerNonce: match.maker.nonce.toString(),
    takerNonce: match.taker.nonce.toString(),
  };

  await sql`
    INSERT INTO "TxJob" (
      network, kind, "payloadHash", "unsignedXdr", status, "nextAttemptAt", "createdAt", "updatedAt"
    ) VALUES (
      ${NETWORK_NAME}, 'settle_fill', ${fillHash}, ${JSON.stringify(payload)}, 'QUEUED', NOW(), NOW(), NOW()
    )
    ON CONFLICT (network, kind, "payloadHash")
    DO UPDATE SET "unsignedXdr" = EXCLUDED."unsignedXdr", "updatedAt" = NOW()
  `;

  process.stdout.write(`  ✓ settlement queued for maker/taker auth: ${fillHash}\n`);
  return true;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function fmtPrice(raw: bigint) {
  return (Number(raw) / PRICE_PRECISION).toFixed(4);
}

function fmtSize(raw: bigint) {
  return (Number(raw) / AMOUNT_PRECISION).toFixed(4);
}

// ── Oracle price band ─────────────────────────────────────────────────────────
// The engine rejects any fill whose price deviates more than
// max_execution_deviation_bps from the oracle (Error #16, PriceOutsideBand).
// Matching such a fill anyway just burns a simulation and rolls back — and a
// crossed pair parked outside the band loops that failure every tick (seen
// live 2026-07-05: two wallets crossing at ±100% of mark). Pre-check the band
// against the indexer-synced oracle price and skip those matches off-chain.

const MAX_DEVIATION_BPS = BigInt(process.env.MATCHER_MAX_DEVIATION_BPS ?? "1000");

async function loadOraclePrice(sql: Sql, marketId: number): Promise<bigint | null> {
  const rows = await sql`SELECT "lastOraclePrice"::text FROM "Market" WHERE id = ${marketId}`;
  if (!rows.length) return null;
  const p = BigInt((rows[0].lastOraclePrice as string) ?? "0");
  return p > 0n ? p : null;
}

function withinOracleBand(fillPrice: bigint, oracle: bigint): boolean {
  const delta = (oracle * MAX_DEVIATION_BPS) / 10_000n;
  return fillPrice >= oracle - delta && fillPrice <= oracle + delta;
}

// ── Poison-order quarantine ───────────────────────────────────────────────────
// An order whose stored signature cannot verify on-chain (settle_fill_signed
// is SEP-53-only) would loop match → sim-fail → rollback forever. Verify the
// signature off-chain before matching and cancel any order that fails.

function settlementSigValid(o: RestingOrder): boolean {
  if (!o.signature) return true; // legacy auth-entry path still handles these
  const msg = orderSettlementMessage(NETWORK.passphrase, pubkeyHexFromAddress(o.owner), {
    owner: o.owner,
    market_id: o.marketId,
    is_long: o.isLong,
    size: o.size.toString(),
    limit_price: o.limitPrice.toString(),
    reduce_only: o.reduceOnly,
    nonce: o.nonce.toString(),
    expiry_ts: o.expiryTs.toString(),
  });
  return verifySignedMessage(o.owner, msg, o.signature);
}

async function cancelPoisonOrder(sql: Sql, o: RestingOrder): Promise<void> {
  await sql`UPDATE "Order" SET cancelled = true, "updatedAt" = NOW() WHERE id = ${o.id}`;
  process.stderr.write(
    `  ⚠ cancelled order ${o.id.slice(0, 20)}… — stored signature cannot verify on-chain\n`
  );
}

// ── Main loop ─────────────────────────────────────────────────────────────────

/**
 * One cheap indexed probe telling us which markets have ANY open order.
 *
 * tick() used to run two full order-loading queries per market per second
 * unconditionally — 2 q/s with one market, but 16 q/s once eight markets went
 * live, which is ~1.4M queries/day against a book that is usually empty. That
 * load is also why the database's compute never idles.
 *
 * A market with no open orders has nothing to match, so this replaces the
 * per-market loads with a single GROUP BY on ticks where the book is quiet.
 */
async function marketsWithOpenOrders(sql: Sql): Promise<Set<number>> {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const ids = MATCHER_MARKETS.map((m) => m.id);
  const rows = await sql`
    SELECT "marketId"
    FROM "Order"
    WHERE "marketId" = ANY(${ids})
      AND cancelled = false
      AND "filledSize"::numeric < "size"::numeric
      AND "expiryTs" > ${nowSec.toString()}::bigint
    GROUP BY "marketId"
  `;
  return new Set(rows.map((r: Record<string, unknown>) => Number(r["marketId"])));
}

async function tick(sql: Sql) {
  let totalFills = 0;

  const active = await marketsWithOpenOrders(sql);
  if (active.size === 0) return;

  for (const market of MATCHER_MARKETS) {
    if (!active.has(market.id)) continue;
    const [limitOrders, marketOrders] = await Promise.all([
      loadRestingOrders(sql, market.id),
      loadMarketOrders(sql, market.id),
    ]);
    if (limitOrders.length === 0 && marketOrders.length === 0) continue;

    const oracle = await loadOraclePrice(sql, market.id);
    // Exclude out-of-band RESTING orders before matching, not just their
    // matches after: price-time priority would otherwise allocate incoming
    // volume to an unsettleable top-of-book quote (e.g. a stale ask far below
    // mark), starving every legitimate order behind it. They stay in the DB —
    // if the oracle moves to them they become matchable again.
    const inBandLimits = oracle === null
      ? []
      : limitOrders.filter((o) => withinOracleBand(o.limitPrice, oracle));
    if (inBandLimits.length < limitOrders.length) {
      process.stderr.write(
        `  ⤫ ${limitOrders.length - inBandLimits.length} resting order(s) outside oracle band excluded from matching\n`
      );
    }
    const matches = matchAll(inBandLimits, marketOrders);
    for (const match of matches) {
      // Fail closed: no oracle price → the engine can't accept the fill either.
      if (oracle === null || !withinOracleBand(match.fillPrice, oracle)) {
        process.stderr.write(
          `  ⤫ skip match @ $${fmtPrice(match.fillPrice)} — outside oracle band` +
          ` (oracle ${oracle === null ? "unavailable" : "$" + fmtPrice(oracle)})\n`
        );
        continue;
      }
      let poisoned = false;
      for (const side of [match.maker, match.taker]) {
        if (!settlementSigValid(side)) {
          await cancelPoisonOrder(sql, side);
          poisoned = true;
        }
      }
      if (poisoned) continue;
      const ok = await persistFill(sql, match);
      if (ok) {
        totalFills++;
        const time = new Date().toISOString().slice(11, 19);
        const orderType = match.taker.limitPrice === 0n ? "MKT" : "LMT";
        process.stdout.write(
          `[${time}] ${market.symbol} ${orderType} fill: ${fmtSize(match.fillSize)} @ $${fmtPrice(match.fillPrice)}` +
          `  maker=${match.maker.owner.slice(0, 8)} taker=${match.taker.owner.slice(0, 8)}\n`
        );
        // Queue on-chain settlement. If simulation fails, roll the fill back so
        // the orders return to the book and retry on a later tick.
        try {
          const settled = await executeSettlement(sql, match);
          if (!settled) {
            await rollbackFill(sql, match);
          }
        } catch (e: unknown) {
          const msg = (e as Error).message ?? String(e);
          process.stderr.write(`  ✗ executeSettlement: ${msg.slice(0, 80)}\n`);
          await recordSettlementFailure(
            sql,
            pseudoTxHash(match.maker, match.taker, match.fillSize),
            `executeSettlement threw: ${msg.slice(0, 400)}`
          );
          await rollbackFill(sql, match);
        }
      }
    }

  }

  return totalFills;
}

async function run() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("❌  DATABASE_URL is not set in your .env.local");
    process.exit(1);
  }

  let sql = neon(dbUrl);
  console.log("✓ Matcher service starting");
  console.log(`  Markets  : ${MATCHER_MARKETS.map((m) => m.symbol).join(", ")}`);
  console.log(`  Interval : ${POLL_INTERVAL_MS}ms`);
  console.log(`  Fill type: off-chain match + queued maker/taker auth settlement`);
  console.log("");

  // Print orderbook summary on first tick
  for (const market of MATCHER_MARKETS) {
    const [limitOrders, marketOrders] = await Promise.all([
      loadRestingOrders(sql, market.id),
      loadMarketOrders(sql, market.id),
    ]);
    const bids = limitOrders.filter((o) => o.isLong);
    const asks = limitOrders.filter((o) => !o.isLong);
    console.log(`  ${market.symbol}: ${bids.length} bids, ${asks.length} asks resting, ${marketOrders.length} market orders pending`);
  }
  console.log("");

  let consecutiveErrors = 0;

  // Sequential loop — never overlap ticks, avoids fill race conditions
  while (true) {
    try {
      await tick(sql);
      consecutiveErrors = 0;
    } catch (e: unknown) {
      consecutiveErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`  ✗ tick: ${msg.slice(0, 100)}\n`);

      // On repeated DB errors, recreate the neon client (clears any stale state).
      // Reassign `sql` itself rather than Object.assign onto it — the tagged-
      // template call path invokes the client's own closure, which
      // Object.assign cannot replace, so callers kept hitting the ended pool
      // forever even after "recreating".
      if (consecutiveErrors >= 3) {
        process.stderr.write(`  ⟳ recreating DB connection after ${consecutiveErrors} errors\n`);
        try { await sql.end(); } catch { /* ignore */ }
        sql = neon(dbUrl);
        consecutiveErrors = 0;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

run().catch(console.error);
