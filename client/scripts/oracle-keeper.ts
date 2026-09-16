#!/usr/bin/env tsx
/**
 * Oracle Keeper — publishes active-market prices to the perp-oracle-adapter.
 *
 * Price integrity model:
 *   - Every price is the MEDIAN of up to three independent sources
 *     (Binance, Coinbase, Kraken). At least ORACLE_MIN_SOURCES (default 2)
 *     must respond or the tick is skipped.
 *   - If the surviving sources disagree by more than
 *     ORACLE_MAX_SOURCE_DEVIATION_BPS (default 200 = 2%), the tick is skipped:
 *     a stale-but-honest price (engine halts on staleness) beats a wrong one.
 *   - Reflector is a FOURTH, INDEPENDENT cross-check (never the mark — its
 *     300s resolution is far outside the 120s on-chain staleness guard). If
 *     the CEX median diverges from Reflector's lastprice by more than
 *     REFLECTOR_DIVERGENCE_HALT_BPS, publication for that market HALTS and the
 *     on-chain OracleGuard fail-stops settlement. An attacker who moves all
 *     three CEX feeds still has to move Reflector's node consensus. Markets
 *     without a `reflectorSymbol` (BNB, TRX — absent from Reflector) run on
 *     the CEX median alone.
 *   - USDC is SOURCED, not assumed at $1. If the sourced price departs the peg
 *     by more than USDC_DEPEG_HALT_BPS (default 100 = 1%), USDC publication
 *     halts — collateral valuation goes stale and settlement fail-stops rather
 *     than valuing depegged collateral at par. On testnet only, a $1 fallback
 *     is used when the stablecoin sources are unreachable.
 *
 * Requires:
 *   ORACLE_PUBLISHER_SECRET=S... (Stellar secret key of the authorized publisher)
 *
 * Usage:
 *   ORACLE_PUBLISHER_SECRET=S... npx tsx scripts/oracle-keeper.ts
 *   or via package.json: npm run dev:oracle
 *
 *   npx tsx scripts/oracle-keeper.ts --dry-run
 *     One pass, no signing, no DB, no secrets: prints per market the 3-source
 *     median, the Reflector price, the divergence in bps and the resulting
 *     publish/skip decision. Use it to validate feed coverage before wiring a
 *     new market.
 */

