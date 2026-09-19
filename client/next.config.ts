import type { NextConfig } from "next";

import { buildCsp } from "./lib/csp";

const isDev = process.env.NODE_ENV !== "production";

// The policy lives in lib/csp.ts, where it is built from the Arc network
// registry and tested against the endpoints the wallet layer calls.
const csp = buildCsp({ isDev, env: process.env });

const nextConfig: NextConfig = {
  // The web tier runs on a 945MB micro instance, which cannot run `next build`
  // — the compile alone wants well over a gigabyte. Standalone emits a
  // self-contained server plus only the node_modules it actually traces, so the
  // build happens on a developer machine and ~50MB ships to the box instead of
  // a full npm install. `next start` never compiles, so serving stays cheap.
  output: "standalone",
  reactCompiler: true,
  poweredByHeader: false,
  turbopack: {
    root: __dirname,
  },
  // The Docusaurus docs site is built into public/docs as a static export and
  // served from this same deployment under /docs. Next doesn't resolve a folder
  // request to its index.html, so map clean /docs URLs onto the static files.
  // `afterFiles` means real assets (js/css/img under /docs) are served directly;
  // only bare route paths fall through to these rewrites.
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        // Docusaurus (trailingSlash:false) emits flat .html files, e.g.
        // /docs/architecture/protocol.html. Real assets (js/css/img) exist on
        // disk and are served before these afterFiles rewrites kick in.
        { source: "/docs", destination: "/docs/index.html" },
        { source: "/docs/:path+", destination: "/docs/:path+.html" },
      ],
      fallback: [],
    };
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
