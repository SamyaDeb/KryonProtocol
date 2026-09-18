// PM2 ecosystem config — runs all Kryon background services.
// Usage: pm2 start ecosystem.config.cjs
//        pm2 stop all
//        pm2 logs
//        pm2 monit

module.exports = {
  apps: [
    // Two oracle publishers, so the adapter's quorum (minPublishers = 2 on
    // mainnet) is real. Each needs its own key: the second layers
    // .env.oracle-2.local over .env.local, and that file holds only
    // ORACLE_PUBLISHER_PRIVATE_KEY and ORACLE_START_OFFSET_MS. In production run
    // them on separate hosts; one host running both is for local testing.
    {
      name: "kryon-oracle",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/oracle-keeper.ts",
      cwd: __dirname,
      restart_delay: 5000,
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/oracle.log",
      error_file: "./logs/oracle.error.log",
    },
    {
      name: "kryon-oracle-2",
      script: "npx",
      args: "tsx --env-file=.env.local --env-file=.env.oracle-2.local scripts/oracle-keeper.ts",
      cwd: __dirname,
      restart_delay: 5000,
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/oracle-2.log",
      error_file: "./logs/oracle-2.error.log",
    },
    // One shard per process: one operator key, one set of markets. To run a
    // second shard, copy this entry with a different name, MATCHER_MARKETS and
    // MATCHER_OPERATOR_KEY. Never point two entries at the same key — TxSender
    // allocates the nonce for its key and two allocators produce two
    // transactions at the same nonce.
    {
      name: "kryon-matcher",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/matcher-service.ts",
      cwd: __dirname,
      // instances stays 1 by design; see the note above.
      instances: 1,
      env: { MATCHER_SHARD: "primary" },
      restart_delay: 3000,
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/matcher.log",
      error_file: "./logs/matcher.error.log",
    },
    {
      name: "kryon-indexer",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/state-indexer.ts",
      cwd: __dirname,
      restart_delay: 5000,
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/indexer.log",
      error_file: "./logs/indexer.error.log",
    },
    {
      name: "kryon-ws",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/ws-server.ts",
      cwd: __dirname,
      env: { PORT: "8080" },
      restart_delay: 3000,
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/ws.log",
      error_file: "./logs/ws.error.log",
    },
    {
      name: "kryon-liquidator",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/liquidation-keeper.ts",
      cwd: __dirname,
      restart_delay: 5000,
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/liquidator.log",
      error_file: "./logs/liquidator.error.log",
    },
    {
      name: "kryon-reconciler",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/settlement-reconciler.ts",
      cwd: __dirname,
      restart_delay: 10000,
      max_restarts: 10,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/reconciler.log",
      error_file: "./logs/reconciler.error.log",
    },
    // Funding: one KEEPER_ROLE key, a little under hourly per market.
    {
      name: "kryon-funding",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/funding-keeper.ts",
      cwd: __dirname,
      restart_delay: 10000,
      max_restarts: 10,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/funding.log",
      error_file: "./logs/funding.error.log",
    },
    // Gas top-ups for every service key above. An unattended keeper with an
    // empty gas balance fails silently, so this runs with the keepers.
    {
      name: "kryon-refill",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/keeper-refill.ts --execute --loop",
      cwd: __dirname,
      restart_delay: 30000,
      max_restarts: 10,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/refill.log",
      error_file: "./logs/refill.error.log",
    },
    {
      name: "kryon-stats",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/stats-aggregator.ts",
      cwd: __dirname,
      restart_delay: 10000,
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/stats.log",
      error_file: "./logs/stats.error.log",
    },
    {
      name: "kryon-monitor",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/monitor.ts",
      cwd: __dirname,
      // The local WS server, not the public NEXT_PUBLIC_WS_URL from .env.local.
      env: { MONITOR_WS_URL: "ws://localhost:8080" },
      restart_delay: 10000,
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/monitor.log",
      error_file: "./logs/monitor.error.log",
    },
  ],
};
