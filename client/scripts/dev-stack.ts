#!/usr/bin/env tsx
/**
 * dev-stack — the whole protocol on one laptop, for UI development.
 *
 *   arc-anvil → DeployAll → deployment record → fresh local Postgres → funded
 *   test traders → oracle publisher → indexer, matcher, reconciler, funding and
 *   liquidation keepers, WebSocket server, stats aggregator
 *
 * Then `npm run dev` in another terminal serves the app against it: this script
 * writes `.env.development.local` (which Next loads ahead of `.env.local`)
 * pointing the app at the local chain, database and WS server.
 *
 * Ctrl-C tears everything down. If any service exits on its own, the stack
 * stops too: a half-running stack that looks healthy is worse than none.
 *
 * LOCAL ONLY. It refuses a non-loopback RPC or database, resets the database's
 * `public` schema on every start, and hands anvil's well-known development keys
 * to the services. Those keys are public knowledge; they must never hold value.
 *
 * Prices: by default a scripted random walk (offline, deterministic enough for
 * end-to-end tests) published through the real OraclePublisher. `--live-prices`
 * runs the real oracle-keeper against Binance/Coinbase/Kraken instead.
 *
 * Environment (all optional):
 *   KRYON_DEV_DATABASE_URL   local Postgres database, created if missing
 *                            (default postgresql://localhost:5432/kryon_dev_local)
 *   KRYON_DEPLOYMENT_FILE    where to write the deployment record
 *                            (default .dev-stack/arc-local.json)
 *   KRYON_DEV_RPC_PORT       anvil port (default 8545)
 *   KRYON_DEV_WS_PORT        WebSocket server port (default 8080)
 *
 * Flags: --live-prices, --verbose (service info logs), --no-env-file.
 *
 * Usage: npm run dev:stack
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, copyFileSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Pool } from "pg";
import { getAddress, type Address } from "viem";

import { riskParamsAbi } from "@/lib/chain/contracts";
import { TxSender } from "@/lib/chain/tx-sender";
import { PgTxJobStore } from "@/lib/chain/tx-store-pg";
import { KeeperActions, Metrics, createLogger } from "@/lib/keepers/runtime";
import { E18 } from "@/lib/keepers/testkit/trading";
import { EVM_DIR, NETWORK, ROLES, account, privateKeyOf, startLocalChain, type LocalChain } from "@/lib/keepers/testkit/localchain";
import { viemOracleChain } from "@/lib/oracle/chain";
import { OraclePublisher } from "@/lib/oracle/publisher";
import type { PriceSource } from "@/lib/oracle/sources";
import { neon, type SqlClient } from "@/lib/sql";
import { migrationSql } from "@/lib/test/pg";

const CLIENT_DIR = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const VERBOSE = args.has("--verbose");
const LIVE_PRICES = args.has("--live-prices");

const DB_URL = process.env.KRYON_DEV_DATABASE_URL ?? "postgresql://localhost:5432/kryon_dev_local";
const RPC_PORT = Number(process.env.KRYON_DEV_RPC_PORT ?? "8545");
const WS_PORT = Number(process.env.KRYON_DEV_WS_PORT ?? "8080");
const DEPLOYMENT_FILE = resolve(CLIENT_DIR, process.env.KRYON_DEPLOYMENT_FILE ?? ".dev-stack/arc-local.json");
const ENV_FILE = resolve(CLIENT_DIR, ".env.development.local");
const ENV_MARKER = "# written by `npm run dev:stack`";

/** Test traders: anvil mnemonic indices no service role uses. */
const TRADERS = [account(10), account(11), account(12)];
const TRADER_USDC = 100_000n;
/** The liquidator needs no role, only its own key. */
const LIQUIDATOR = account(8);

/** Seed prices for the synthetic venue; USDC is what the depeg guard reads. */
const SEED_PRICES: Record<string, number> = {
  BTC: 100_000,
  ETH: 3_000,
  SOL: 150,
  XRP: 0.6,
  BNB: 600,
  TRX: 0.12,
  XLM: 0.1,
  ADA: 0.4,
  USDC: 1,
};

const say = (msg: string) => process.stdout.write(`${msg}\n`);
const step = (msg: string) => say(`\n▸ ${msg}`);

function assertLocalDb(url: string) {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]", ""].includes(host)) {
    throw new Error(`dev-stack only resets a local database; KRYON_DEV_DATABASE_URL points at ${host}`);
  }
}

/** UTC on the session, as the services and the test harness pin it. */
function withUtc(url: string): string {
  const u = new URL(url);
  u.searchParams.set("options", "-c TimeZone=UTC");
  return u.toString();
}

