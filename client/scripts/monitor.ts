#!/usr/bin/env tsx
/**
 * Monitor — checks liveness of all Kryon testnet services every 30s.
 *
 * Checks:
 *   - Oracle freshness (last on-chain price age)
 *   - Matcher lag (oldest pending order age)
 *   - Indexer lag (last Market row update)
 *   - DB latency (round-trip time)
 *   - App /api/health endpoint
 *   - WebSocket connectivity
 *   - Operator wallet XLM balances (oracle, matcher, liquidator, TTL keeper)
 *
 * Alerting (optional): set ALERT_WEBHOOK_URL to receive alerts on failures.
 * The monitor POSTs JSON {"content": "..."} — works out of the box with a
 * Discord webhook URL. For Telegram, point it at your bot's sendMessage URL
 * via a tiny relay, or use https://api.telegram.org/bot<TOKEN>/sendMessage
 * with a proxy that maps {"content"} -> {"chat_id","text"} (Telegram's API
 * expects different field names, so a direct URL will not work).
 *
 * Alerts are de-duplicated: one alert when a check starts failing, an hourly
 * reminder while it stays broken, and a recovery notice when it heals.
 *
 * Usage:
 *   npm run dev:monitor
 */

import { neon } from "../lib/sql";
import { checkProtocolActivity } from "../lib/oracle-activity";
import { WebSocket } from "ws";
import { Contract, TransactionBuilder, Keypair, Account, rpc as sorobanRpc, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK, ACTIVE_MARKETS } from "../config";

const CHECK_INTERVAL_MS = 30_000;
const APP_URL = process.env.MONITOR_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
// MONITOR_WS_URL overrides for deployments where the browser-facing WS URL
// (NEXT_PUBLIC_WS_URL) differs from what the monitor host can reach.
const WS_URL = process.env.MONITOR_WS_URL ?? process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

// Alert margin under the on-chain OracleGuard max_age (120s): the keeper
// heartbeats at 60s (XLM) / 90s (USDC) + ~10s confirm latency, so a healthy
// feed peaks ~100s; alerting at 110s fires before settlement actually halts.
const ORACLE_MAX_AGE_SECS = Number(process.env.ORACLE_FRESHNESS_ALERT_SECS ?? "110");
const MATCHER_LAG_WARN_SECS = 60;
const INDEXER_LAG_WARN_SECS = 60;
const DB_LATENCY_WARN_MS = 2_000;

const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;
const ALERT_REMINDER_MS = 60 * 60 * 1000; // hourly reminder while a check stays broken

// Keepers pay their own transaction fees. A wallet that quietly drains halts the
// service it funds — the oracle stops publishing, TTL bumps stop, liquidations
// stop — and the only symptom is silence, which is indistinguishable from an
// idle protocol. Alert on the balance, not on the outage it eventually causes.
const OPERATOR_XLM_WARN = Number(process.env.OPERATOR_XLM_WARN ?? "25");

// Funding accrues only when someone calls update_funding, and the contract
// charges at most one hour per call. A gap longer than that is silently
// under-charged funding — the market drifts from its index and nothing says so.
//
// This check exists because nothing was watching: funding sat at zero for the
// entire life of the protocol (audit KRY-Q1/Q2) and no alert could have fired,
// because no alert looked. Silence from a funding keeper is indistinguishable
// from a market with no premium unless you read last_update.
const FUNDING_STALE_ALERT_SECS = Number(process.env.FUNDING_STALE_ALERT_SECS ?? "3600");

// Liquidation closes a distressed position with no counterparty, so the
// insurance fund is the protocol's implicit other side (audit KRY-Q4). The
// on-chain OI cap bounds that exposure; this alerts while it is merely thinning,
// rather than when an open is first refused.
const INSURANCE_COVERAGE_WARN_BPS = Number(process.env.INSURANCE_COVERAGE_WARN_BPS ?? "2000");

const PRICE_PRECISION = 1e18;

// Synthetic sim account for read-only oracle queries
const _simKp = Keypair.random();
let _simSeq = 0;
function getSimAccount() {
  return new Account(_simKp.publicKey(), (_simSeq++).toString());
}

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