import {
  Keypair,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { neon } from "../lib/sql";
import { ACTIVE_MARKETS, CONTRACTS, NETWORK } from "../config";
import { divergenceBps, reflectorContractId, reflectorLastPrice } from "../lib/stellar/reflector";
import { checkProtocolActivity } from "../lib/oracle-activity";
import { assertRequiredSecrets, assertNoPublicSecretLeak } from "../lib/secrets-check";
// --dry-run only reads public price feeds and the Reflector contract; it never
// signs or submits, so it needs neither the publisher key nor the database.
const DRY_RUN = process.argv.includes("--dry-run");
if (!DRY_RUN) assertRequiredSecrets(["DATABASE_URL", "ORACLE_PUBLISHER_SECRET"]);
assertNoPublicSecretLeak();

const PRICE_PRECISION = BigInt("1000000000000000000"); // 1e18
// Fetch every 8s (fast deviation detection) but PUBLISH only on deviation or
// heartbeat — on mainnet every publish costs real fees (~0.0004 XLM), and
// blind 8s publishing burns ~8.5 XLM/day. Heartbeats MUST stay under the
// on-chain OracleGuard max_age_secs (120s) or settlement fail-stops between
// publishes.
const FETCH_INTERVAL_MS = 8_000;
const PUBLISH_DEVIATION_BPS = Number(process.env.PUBLISH_DEVIATION_BPS ?? "30");
const PUBLISH_HEARTBEAT_SECS = Number(process.env.PUBLISH_HEARTBEAT_SECS ?? "60");
const USDC_PUBLISH_DEVIATION_BPS = Number(process.env.USDC_PUBLISH_DEVIATION_BPS ?? "10");
const USDC_PUBLISH_HEARTBEAT_SECS = Number(process.env.USDC_PUBLISH_HEARTBEAT_SECS ?? "90");
// Activity-aware idling: publishing stops entirely when nothing on-chain
// needs a fresh price (no orders, no settlements, no positions, no vault
// deposits) — see lib/oracle-activity.ts. Checks are cached and fail open.
const ACTIVITY_CHECK_INTERVAL_MS = Number(process.env.ACTIVITY_CHECK_INTERVAL_MS ?? "30000");
const IDLE_GRACE_SECS = Number(process.env.IDLE_GRACE_SECS ?? "900");
const MIN_SOURCES = Number(process.env.ORACLE_MIN_SOURCES ?? "2");
const MAX_SOURCE_DEVIATION_BPS = Number(process.env.ORACLE_MAX_SOURCE_DEVIATION_BPS ?? "200");
const USDC_DEPEG_HALT_BPS = Number(process.env.USDC_DEPEG_HALT_BPS ?? "100");
// USDT0 (LayerZero OFT, mainnet only) is priced off USDT/USD. Publication is
// opt-in because writing to a feed the adapter has not been configured with
// errors: turn this on only AFTER set_feed has run for the USDT0 symbol.
const PUBLISH_USDT0 = (process.env.ORACLE_PUBLISH_USDT0 ?? "false") === "true";
const USDT0_DEPEG_HALT_BPS = Number(process.env.USDT0_DEPEG_HALT_BPS ?? "100");
// Reflector cross-check. Disabled per-market when the market has no
// `reflectorSymbol`; disabled globally with REFLECTOR_GUARD_ENABLED=false.
const REFLECTOR_GUARD_ENABLED = (process.env.REFLECTOR_GUARD_ENABLED ?? "true") !== "false";
const REFLECTOR_DIVERGENCE_HALT_BPS = Number(process.env.REFLECTOR_DIVERGENCE_HALT_BPS ?? "300");
// Ignore Reflector beyond two of its 300s resolutions — a stale cross-check
// is no cross-check, and blocking on one would halt the venue for free.
const REFLECTOR_MAX_AGE_SECS = Number(process.env.REFLECTOR_MAX_AGE_SECS ?? "600");
// Eight markets on one publisher account race the sequence number. Space the
// per-market publishes across the fetch window instead of firing them back to
// back. Kept well inside FETCH_INTERVAL_MS so a tick still finishes in time.
const PUBLISH_STAGGER_MS = Number(process.env.PUBLISH_STAGGER_MS ?? "400");
/**
 * Backdate publish_time so it is never AHEAD of the ledger clock.
 *
 * write_price runs `snapshot.validate(env.ledger().timestamp(), guard)`, whose
 * first check is `publish_time > now → StaleOracle` (protocol-core/oracle.rs:36).
 * During simulation `now` is the LAST CLOSED ledger's close time, which trails
 * wall clock by up to a full ledger (~6s on mainnet). Stamping publish_time
 * with `Date.now()` therefore puts it in the future and EVERY publish
 * fail-stops with Error(Contract, #6) — which is why mainnet published nothing.
 *
 * Verified against mainnet 2026-08-22: now-0s and now-5s fail; now-10s and
 * older simulate cleanly. 15s carries margin over a slow ledger while staying
 * far inside the 120s OracleGuard, so the published price is still fresh.
 */
const PUBLISH_TIME_BACKDATE_SECS = Number(process.env.PUBLISH_TIME_BACKDATE_SECS ?? "15");

/** Ledger-safe publish timestamp: wall clock, backdated past the ledger lag. */
function ledgerSafePublishTime(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) - PUBLISH_TIME_BACKDATE_SECS);
}
const ORACLE_MARKETS = Object.values(ACTIVE_MARKETS).map((m) => ({
  symbol: m.symbol,
  oracleSymbol: m.oracleSymbol,
  baseAsset: m.baseAsset,
  priceSourceSymbol: m.priceSourceSymbol,
  reflectorSymbol: m.reflectorSymbol,
  priceDecimals: m.priceDecimals,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function toI128ScVal(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

function toU64ScVal(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}

// ── Independent price sources ────────────────────────────────────────────────
// Each returns a float USD price or throws. A 5s timeout keeps one slow venue
// from stalling the whole tick.

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  } as RequestInit);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function binancePrice(binanceSymbol: string): Promise<number> {
  const data = (await fetchJson(
    `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(binanceSymbol)}`
  )) as { price: string };
  const p = parseFloat(data.price);
  if (!Number.isFinite(p) || p <= 0) throw new Error("binance: bad price");
  return p;
}

async function coinbasePrice(baseAsset: string): Promise<number> {
  const data = (await fetchJson(
    `https://api.coinbase.com/v2/prices/${encodeURIComponent(baseAsset)}-USD/spot`
  )) as { data?: { amount?: string } };
  const p = parseFloat(data.data?.amount ?? "");
  if (!Number.isFinite(p) || p <= 0) throw new Error("coinbase: bad price");
  return p;
}

async function krakenPrice(baseAsset: string): Promise<number> {
  // Kraken uses XBT for BTC.
  const pair = `${baseAsset === "BTC" ? "XBT" : baseAsset}USD`;
  const data = (await fetchJson(
    `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`
  )) as { error?: string[]; result?: Record<string, { c?: [string, string] }> };
  if (data.error?.length) throw new Error(`kraken: ${data.error[0]}`);
  const first = Object.values(data.result ?? {})[0];
  const p = parseFloat(first?.c?.[0] ?? "");
  if (!Number.isFinite(p) || p <= 0) throw new Error("kraken: bad price");
  return p;
}

interface AggregatedPrice {
  price: bigint;
  confidence: bigint;
  publishTime: bigint;
  sources: number;
}

/**
 * Median across the sources that responded. Returns null (skip the tick) when
 * fewer than MIN_SOURCES respond or the responders disagree beyond
 * MAX_SOURCE_DEVIATION_BPS — publishing nothing lets the on-chain staleness
 * guard fail-stop the protocol instead of feeding it a manipulable price.
 */
async function aggregatePrice(
  label: string,
  fetchers: Array<() => Promise<number>>
): Promise<AggregatedPrice | null> {
  const settled = await Promise.allSettled(fetchers.map((f) => f()));
  const prices = settled
    .filter((s): s is PromiseFulfilledResult<number> => s.status === "fulfilled")
    .map((s) => s.value)
    .sort((a, b) => a - b);

  if (prices.length < MIN_SOURCES) {
    const errors = settled
      .filter((s): s is PromiseRejectedResult => s.status === "rejected")
      .map((s) => String(s.reason).slice(0, 60));
    console.error(`\n  ✗ ${label}: only ${prices.length}/${fetchers.length} sources (need ${MIN_SOURCES}): ${errors.join(" | ")}`);
    return null;
  }

  const spreadBps = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 10_000;
  if (spreadBps > MAX_SOURCE_DEVIATION_BPS) {
    console.error(`\n  ✗ ${label}: source deviation ${spreadBps.toFixed(0)}bps > ${MAX_SOURCE_DEVIATION_BPS}bps — skipping publish (fail-safe)`);
    return null;
  }

  const mid = prices.length % 2 === 1
    ? prices[(prices.length - 1) / 2]
    : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
  const price = BigInt(Math.round(mid * Number(PRICE_PRECISION)));
  // Confidence: at least 0.1%, widened to half the observed source spread.
  const spreadConfidence = BigInt(Math.round(((prices[prices.length - 1] - prices[0]) / 2) * Number(PRICE_PRECISION)));
  const confidence = spreadConfidence > price / 1000n ? spreadConfidence : price / 1000n;
  return {
    price,
    confidence,
    publishTime: ledgerSafePublishTime(),
    sources: prices.length,
  };
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  const secret = process.env.ORACLE_PUBLISHER_SECRET;
  if (!secret && !DRY_RUN) {
    console.error("❌  ORACLE_PUBLISHER_SECRET is not set.");
    console.error("    Add ORACLE_PUBLISHER_SECRET=S... to your .env.local");
    process.exit(1);
  }

  // Dry runs never sign, so a throwaway key is enough to build the banner.
  const publisherKp = secret ? Keypair.fromSecret(secret) : Keypair.random();
  const publisherAddress = publisherKp.publicKey();
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const contract = new Contract(CONTRACTS.oracleAdapter);
  const publisherArg = nativeToScVal(publisherAddress, { type: "address" });

  console.log(`✓ Oracle keeper starting`);
  console.log(`  Publisher : ${publisherAddress}`);
  console.log(`  Network   : ${NETWORK.name}`);
  console.log(`  Contract  : ${CONTRACTS.oracleAdapter}`);
  console.log(`  Markets   : ${ORACLE_MARKETS.map((m) => `${m.symbol}:${m.priceSourceSymbol}`).join(", ")}`);
  console.log(`  Fetch     : ${FETCH_INTERVAL_MS / 1000}s; publish on ${PUBLISH_DEVIATION_BPS}bps move or ${PUBLISH_HEARTBEAT_SECS}s heartbeat (USDC: ${USDC_PUBLISH_DEVIATION_BPS}bps/${USDC_PUBLISH_HEARTBEAT_SECS}s)`);
  console.log(`  Stables   : USDC (peg guard ${USDC_DEPEG_HALT_BPS}bps)${PUBLISH_USDT0 ? `, USDT0 via USDT (peg guard ${USDT0_DEPEG_HALT_BPS}bps)` : ", USDT0 off"}`);
  console.log(
    `  Reflector : ${
      REFLECTOR_GUARD_ENABLED
        ? `guard ON @ ${REFLECTOR_DIVERGENCE_HALT_BPS}bps, max age ${REFLECTOR_MAX_AGE_SECS}s — ${reflectorContractId()}`
        : "guard OFF (REFLECTOR_GUARD_ENABLED=false)"
    }`
  );
  const noReflector = ORACLE_MARKETS.filter((m) => !m.reflectorSymbol).map((m) => m.oracleSymbol);
  if (REFLECTOR_GUARD_ENABLED && noReflector.length) {
    console.log(`              no Reflector feed (CEX median only): ${noReflector.join(", ")}`);
  }
  if (DRY_RUN) console.log(`  Mode      : DRY RUN — one pass, nothing is signed or submitted\n`);

  // Last successfully published price/time per asset, for deviation+heartbeat
  // gating. Only updated on confirmed success so failures retry next fetch.
  const lastPublished = new Map<string, { price: bigint; ts: number }>();

  function shouldPublish(asset: string, price: bigint, deviationBps: number, heartbeatSecs: number): boolean {
    const last = lastPublished.get(asset);
    if (!last) return true;
    if (Date.now() - last.ts >= heartbeatSecs * 1000) return true;
    const diff = price > last.price ? price - last.price : last.price - price;
    return Number((diff * 10_000n) / last.price) >= deviationBps;
  }

  async function writePrice(oracleSymbol: string, price: bigint, confidence: bigint, publishTime: bigint): Promise<boolean> {
    // Fetch real sequence for submission
    const onChainAccount = await server.getAccount(publisherAddress);
    const assetArg = nativeToScVal(oracleSymbol, { type: "symbol" });

    const tx = new TransactionBuilder(onChainAccount, { fee: "500000", networkPassphrase: NETWORK.passphrase })
      .addOperation(
        contract.call(
          "write_price",
          assetArg,
          publisherArg,
          toI128ScVal(price),
          toI128ScVal(confidence),
          toU64ScVal(publishTime)
        )
      )
      .setTimeout(30)
      .build();

    // Simulate to get footprint + auth
    const simResult = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(simResult)) {
      process.stdout.write(` ✗ sim: ${simResult.error?.slice(0, 80)}\n`);
      return false;
    }

    const prepared = sorobanRpc.assembleTransaction(tx, simResult).build();
    prepared.sign(publisherKp);

    const send = await server.sendTransaction(prepared);
    if (send.status === "ERROR") {
      process.stdout.write(` ✗ submit: ${send.errorResult?.toXDR("base64")?.slice(0, 60)}\n`);
      return false;
    }

    // Poll for confirmation
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const poll = await server.getTransaction(send.hash);
      if (poll.status === "SUCCESS") {
        process.stdout.write(` ✓ ${send.hash.slice(0, 12)}\n`);
        return true;
      }
      if (poll.status === "FAILED") {
        process.stdout.write(` ✗ tx failed\n`);
        return false;
      }
    }
    process.stdout.write(` ? timeout\n`);
    return false; // ambiguous — retry next fetch; a duplicate publish is harmless
  }

  /**
   * Independent Reflector cross-check on the CEX median.
   *
   * Returns true when it is safe to publish. The guard only ever BLOCKS on a
   * live Reflector price that genuinely disagrees; every "cannot tell" case
   * (no feed, RPC failure, stale round) passes through, because halting the
   * venue on our own inability to read a third party is a self-inflicted
   * outage, not a safety measure.
   */
  async function reflectorAllowsPublish(
    market: (typeof ORACLE_MARKETS)[number],
    median: bigint
  ): Promise<boolean> {
    if (!REFLECTOR_GUARD_ENABLED) return true;
    if (!market.reflectorSymbol) return true; // BNB, TRX — no Reflector feed

    const ref = await reflectorLastPrice(market.reflectorSymbol);
    if (!ref) {
      console.warn(`\n  ⚠ ${market.oracleSymbol}: Reflector unreadable — cross-check skipped this tick`);
      return true;
    }

    const refAge = Math.floor(Date.now() / 1000) - ref.timestamp;
    if (refAge > REFLECTOR_MAX_AGE_SECS) {
      console.warn(`\n  ⚠ ${market.oracleSymbol}: Reflector round is ${refAge}s old (> ${REFLECTOR_MAX_AGE_SECS}s) — cross-check skipped`);
      return true;
    }

    const bps = divergenceBps(median, ref.price);
    if (bps > REFLECTOR_DIVERGENCE_HALT_BPS) {
      const fmt = (v: bigint) => (Number(v) / Number(PRICE_PRECISION)).toFixed(market.priceDecimals);
      console.error(
        `\n  ✗✗ ${market.oracleSymbol} ORACLE DIVERGENCE: CEX median $${fmt(median)} vs Reflector $${fmt(ref.price)} ` +
        `= ${bps}bps > ${REFLECTOR_DIVERGENCE_HALT_BPS}bps — HALTING publication ` +
        `(settlement will fail-stop on staleness)`
      );
      return false;
    }
    return true;
  }

  async function publishMarket(market: (typeof ORACLE_MARKETS)[number]) {
    try {
      const agg = await aggregatePrice(market.oracleSymbol, [
        () => binancePrice(market.priceSourceSymbol),
        () => coinbasePrice(market.baseAsset),
        () => krakenPrice(market.baseAsset),
      ]);
      if (!agg) return; // fail-safe: skip tick, on-chain staleness guard takes over

      // Cross-check BEFORE the deviation/heartbeat gate: a divergence must be
      // reported every tick it persists, not only on the ticks we would have
      // published anyway.
      const allowed = await reflectorAllowsPublish(market, agg.price);

      if (DRY_RUN) {
        const ref = market.reflectorSymbol ? await reflectorLastPrice(market.reflectorSymbol) : null;
        const fmt = (v: bigint) => (Number(v) / Number(PRICE_PRECISION)).toFixed(market.priceDecimals);
        const refCol = !market.reflectorSymbol
          ? "no Reflector feed — guard skipped"
          : ref
          ? `reflector $${fmt(ref.price)} div ${divergenceBps(agg.price, ref.price)}bps`
          : "reflector unreadable — guard skipped";
        console.log(
          `  ${market.symbol.padEnd(9)} median $${fmt(agg.price).padStart(12)} (${agg.sources} src)  ` +
          `${refCol.padEnd(42)} → ${allowed ? "PUBLISH" : "SKIP (halt)"}`
        );
        return;
      }

      if (!allowed) return;
      if (!shouldPublish(market.oracleSymbol, agg.price, PUBLISH_DEVIATION_BPS, PUBLISH_HEARTBEAT_SECS)) return;
      const priceHuman = Number(agg.price) / Number(PRICE_PRECISION);
      process.stdout.write(`\r  Publishing ${market.oracleSymbol} $${priceHuman.toFixed(market.priceDecimals)} (${agg.sources} sources) at ${new Date().toISOString().slice(11, 19)}...`);
      if (await writePrice(market.oracleSymbol, agg.price, agg.confidence, agg.publishTime)) {
        lastPublished.set(market.oracleSymbol, { price: agg.price, ts: Date.now() });
      }
    } catch (e) {
      process.stdout.write(` ✗ ${(e as Error).message?.slice(0, 100)}\n`);
    }
  }

  // Every collateral asset needs a fresh on-chain price so the vault can value
  // it during account_health. Prices are SOURCED, never assumed at par — on a
  // depeg beyond the halt threshold we stop publishing, so collateral valuation
  // goes stale and the protocol fail-stops instead of valuing a depegged
  // stablecoin at $1 (the deposit-and-drain vector).
  //
  // This matters more for USDT0 than USDC: it is a LayerZero OFT, so it can
  // depeg from bridge failure as well as from issuer trouble.
  async function publishStable(
    oracleSymbol: string,
    sourceAsset: string,
    depegHaltBps: number
  ) {
    try {
      const agg = await aggregatePrice(sourceAsset, [
        () => coinbasePrice(sourceAsset),
        () => krakenPrice(sourceAsset),
      ]);

      let price: bigint;
      let confidence: bigint;
      if (agg) {
        const deviationBps = Number(
          ((agg.price > PRICE_PRECISION ? agg.price - PRICE_PRECISION : PRICE_PRECISION - agg.price) * 10_000n) /
            PRICE_PRECISION
        );
        if (deviationBps > depegHaltBps) {
          console.error(`\n  ✗✗ ${oracleSymbol} DEPEG: sourced $${(Number(agg.price) / 1e18).toFixed(4)} is ${deviationBps}bps off peg — HALTING ${oracleSymbol} publication (collateral valuation will fail-stop on staleness)`);
          return;
        }
        price = agg.price;
        confidence = agg.confidence;
      } else if (NETWORK.name !== "mainnet") {
        // Testnet-only convenience: stablecoin sources unreachable — publish
        // the peg so local development is not blocked. NEVER on mainnet.
        price = PRICE_PRECISION;
        confidence = PRICE_PRECISION / 1000n;
      } else {
        console.error(`\n  ✗ ${oracleSymbol}: sources unavailable on mainnet — skipping publish (fail-safe)`);
        return;
      }

      if (DRY_RUN) {
        console.log(`  ${oracleSymbol.padEnd(9)} sourced $${(Number(price) / Number(PRICE_PRECISION)).toFixed(4)} (peg guard ${depegHaltBps}bps) → PUBLISH`);
        return;
      }
      if (!shouldPublish(oracleSymbol, price, USDC_PUBLISH_DEVIATION_BPS, USDC_PUBLISH_HEARTBEAT_SECS)) return;
      const priceHuman = Number(price) / Number(PRICE_PRECISION);
      process.stdout.write(`\r  Publishing ${oracleSymbol} $${priceHuman.toFixed(4)} at ${new Date().toISOString().slice(11, 19)}...`);
      if (await writePrice(oracleSymbol, price, confidence, ledgerSafePublishTime())) {
        lastPublished.set(oracleSymbol, { price, ts: Date.now() });
      }
    } catch (e) {
      process.stdout.write(` ✗ ${(e as Error).message?.slice(0, 100)}\n`);
    }
  }

  if (DRY_RUN) {
    await tickInner();
    console.log(`\n  (dry run complete — no transactions were built or submitted)`);
    return;
  }

  // ── Activity-aware idling ──────────────────────────────────────────────────
  const sql = neon(process.env.DATABASE_URL!);
  let lastActivityCheck = 0;
  let lastActiveAt = Date.now(); // assume active on boot until proven idle
  let cachedReasons: string[] = [];
  let idleLogged = false;

  async function isPublishingNeeded(): Promise<boolean> {
    const now = Date.now();
    if (now - lastActivityCheck >= ACTIVITY_CHECK_INTERVAL_MS) {
      lastActivityCheck = now;
      const status = await checkProtocolActivity(sql as never, server);
      cachedReasons = status.reasons;
      if (status.active) lastActiveAt = now;
    }
    const withinGrace = now - lastActiveAt < IDLE_GRACE_SECS * 1000;
    if (withinGrace) {
      if (idleLogged) {
        console.log(`  ▶ resuming publishing (${cachedReasons.join(", ") || "grace"})`);
        idleLogged = false;
      }
      return true;
    }
    if (!idleLogged) {
      console.log(`  ⏸ idle — no orders, settlements, positions, or vault deposits; publishing suspended (checks every ${ACTIVITY_CHECK_INTERVAL_MS / 1000}s)`);
      idleLogged = true;
    }
    return false;
  }

  // Confirmation polling can outlast the fetch interval; overlapping ticks
  // race the publisher's sequence number and double-publish at heartbeats.
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (await isPublishingNeeded()) await tickInner();
    } finally {
      ticking = false;
    }
  }

  async function tickInner() {
    for (const market of ORACLE_MARKETS) {
      await publishMarket(market);
      // One account submits every market's write_price, and Soroban allows
      // only one host-function invocation per transaction — these cannot be
      // batched. Space them so consecutive submissions don't race the
      // publisher's sequence number.
      if (PUBLISH_STAGGER_MS > 0) await sleep(PUBLISH_STAGGER_MS);
    }
    await publishStable("USDC", "USDC", USDC_DEPEG_HALT_BPS);
    if (PUBLISH_USDT0) {
      await publishStable("USDT0", "USDT", USDT0_DEPEG_HALT_BPS);
    }
  }

  // Run immediately then on interval
  await tick();
  setInterval(tick, FETCH_INTERVAL_MS);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

run().catch(console.error);