async function resetDatabase(url: string) {
  const u = new URL(url);
  const name = u.pathname.replace(/^\//, "");
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected database name "${name}"`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const a = new Pool({ connectionString: admin.toString(), max: 1 });
  try {
    const exists = await a.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
    if (exists.rowCount === 0) await a.query(`CREATE DATABASE "${name}"`);
  } finally {
    await a.end();
  }
  const p = new Pool({ connectionString: url, max: 1 });
  try {
    await p.query(`DROP SCHEMA IF EXISTS public CASCADE`);
    await p.query(`CREATE SCHEMA public`);
    await p.query(migrationSql());
  } finally {
    await p.end();
  }
}

async function listedMarkets(lc: LocalChain) {
  const ids = (await lc.client.readContract({
    address: lc.contracts.riskParams,
    abi: riskParamsAbi,
    functionName: "marketIds",
  })) as readonly number[];
  const out: { id: number; active: boolean }[] = [];
  for (const id of ids) {
    const m = await lc.client.readContract({
      address: lc.contracts.riskParams,
      abi: riskParamsAbi,
      functionName: "market",
      args: [id],
    });
    out.push({ id: Number(id), active: m.active });
  }
  return out;
}

/**
 * DeployAll activates markets through the `active` field of the params struct
 * (`MarketParamsSet`); it never emits `MarketActiveSet`, which is the only event
 * the indexer projects into `Market.active`. Left alone, every market reads as
 * inactive and order intake rejects everything with `market_inactive`. Until
 * the indexer handles it, write the chain's answer once the listings are
 * projected — as `lib/keepers/testkit/trading.ts` does for the drills.
 */
async function seedMarketActivity(sql: SqlClient, markets: { id: number; active: boolean }[]) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const rows = await sql.query<{ n: string }[]>(`SELECT count(*) AS n FROM "Market" WHERE "network" = $1`, [NETWORK.id]);
    if (Number(rows[0].n) >= markets.length) break;
    if (Date.now() > deadline) throw new Error("the indexer did not project the market listings within 60s");
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const m of markets) {
    await sql.query(`UPDATE "Market" SET "active" = $3, "updatedAt" = now() WHERE "network" = $1 AND "id" = $2`, [
      NETWORK.id,
      m.id,
      m.active,
    ]);
  }
}

// ── Synthetic prices ─────────────────────────────────────────────────────────

/** A slow random walk, identical across the two venues but for a hair of spread. */
function syntheticVenues(): PriceSource[] {
  const px: Record<string, number> = { ...SEED_PRICES };
  let last = Date.now();
  const advance = () => {
    const now = Date.now();
    if (now - last < 1000) return;
    last = now;
    for (const s of Object.keys(px)) {
      if (s === "USDC") continue;
      px[s] *= 1 + (Math.random() - 0.5) * 0.0008; // ±4 bps per second
    }
  };
  const venue = (name: string, skew: number): PriceSource => ({
    name,
    supports: () => true,
    fetch: async (symbols) => {
      advance();
      const ts = Date.now();
      return {
        quotes: symbols
          .filter((s) => s in px)
          .map((s) => ({ source: name, symbol: s, price: BigInt(Math.round(px[s] * (1 + skew) * 1e8)) * 10n ** 10n, ts })),
        errors: [],
      };
    },
  });
  return [venue("synthetic-a", 0), venue("synthetic-b", 0.00005)];
}

function startSyntheticOracle(lc: LocalChain, sql: SqlClient): () => void {
  const log = createLogger("oracle-publisher", VERBOSE ? "info" : "warn", {}, (line) => say(`[oracle] ${line}`));
  const publisher = new OraclePublisher({
    chain: viemOracleChain({ client: lc.client, oracle: lc.contracts.oracleAdapter, self: ROLES.publisher.address }),
    sender: new TxSender({
      network: NETWORK,
      service: "oracle-publisher",
      chain: lc.client,
      signer: ROLES.publisher,
      store: new PgTxJobStore(sql),
      pollMs: 250,
    }),
    oracle: lc.contracts.oracleAdapter,
    sources: syntheticVenues(),
    log,
    metrics: new Metrics(),
    actions: new KeeperActions(sql, NETWORK.id),
    aggregate: { minSources: 2, maxSourceDeviationBps: 50n },
    policy: { deviationBps: 5n, heartbeatSecs: 5, inclusionMarginSecs: 3, maxRefDivergenceBps: 0 },
    maxQuoteAgeMs: 5_000,
    usdcDepegHaltBps: 100n,
    depegFailClosed: true,
    backdateSecs: 1,
    alertAfterSecs: 30,
  });
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    publisher
      .tick()
      .catch((e) => say(`[oracle] tick failed: ${String(e)}`))
      .finally(() => (running = false));
  }, 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// ── Child services ───────────────────────────────────────────────────────────

interface Service {
  name: string;
  script: string;
  env?: Record<string, string>;
}

function spawnService(s: Service, baseEnv: Record<string, string | undefined>, onExit: (name: string, code: number | null) => void) {
  const child: ChildProcess = spawn(resolve(CLIENT_DIR, "node_modules/.bin/tsx"), [resolve(CLIENT_DIR, "scripts", s.script)], {
    cwd: CLIENT_DIR,
    env: { ...baseEnv, ...s.env } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pipe = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) if (line.trim()) say(`[${s.name}] ${line}`);
  };
  child.stdout?.on("data", pipe);
  child.stderr?.on("data", pipe);
  child.on("exit", (code) => onExit(s.name, code));
  return child;
}

function writeAppEnv(values: Record<string, string>) {
  if (args.has("--no-env-file")) return false;
  // One descriptor for the ownership check and the write, so the file checked
  // is the file written ("a+" creates it if missing and never truncates).
  const fd = openSync(ENV_FILE, "a+");
  try {
    const current = readFileSync(fd, "utf8");
    if (current !== "" && !current.startsWith(ENV_MARKER)) {
      say(`  ! ${ENV_FILE} exists and was not written by dev:stack; leaving it alone. Set these yourself:`);
      for (const [k, v] of Object.entries(values)) say(`      ${k}=${v}`);
      return false;
    }
    const body = [
      ENV_MARKER,
      "# Points `npm run dev` at the local stack. Regenerated on every start; safe to delete.",
      ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
      "",
    ].join("\n");
    ftruncateSync(fd, 0);
    writeSync(fd, body, 0);
    return true;
  } finally {
    closeSync(fd);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  assertLocalDb(DB_URL);
  const dbUrl = withUtc(DB_URL);
  const rpc = `http://127.0.0.1:${RPC_PORT}`;

  step("Postgres: reset the local database and apply the Arc baseline");
  await resetDatabase(dbUrl);
  say(`  ${DB_URL}`);

  step("arc-anvil: start the chain and deploy Kryon (DeployAll, arc-local config)");
  const lc = await startLocalChain({ port: RPC_PORT, log: (m) => say(`  ${m}`) });
  const children: ChildProcess[] = [];
  let stopOracle: () => void = () => {};
  const sql = neon(dbUrl);

  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    say("\n▸ stopping the stack");
    stopOracle();
    for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
    await Promise.race([
      Promise.all(children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once("exit", r))))),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    lc.stop();
    await sql.end().catch(() => {});
    say("  stopped");
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  try {
    // Oracle freshness is judged against block time; mine every second so chain
    // time keeps up with the wall clock even when nothing is trading.
    await lc.client.request({ method: "evm_setIntervalMining", params: [1] } as never);

    mkdirSync(dirname(DEPLOYMENT_FILE), { recursive: true });
    copyFileSync(resolve(EVM_DIR, "deployments/arc-local.json"), DEPLOYMENT_FILE);
    say(`  deployment record → ${DEPLOYMENT_FILE}`);

    const markets = await listedMarkets(lc);
    const active = markets.filter((m) => m.active).map((m) => m.id);
    if (active.length === 0) throw new Error("the arc-local deployment lists no active market");

    step("Fund test traders (wallet USDC; deposit through the UI)");
    for (const t of TRADERS) await lc.setBalance(t.address, TRADER_USDC * E18);
    await lc.setBalance(LIQUIDATOR.address, 1_000n * E18);

    const keys = {
      MATCHER_OPERATOR_KEY: privateKeyOf(ROLES.operator),
      ORACLE_PUBLISHER_PRIVATE_KEY: privateKeyOf(ROLES.publisher),
      FUNDING_KEEPER_PRIVATE_KEY: privateKeyOf(ROLES.fundingKeeper),
      LIQUIDATOR_PRIVATE_KEY: privateKeyOf(LIQUIDATOR),
    };
    // Only what the services need, not the caller's whole environment: a stray
    // DATABASE_URL_MAINNET or ARC_RPC_URLS in the shell must not leak in.
    const baseEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // libpq defaults the database user to the OS user; keep PG* overrides too.
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PG"))),
      TZ: "UTC",
      LOG_LEVEL: VERBOSE ? "info" : "warn",
      KRYON_NETWORK: NETWORK.id,
      ARC_RPC_URLS: rpc,
      KRYON_DEPLOYMENT_FILE: DEPLOYMENT_FILE,
      DATABASE_URL: dbUrl,
      DATABASE_URL_LOCAL: dbUrl,
    };

    step("Start services");
    const services: Service[] = [
      { name: "indexer", script: "state-indexer.ts", env: { INDEXER_START_BLOCK: "0", INDEXER_POLL_MS: "500" } },
      { name: "matcher", script: "matcher-service.ts", env: { MATCHER_MARKETS: active.join(","), MATCHER_OPERATOR_KEY: keys.MATCHER_OPERATOR_KEY } },
      { name: "reconciler", script: "settlement-reconciler.ts", env: { RECONCILER_INTERVAL_MS: "5000" } },
      { name: "funding", script: "funding-keeper.ts", env: { FUNDING_KEEPER_PRIVATE_KEY: keys.FUNDING_KEEPER_PRIVATE_KEY } },
      { name: "liquidator", script: "liquidation-keeper.ts", env: { LIQUIDATOR_PRIVATE_KEY: keys.LIQUIDATOR_PRIVATE_KEY } },
      { name: "ws", script: "ws-server.ts", env: { WS_PORT: String(WS_PORT), WS_HOST: "127.0.0.1" } },
      { name: "stats", script: "stats-aggregator.ts" },
    ];
    if (LIVE_PRICES) {
      services.push({
        name: "oracle",
        script: "oracle-keeper.ts",
        env: { ORACLE_PUBLISHER_PRIVATE_KEY: keys.ORACLE_PUBLISHER_PRIVATE_KEY },
      });
    } else {
      stopOracle = startSyntheticOracle(lc, sql);
      say("  oracle publisher (synthetic prices, in process)");
    }
    const onExit = (name: string, code: number | null) => {
      if (shuttingDown) return;
      say(`\n✗ ${name} exited (code ${code}); stopping the stack. Re-run with --verbose for its logs.`);
      void shutdown(1);
    };
    for (const s of services) {
      children.push(spawnService(s, baseEnv, onExit));
      say(`  ${s.name}`);
    }

    step("Seed markets: Market.active from RiskParams");
    await seedMarketActivity(sql, markets);
    say(`  active: ${active.join(", ")}`);

    const wsUrl = `ws://127.0.0.1:${WS_PORT}`;
    const wroteEnv = writeAppEnv({
      TZ: "UTC",
      KRYON_NETWORK: NETWORK.id,
      NEXT_PUBLIC_KRYON_NETWORK: NETWORK.id,
      NEXT_PUBLIC_KRYON_NETWORKS: NETWORK.id,
      NEXT_PUBLIC_ARC_LOCAL_KEEPERS_LIVE: "true",
      NEXT_PUBLIC_WS_URL_ARC_LOCAL: wsUrl,
      ARC_RPC_URLS: rpc,
      KRYON_DEPLOYMENT_FILE_ARC_LOCAL: DEPLOYMENT_FILE,
      DATABASE_URL_LOCAL: dbUrl,
    });

    const c = lc.contracts;
    const addr = (a: Address) => getAddress(a);
    say(
      [
        "",
        "════════════════════════════════════════════════════════════════════",
        " Kryon local stack is up",
        "════════════════════════════════════════════════════════════════════",
        ` RPC         ${rpc}   (chain id ${NETWORK.chainId})`,
        ` WebSocket   ${wsUrl}`,
        ` Database    ${DB_URL}`,
        ` Prices      ${LIVE_PRICES ? "live venues (oracle-keeper)" : "synthetic random walk"}`,
        ` Markets     active ${active.join(", ")} of listed ${markets.map((m) => m.id).join(", ")}`,
        "",
        " Contracts",
        `   Vault          ${addr(c.vault)}`,
        `   OrderGateway   ${addr(c.orderGateway)}`,
        `   Engine         ${addr(c.engine)}`,
        `   FeeRouter      ${addr(c.feeRouter)}`,
        `   Insurance      ${addr(c.insurance)}`,
        `   OracleAdapter  ${addr(c.oracleAdapter)}`,
        `   USDC           ${NETWORK.usdc}`,
        "",
        ` Test traders (${TRADER_USDC.toLocaleString("en-US")} USDC each; anvil dev keys — never fund them on a real network)`,
        ...TRADERS.map((t) => `   ${t.address}  ${privateKeyOf(t)}`),
        "",
        " App",
        wroteEnv
          ? "   .env.development.local written → run `npm run dev` and open http://localhost:3000"
          : "   set the variables above, then run `npm run dev`",
        "   Wallet: add network RPC " + rpc + ", chain id " + NETWORK.chainId + ", currency USDC",
        "",
        " Ctrl-C stops everything.",
        "════════════════════════════════════════════════════════════════════",
      ].join("\n")
    );
  } catch (e) {
    say(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
    await shutdown(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