type CheckResult = { name: string; ok: boolean; detail: string; ms: number };

async function timed(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, detail, ms: Date.now() - start };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : String(e), ms: Date.now() - start };
  }
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkDbLatency(): Promise<string> {
  const sql = db();
  const t0 = Date.now();
  await sql`SELECT 1`;
  const ms = Date.now() - t0;
  if (ms > DB_LATENCY_WARN_MS) throw new Error(`DB latency ${ms}ms exceeds ${DB_LATENCY_WARN_MS}ms`);
  return `${ms}ms`;
}

async function checkOracleFreshness(): Promise<string> {
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const markets = Object.values(ACTIVE_MARKETS);
  const results: string[] = [];
  const problems: string[] = [];

  for (const market of markets) {
    const contract = new Contract(CONTRACTS.oracleAdapter);
    const account = getSimAccount();
    // override_guard = Some({max_age_secs: huge, max_confidence_bps: 10000}),
    // NOT None. With None the contract enforces the feed's OWN stored guard
    // (120s) and REJECTS a stale price inside the simulation (StaleOracle,
    // CoreError #6) before this code ever sees the snapshot — indistinguishable
    // from a genuinely broken oracle. Passing a permissive override makes
    // get_price always return the raw snapshot; the age check below (which
    // already knows how to tell "safely idle" from "actually stale") is the
    // sole arbiter of whether this is a problem.
    // max_confidence_bps is capped at 10000 by the contract's validate_guard
    // (rejects >10_000 as InvalidConfig) — confirmed empirically via CLI
    // against mainnet. Option::Some(guard) encodes as the map DIRECTLY, not
    // wrapped in a vec (also confirmed via `stellar contract invoke
    // --build-only` + xdr decode against the actual deployed contract).
    const permissiveGuard = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_age_secs"), val: nativeToScVal(BigInt("18446744073709551615"), { type: "u64" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_confidence_bps"), val: nativeToScVal(10000, { type: "u32" }) }),
    ]);
    const tx = new TransactionBuilder(account, { fee: "500000", networkPassphrase: NETWORK.passphrase })
      .addOperation(contract.call(
        "get_price",
        nativeToScVal(market.oracleSymbol, { type: "symbol" }),
        permissiveGuard // Option<OracleGuard>::Some(...) — bare map, no vec wrapper
      ))
      .setTimeout(10)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(sim)) {
      // A missing feed reads as a sim error; name the market so the alert is
      // actionable, and keep checking the rest.
      problems.push(`${market.oracleSymbol} sim failed: ${sim.error?.slice(0, 60)}`);
      continue;
    }

    const result = sim.result?.retval;
    if (!result) { problems.push(`${market.oracleSymbol} returned no value`); continue; }

    const snap = scValToNative(result) as Record<string, unknown>;
    const publishTime = Number(snap["publish_time"] ?? 0);
    if (!publishTime) { problems.push(`${market.oracleSymbol} snapshot has no publish_time`); continue; }

    const ageS = Math.round((Date.now() / 1000) - publishTime);
    if (ageS > ORACLE_MAX_AGE_SECS) {
      // The keeper suspends publishing when nothing on-chain needs a price
      // (no orders/settlements/positions/deposits). Staleness while idle is
      // deliberate, not an incident — alert only if the protocol is active.
      const activity = await checkProtocolActivity(db() as never, server);
      if (!activity.active) {
        results.push(`${market.oracleSymbol}=idle (${ageS}s old, publishing suspended)`);
        continue;
      }
      // Collect rather than throw: with eight feeds, throwing on the first
      // stale market hides the other seven, and "4 check(s) failed" tells an
      // on-call engineer nothing about WHICH market is down.
      problems.push(`${market.oracleSymbol} ${ageS}s stale (max ${ORACLE_MAX_AGE_SECS}s, active: ${activity.reasons.join(",")})`);
      continue;
    }
    results.push(`${market.oracleSymbol}=${ageS}s old`);
  }

  if (problems.length) {
    throw new Error(
      `${problems.length}/${markets.length} feed(s) stale — ${problems.join("; ")}` +
      (results.length ? ` | healthy: ${results.join(", ")}` : "")
    );
  }
  return results.join(", ");
}

