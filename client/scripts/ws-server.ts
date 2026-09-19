#!/usr/bin/env tsx
/**
 * ws-server — streams the book, the settled tape, an account's fills and the
 * market board over WebSocket, for one Arc network. See lib/ws/server.ts for
 * the data flow and bounds, and lib/ws/protocol.ts for the wire format.
 *
 * Channels:
 *   orderbook:<marketId>  → { type: "orderbook", market_id, bids, asks, timestamp }
 *   trades:<marketId>     → { type: "trade", market_id, price, size, side, timestamp, fill_id, … }  SETTLED only
 *   fills:<address>       → { type: "fill", status: PENDING|SETTLED|REJECTED, … }
 *   markets               → { type: "markets", markets: [...], timestamp }
 *
 * Client messages:
 *   { type: "subscribe",   channels: ["orderbook:1", "trades:1"] }  → { type: "subscribed", channels }
 *   { type: "unsubscribe", channels: ["orderbook:1"] }              → { type: "unsubscribed", channels }
 *   { type: "ping" }                                                 → { type: "pong" }
 *
 * HTTP on the same port: GET /healthz (200 ok / 503 degraded), GET /metrics.
 *
 * Environment:
 *   KRYON_NETWORK               arc-mainnet | arc-testnet | arc-local — REQUIRED, no default
 *   DATABASE_URL[_MAINNET|_TESTNET|_LOCAL]   Postgres for that network (see lib/db.ts)
 *   WS_PORT (or PORT)           listen port (default 8080)
 *   WS_HOST                     bind address (default all interfaces)
 *   WS_POLL_MS                  book/tape/fills poll period (default 500)
 *   WS_MARKETS_POLL_MS          market board poll period (default 2000)
 *   WS_MAX_CONNECTIONS          default 2000
 *   WS_MAX_CHANNELS             per connection, default 32
 *   WS_MAX_BUFFERED_BYTES       slow-consumer threshold, default 1048576
 *   WS_PING_INTERVAL_MS         default 25000
 *   WS_IDLE_TIMEOUT_MS          default 75000
 *   WS_HEALTH_STALE_MS          /healthz turns 503 after this long without a good poll (default 15000)
 *   LOG_LEVEL                   debug | info | warn | error (default info)
 *
 * Holds no key and sends no transaction.
 *
 * Usage: npm run dev:ws
 */

import { db } from "@/lib/db";
import { createLogger, envInt, Metrics, shutdownSignal, type LogLevel } from "@/lib/keepers/runtime";
import { isArcNetworkId } from "@/lib/network";
import { StreamServer } from "@/lib/ws/server";
import { dbStreamSource } from "@/lib/ws/source";
import { assertServiceConfig } from "@/lib/config-check";

const SERVICE = "ws";

async function main() {
  // Every configuration problem at once, before anything connects or signs.
  assertServiceConfig("ws-server");
  const env = process.env;
  const log = createLogger(SERVICE, (env.LOG_LEVEL as LogLevel | undefined) ?? "info");

  // Explicit, never defaulted: a stream pointed at the wrong venue shows real
  // money as play money (or the reverse) with nothing to say it is wrong.
  const network = env.KRYON_NETWORK;
  if (!isArcNetworkId(network)) throw new Error(`KRYON_NETWORK must be set to an Arc network id; got "${network ?? ""}"`);

  const metrics = new Metrics();
  const sql = db(network);
  const server = new StreamServer({
    network,
    source: dbStreamSource(sql, network),
    log,
    metrics,
    limits: {
      pollMs: envInt(env, "WS_POLL_MS", 500),
      marketsPollMs: envInt(env, "WS_MARKETS_POLL_MS", 2_000),
      maxConnections: envInt(env, "WS_MAX_CONNECTIONS", 2_000),
      maxChannelsPerConnection: envInt(env, "WS_MAX_CHANNELS", 32),
      maxBufferedBytes: envInt(env, "WS_MAX_BUFFERED_BYTES", 1024 * 1024),
      pingIntervalMs: envInt(env, "WS_PING_INTERVAL_MS", 25_000),
      idleTimeoutMs: envInt(env, "WS_IDLE_TIMEOUT_MS", 75_000),
      healthStaleMs: envInt(env, "WS_HEALTH_STALE_MS", 15_000),
    },
  });

  const shutdown = shutdownSignal(log);
  await server.listen(envInt(env, "WS_PORT", envInt(env, "PORT", 8080)), env.WS_HOST || undefined);
  await server.run(shutdown.signal);
  await sql.end();
  log.info("ws server stopped", metrics.snapshot());
  process.exit(0);
}

main().catch((err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", service: SERVICE, msg: "fatal", error: String(err) }));
  process.exit(1);
});
