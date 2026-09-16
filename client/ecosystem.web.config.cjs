// PM2 ecosystem config — the Next.js web tier, served from the services VM.
//
// WHY THE WEB TIER LIVES ON THE VM
// --------------------------------
// PostgreSQL listens on loopback only (`listen_addresses=localhost`). That is
// the right posture for a database holding real positions, but it means no
// serverless web tier — Vercel, Cloudflare Workers — can reach it: they have no
// route to the box and no static egress IP to allowlist. Every one of those
// deployments returned `readiness_unavailable` for exactly that reason.
//
// Running Next on the same host makes the database a loopback call again. The
// public edge is then a Cloudflare Tunnel, which dials OUT from this box, so
// nothing has to be exposed inbound — no VCN ingress rule, no open 5432, no
// public 3000.
//
// Usage: pm2 start ecosystem.web.config.cjs
module.exports = {
  apps: [
    {
      name: "kryon-web",
      cwd: __dirname,
      script: "npm",
      // -H is passed as a flag, NOT via the HOSTNAME env var: `next start`
      // ignores HOSTNAME (only the standalone server.js reads it) and binds
      // 0.0.0.0, which serves the whole site unencrypted on <public-ip>:3000,
      // straight past the tunnel's TLS. Verified by lsof, not assumed.
      args: "run start -- -H 127.0.0.1 -p 3000",
      // `next start` serves the prebuilt .next/ — it never compiles. Build in a
      // separate step (`npm run build`) so a failed build leaves the previous
      // known-good bundle serving instead of taking the site down.
      env: {
        NODE_ENV: "production",
      },
      max_memory_restart: "600M",
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/web.log",
      error_file: "./logs/web.error.log",
    },
  ],
};