async function checkMatcherLag(): Promise<string> {
  const sql = db();
  // Expired orders can never match — only live resting orders indicate lag.
  // Age is computed server-side: the Neon HTTP driver misreads TIMESTAMP(3).
  const rows = await sql`
    SELECT EXTRACT(EPOCH FROM (NOW() - "createdAt"))::int AS age_s FROM "Order"
    WHERE cancelled = false AND "filledSize"::numeric < "size"::numeric
      AND "limitPrice" <> '0'
      AND "expiryTs" > EXTRACT(EPOCH FROM NOW())::bigint
    ORDER BY "createdAt" ASC LIMIT 1
  `;
  if (!rows.length) return "no resting orders";
  const ageS = Number(rows[0].age_s);
  if (ageS > MATCHER_LAG_WARN_SECS) throw new Error(`oldest pending order is ${ageS}s old`);
  return `oldest order ${ageS}s`;
}

async function checkIndexerLag(): Promise<string> {
  const sql = db();
  // Only markets the indexer actually syncs; server-side age (Neon TIMESTAMP(3) quirk).
  const activeIds = Object.values(ACTIVE_MARKETS).map((m) => m.marketId);
  const rows = await sql`
    SELECT EXTRACT(EPOCH FROM (NOW() - "updatedAt"))::int AS age_s FROM "Market"
    WHERE id = ANY(${activeIds})
    ORDER BY "updatedAt" ASC LIMIT 1
  `;
  if (!rows.length) return "no active markets in DB";
  const ageS = Number(rows[0].age_s);
  if (ageS > INDEXER_LAG_WARN_SECS) throw new Error(`indexer last synced ${ageS}s ago`);
  return `last sync ${ageS}s ago`;
}

async function checkAppHealth(): Promise<string> {
  const res = await fetch(`${APP_URL}/api/health`, { cache: "no-store" } as RequestInit);
  if (!res.ok) throw new Error(`/api/health returned ${res.status}`);
  return `HTTP ${res.status}`;
}

