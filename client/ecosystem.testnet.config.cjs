/**
 * PM2 ecosystem for the TESTNET keeper fleet.
 *
 * Usage: pm2 start ecosystem.testnet.config.cjs
 *
 * ── Why a separate file, not more apps in ecosystem.config.cjs ───────────────
 * Each keeper process serves exactly one network. The oracle publisher, matcher
 * operator and liquidator are distinct funded Stellar accounts per network, the
 * contract ids differ, and the database is a different one (`kryon_testnet`) —
 * all of which arrive through `--env-file`. Running both fleets therefore means
 * running two sets of processes with two env files, and keeping them in
 * separate ecosystem files means `pm2 start`/`pm2 stop` can address one network
 * without touching the other.
 *
 * ── Before you start this ────────────────────────────────────────────────────
 *  1. Create `client/.env.testnet` from `.env.testnet.example` and fill in the
 *     three operator secrets and DATABASE_URL. They must be THREE DISTINCT
 *     funded testnet accounts — one role per key, none of them the contract
 *     admin — and none may be reused from mainnet.
 *  2. Friendbot-fund each of them.
 *  3. Ensure the `kryon_testnet` database exists and is migrated.
 *
 * ── Capacity warning ─────────────────────────────────────────────────────────
 * The current services VM is a VM.Standard.E2.1.Micro with 945MB RAM, already
 * running the seven mainnet services at ~85% memory plus swap. It CANNOT host a
 * second fleet. Put this on a separate host (or upgrade to A1.Flex) before
 * starting it — otherwise both fleets will thrash and the mainnet oracle will
 * start missing publishes, which is a liquidation-safety issue, not a
 * convenience one.
 *
 * Port note: the testnet ws-server binds 8081, so it can coexist with the
 * mainnet ws-server on 8080 if they ever do share a host.
 */

const ENV_FILE = ".env.testnet";

// The one knob that differs per service; everything else is boilerplate that
// was previously copy-pasted eight times in the mainnet file.
const SERVICES = [
  { name: "oracle", script: "oracle-keeper.ts", restart_delay: 5000, max_restarts: 20 },
  { name: "matcher", script: "matcher-service.ts", restart_delay: 3000, max_restarts: 20 },
  { name: "indexer", script: "state-indexer.ts", restart_delay: 5000, max_restarts: 20 },
  {
    name: "ws",
    script: "ws-server.ts",
    restart_delay: 3000,
    max_restarts: 20,
    // 8081, not 8080 — leaves the mainnet ws-server's port free.
    env: { PORT: "8081" },
  },
  { name: "liquidator", script: "liquidation-keeper.ts", restart_delay: 5000, max_restarts: 20 },
  { name: "funding", script: "funding-keeper.ts", restart_delay: 5000, max_restarts: 20 },
  { name: "reconciler", script: "settlement-reconciler.ts", restart_delay: 10000, max_restarts: 10 },
  {
    name: "monitor",
    script: "monitor.ts",
    restart_delay: 10000,
    max_restarts: 20,
    // The local testnet WS server, not the public NEXT_PUBLIC_WS_URL_TESTNET.
    env: { MONITOR_WS_URL: "ws://localhost:8081" },
  },
];

module.exports = {
  apps: SERVICES.map((svc) => ({
    // `kryon-testnet-*` so `pm2 status` distinguishes the two fleets at a glance
    // and `pm2 restart /kryon-testnet-/` addresses only this one.
    name: `kryon-testnet-${svc.name}`,
    script: "npx",
    args: `tsx --env-file=${ENV_FILE} scripts/${svc.script}`,
    cwd: __dirname,
    env: svc.env,
    restart_delay: svc.restart_delay,
    max_restarts: svc.max_restarts,
    autorestart: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    out_file: `./logs/testnet-${svc.name}.log`,
    error_file: `./logs/testnet-${svc.name}.error.log`,
  })),
};
