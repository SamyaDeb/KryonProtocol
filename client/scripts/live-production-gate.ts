#!/usr/bin/env tsx

type CheckResult = {
  name: string;
  ms: number;
};

// On testnet the WS server runs locally — allow ws: as well as wss:
const IS_TESTNET = process.env.NEXT_PUBLIC_STELLAR_NETWORK === "testnet";

import { ACTIVE_MARKETS } from "../config";

const APP_URL = requiredUrl("NEXT_PUBLIC_APP_URL", process.env.NEXT_PUBLIC_APP_URL);
const WS_URL = requiredWsUrl("NEXT_PUBLIC_WS_URL", process.env.NEXT_PUBLIC_WS_URL);

const MARKET_ID = Number(process.env.LIVE_GATE_MARKET_ID ?? "1");
const WS_CONNECTIONS = Number(process.env.LIVE_GATE_WS_CONNECTIONS ?? "25");
const SOAK_SECONDS = Number(process.env.LIVE_GATE_SOAK_SECONDS ?? "30");
const RATE_LIMIT_PROBE = process.env.LIVE_GATE_RATE_LIMIT_PROBE === "true";

function fail(message: string): never {
  throw new Error(`live production gate failed: ${message}`);
}

function requiredUrl(key: string, value: string | undefined, protocol = "https:"): URL {
  if (!value) fail(`${key} is required`);
  const url = new URL(value);
  if (url.protocol !== protocol) fail(`${key} must use ${protocol}`);
  return url;
}

function requiredWsUrl(key: string, value: string | undefined): URL {
  if (!value) fail(`${key} is required`);
  const url = new URL(value);
  const allowed = IS_TESTNET ? ["wss:", "ws:"] : ["wss:"];
  if (!allowed.includes(url.protocol)) fail(`${key} must use wss: (or ws: on testnet)`);
  return url;
}

function optionalEvidenceUrl(key: string) {
  const value = process.env[key];
  if (!value) fail(`${key} is required`);
  const url = new URL(value);
  if (url.protocol !== "https:") fail(`${key} must be an HTTPS URL`);
}

function endpoint(path: string): string {
  return new URL(path, APP_URL).toString();
}

async function timed(name: string, fn: () => Promise<unknown>): Promise<CheckResult> {
  const started = performance.now();
  await fn();
  const ms = Math.round(performance.now() - started);
  console.log(`✓ ${name} (${ms}ms)`);
  return { name, ms };
}

async function expectStatus(path: string, expected: number | number[], init?: RequestInit) {
  const res = await fetch(endpoint(path), { ...init, cache: "no-store" });
  const statuses = Array.isArray(expected) ? expected : [expected];
  if (!statuses.includes(res.status)) {
    const body = await res.text().catch(() => "");
    fail(`${path} returned ${res.status}, expected ${statuses.join("/")} ${body.slice(0, 160)}`);
  }
  return res;
}

/**
 * Every active market's trade route must render. A single hardcoded
 * /trade/XLM-PERP passed happily while seven other markets 404'd or redirected
 * — the gate has to cover what the switcher actually offers.
 */
async function checkAllMarketRoutes() {
  const markets = Object.values(ACTIVE_MARKETS);
  for (const m of markets) {
    await expectStatus(`/trade/${m.symbol}`, 200);
    await expectStatus(`/api/markets/${m.marketId}`, 200);
    await expectStatus(`/api/markets/${m.marketId}/orderbook`, 200);
    await expectStatus(`/api/markets/${m.marketId}/trades`, 200);
    await expectStatus(`/api/markets/${m.marketId}/candles`, 200);
  }
  return `${markets.length} market route(s) + APIs OK`;
}

async function checkSecurityHeaders() {
  // Headers are route-independent; check them on the default market.
  const res = await expectStatus(`/trade/${Object.values(ACTIVE_MARKETS)[0].symbol}`, 200);
  const csp = res.headers.get("content-security-policy") ?? "";
  if (!csp.includes("frame-ancestors 'none'")) fail("CSP missing frame-ancestors lock");
  if (csp.includes("'unsafe-eval'")) fail("CSP still allows unsafe-eval");
  if ((res.headers.get("x-frame-options") ?? "").toUpperCase() !== "DENY") fail("X-Frame-Options must be DENY");
  if (res.headers.has("x-powered-by")) fail("X-Powered-By must not be exposed");
}