async function checkWebSocket(): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => { ws.close(); reject(new Error("WS open timeout")); }, 5_000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "ping" }));
    });
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === "pong") {
        clearTimeout(timer);
        ws.close();
        resolve("connected + pong");
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

type Operator = { name: string; address: string };

// Prefer an explicit pubkey when one is configured; otherwise derive it from the
// secret the service already holds, so this check needs no new configuration.
function operatorAddress(secretEnv: string, pubkeyEnv?: string): string | null {
  const pub = pubkeyEnv ? process.env[pubkeyEnv] : undefined;
  if (pub) return pub;
  const secret = process.env[secretEnv];
  if (!secret) return null;
  try {
    return Keypair.fromSecret(secret).publicKey();
  } catch {
    return null;
  }
}

function operators(): Operator[] {
  const candidates = [
    { name: "oracle", address: operatorAddress("ORACLE_PUBLISHER_SECRET") },
    { name: "matcher", address: operatorAddress("MATCHER_OPERATOR_SECRET", "MATCHER_OPERATOR_PUBKEY") },
    { name: "liquidator", address: operatorAddress("LIQUIDATOR_SECRET") },
    { name: "ttl-keeper", address: operatorAddress("TTL_KEEPER_SECRET") },
    { name: "funding-keeper", address: operatorAddress("FUNDING_KEEPER_SECRET") },
  ];
  return candidates.filter((o): o is Operator => o.address !== null);
}

async function checkOperatorBalances(): Promise<string> {
  const ops = operators();
  if (!ops.length) return "no operator keys configured";

  const healthy: string[] = [];
  const problems: string[] = [];

  await Promise.all(
    ops.map(async (op) => {
      const res = await fetch(`${NETWORK.horizonUrl}/accounts/${op.address}`, { cache: "no-store" } as RequestInit);
      // A merged or never-funded operator is a harder failure than a low one:
      // the service will never recover on its own.
      if (res.status === 404) {
        problems.push(`${op.name} account does not exist (merged or unfunded)`);
        return;
      }
      if (!res.ok) {
        problems.push(`${op.name} horizon HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { balances: { asset_type: string; balance: string }[] };
      const xlm = Number(body.balances.find((b) => b.asset_type === "native")?.balance ?? "0");
      if (xlm < OPERATOR_XLM_WARN) problems.push(`${op.name} has ${xlm.toFixed(2)} XLM (< ${OPERATOR_XLM_WARN})`);
      else healthy.push(`${op.name}=${xlm.toFixed(1)}`);
    })
  );

  if (problems.length) throw new Error(problems.join("; "));
  return `${healthy.sort().join(", ")} XLM`;
}

/** Read one value from a contract via simulation, or null if the call fails. */
async function simRead(
  server: sorobanRpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<unknown | null> {
  const tx = new TransactionBuilder(getSimAccount(), {
    fee: "500000",
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) return null;
  const retval = (sim as sorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) return null;
  try {
    return scValToNative(retval);
  } catch {
    return null;
  }
}

/**
 * Funding must actually be accruing on every market.
 *
 * Reads `funding_state(market_id).last_update` and alerts when it falls further
 * behind than the contract's own one-hour accrual cap. A market that has never
 * had funding configured reports `last_update = 0`, which is called out
 * separately: that is a deployment gap, not a keeper outage.
 */
async function checkFundingFreshness(): Promise<string> {
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const now = Math.floor(Date.now() / 1000);
  const results: string[] = [];
  const problems: string[] = [];

  for (const market of Object.values(ACTIVE_MARKETS)) {
    const state = (await simRead(server, CONTRACTS.engine, "funding_state", [
      nativeToScVal(market.marketId, { type: "u32" }),
    ])) as Record<string, unknown> | null;

    if (!state) {
      problems.push(`${market.symbol} funding_state unreadable`);
      continue;
    }
    const lastUpdate = Number(state["last_update"] ?? 0);
    if (lastUpdate === 0) {
      problems.push(`${market.symbol} funding never initialised`);
      continue;
    }
    const age = now - lastUpdate;
    if (age > FUNDING_STALE_ALERT_SECS) {
      problems.push(`${market.symbol} funding ${age}s stale (max ${FUNDING_STALE_ALERT_SECS}s)`);
      continue;
    }
    results.push(`${market.symbol}=${age}s`);
  }

  if (problems.length) throw new Error(problems.join("; "));
  return results.sort().join(", ");
}

/**
 * How well the insurance fund covers each market's open interest.
 *
 * `insurance_coverage_bps` returns i128::MAX for a market with no open
 * interest — infinitely covered rather than a divide-by-zero — so that case is
 * reported as idle rather than as perfect health.
 */
async function checkInsuranceCoverage(): Promise<string> {
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const results: string[] = [];
  const problems: string[] = [];
  const UNBOUNDED = (1n << 127n) - 1n;

  for (const market of Object.values(ACTIVE_MARKETS)) {
    const raw = await simRead(server, CONTRACTS.engine, "insurance_coverage_bps", [
      nativeToScVal(market.marketId, { type: "u32" }),
    ]);
    if (raw === null || raw === undefined) {
      // Pre-upgrade engines have no such entrypoint. Not a protocol fault.
      results.push(`${market.symbol}=n/a`);
      continue;
    }
    const bps = BigInt(raw as string | number | bigint);
    if (bps >= UNBOUNDED) {
      results.push(`${market.symbol}=idle`);
      continue;
    }
    if (bps < BigInt(INSURANCE_COVERAGE_WARN_BPS)) {
      problems.push(
        `${market.symbol} insurance covers ${Number(bps) / 100}% of open interest ` +
          `(< ${INSURANCE_COVERAGE_WARN_BPS / 100}%)`
      );
      continue;
    }
    results.push(`${market.symbol}=${Number(bps) / 100}%`);
  }

  if (problems.length) throw new Error(problems.join("; "));
  return results.sort().join(", ");
}

// ── Alerting ──────────────────────────────────────────────────────────────────

type AlertState = { failing: boolean; since: number; lastAlertAt: number; lastDetail: string };
const alertStates = new Map<string, AlertState>();

async function postAlert(content: string): Promise<void> {
  if (!ALERT_WEBHOOK_URL) return;
  try {
    const res = await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) console.error(`  ⚠ alert webhook returned HTTP ${res.status}`);
  } catch (e) {
    console.error(`  ⚠ alert webhook unreachable: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
  }
}

function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`;
}

// One alert on ok→fail, hourly reminders while broken, one notice on fail→ok.
async function processAlerts(results: CheckResult[]): Promise<void> {
  const now = Date.now();
  for (const r of results) {
    const prev = alertStates.get(r.name);
    if (!r.ok) {
      if (!prev?.failing) {
        alertStates.set(r.name, { failing: true, since: now, lastAlertAt: now, lastDetail: r.detail });
        await postAlert(`🔴 **Kryon ${r.name}** failing: ${r.detail}`);
      } else if (now - prev.lastAlertAt >= ALERT_REMINDER_MS) {
        prev.lastAlertAt = now;
        prev.lastDetail = r.detail;
        await postAlert(`🔁 **Kryon ${r.name}** still failing after ${fmtDuration(now - prev.since)}: ${r.detail}`);
      } else {
        prev.lastDetail = r.detail;
      }
    } else if (prev?.failing) {
      alertStates.delete(r.name);
      await postAlert(`🟢 **Kryon ${r.name}** recovered after ${fmtDuration(now - prev.since)} (${r.detail})`);
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

function color(ok: boolean) { return ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"; }

async function runChecks() {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`\n[${ts}] Running checks...`);

  const results = await Promise.all([
    timed("db-latency",       checkDbLatency),
    timed("oracle-freshness", checkOracleFreshness),
    timed("matcher-lag",      checkMatcherLag),
    timed("indexer-lag",      checkIndexerLag),
    timed("app-health",       checkAppHealth),
    timed("websocket",        checkWebSocket),
    timed("operator-funds",   checkOperatorBalances),
    timed("funding-accrual",  checkFundingFreshness),
    timed("insurance-cover",  checkInsuranceCoverage),
  ]);

  let allOk = true;
  for (const r of results) {
    const icon = color(r.ok);
    console.log(`  ${icon} ${r.name.padEnd(20)} ${r.ok ? r.detail : "FAIL: " + r.detail} (${r.ms}ms)`);
    if (!r.ok) allOk = false;
  }

  if (!allOk) {
    const failed = results.filter((r) => !r.ok);
    console.error(`\x1b[31m  ⚠ ${failed.length} check(s) failed: ${failed.map((r) => `${r.name} (${r.detail})`).join(" | ")}\x1b[0m`);
  } else {
    console.log(`\x1b[32m  All checks passed\x1b[0m`);
  }

  await processAlerts(results);
}

console.log(`✓ Kryon monitor starting`);
console.log(`  App : ${APP_URL}`);
console.log(`  WS  : ${WS_URL}`);
console.log(`  Interval: ${CHECK_INTERVAL_MS / 1000}s`);
if (ALERT_WEBHOOK_URL) {
  console.log(`  Alerts: webhook configured`);
} else {
  // The 2026-07 outage ran 21 days undetected because this was unset and the
  // monitor logged every failure to nowhere. Eight markets multiply the
  // failure surface, so this warns loudly rather than mentioning it in passing.
  console.error("\x1b[33m  ⚠  ALERT_WEBHOOK_URL is NOT SET — checks will run but NOBODY WILL BE NOTIFIED.\x1b[0m");
  console.error("\x1b[33m     This is exactly how the 2026-07 outage went 21 days undetected.\x1b[0m");
  console.error("\x1b[33m     Set ALERT_WEBHOOK_URL (Slack/Discord incoming webhook) before relying on this.\x1b[0m");
}

runChecks();
setInterval(runChecks, CHECK_INTERVAL_MS);