async function checkCoreApis() {
  await expectStatus("/api/health", 200);
  await expectStatus("/api/ready", 200);
  await expectStatus(`/api/markets/${MARKET_ID}`, 200);
  await expectStatus(`/api/markets/${MARKET_ID}/orderbook`, 200);
  await expectStatus(`/api/markets/${MARKET_ID}/trades`, 200);
  await expectStatus(`/api/markets/${MARKET_ID}/candles`, 200);
  await expectStatus("/api/portfolio/not-a-stellar-address", 400);
  await expectStatus("/api/orders", 400, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

async function checkRateLimit() {
  if (!RATE_LIMIT_PROBE) {
    console.log("• rate limit abuse probe skipped; set LIVE_GATE_RATE_LIMIT_PROBE=true to enable");
    return;
  }

  const requests = Array.from({ length: 150 }, () => expectStatus("/api/portfolio/not-a-stellar-address", [400, 429]));
  const responses = await Promise.all(requests);
  if (!responses.some((res) => res.status === 429)) fail("rate limit probe did not observe a 429");
}

function openSocket(index: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`websocket ${index} open timeout`));
    }, 10_000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", channels: [`orderbook:${MARKET_ID}`, `trades:${MARKET_ID}`] }));
      clearTimeout(timer);
      ws.close();
      resolve();
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`websocket ${index} failed`));
    });
  });
}

async function checkWebSocketStorm() {
  const started = performance.now();
  await Promise.all(Array.from({ length: WS_CONNECTIONS }, (_, i) => openSocket(i)));
  const totalMs = performance.now() - started;
  const avgMs = totalMs / WS_CONNECTIONS;
  if (avgMs > 750) fail(`websocket reconnect storm too slow: avg ${Math.round(avgMs)}ms`);
}

async function checkSoak() {
  const deadline = Date.now() + SOAK_SECONDS * 1000;
  let cycles = 0;
  while (Date.now() < deadline) {
    await Promise.all([
      expectStatus(`/api/markets/${MARKET_ID}`, 200),
      expectStatus(`/api/markets/${MARKET_ID}/orderbook`, 200),
      expectStatus(`/api/markets/${MARKET_ID}/trades`, 200),
    ]);
    cycles += 1;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  // Each cycle = parallel API calls + 1s sleep. On Neon serverless the DB round-trip
  // adds ~500ms, so real cycle time is ~1.5-2s. Require at least half the ideal cycles.
  const minCycles = Math.max(1, Math.floor(SOAK_SECONDS / 2));
  if (cycles < minCycles) fail(`soak loop completed only ${cycles}/${minCycles} required cycles`);
}

async function main() {
  optionalEvidenceUrl("WALLET_E2E_EVIDENCE_URL");
  optionalEvidenceUrl("TRADING_E2E_EVIDENCE_URL");
  optionalEvidenceUrl("OBSERVABILITY_DASHBOARD_URL");
  optionalEvidenceUrl("INCIDENT_RUNBOOK_URL");
  optionalEvidenceUrl("ROLLBACK_RUNBOOK_URL");

  const results = await Promise.all([
    timed("security headers", checkSecurityHeaders),
    timed("all market routes", checkAllMarketRoutes),
    timed("core api readiness", checkCoreApis),
    timed("distributed rate limit", checkRateLimit),
  ]);

  results.push(await timed("websocket reconnect storm", checkWebSocketStorm));
  results.push(await timed("market data soak", checkSoak));

  // 6s threshold: serverless cold starts (Neon + Vercel) can add up to ~4s
  const slow = results.filter((r) => r.ms > 6_000 && !r.name.includes("soak"));
  if (slow.length) fail(`slow production checks: ${slow.map((r) => `${r.name}=${r.ms}ms`).join(", ")}`);

  console.log(`live production gate passed for ${APP_URL.origin}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
