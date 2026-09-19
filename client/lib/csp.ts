/**
 * The Content-Security-Policy, built from the same registry the app uses.
 *
 * `connect-src` is the directive that matters: it is every origin the page may
 * talk to, and a missing one fails silently — a blocked RPC read shows a blank
 * balance, a blocked WebSocket quietly falls back to polling. So the Arc RPCs
 * are read from `ARC_NETWORKS` rather than retyped here, and the test asserts
 * every endpoint the wallet layer calls is allowed.
 *
 * Imported by next.config.ts (relative path, no aliases) and by the test.
 */

import { ARC_NETWORKS, type ArcNetworkId } from "./chain/networks";

type Env = Record<string, string | undefined>;

function origin(u: string | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

/** The networks this build offers; mirrors `parseAvailable` in lib/network.ts. */
function offered(env: Env): ArcNetworkId[] {
  const ids = (env.NEXT_PUBLIC_KRYON_NETWORKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ArcNetworkId => s in ARC_NETWORKS);
  const primary = env.NEXT_PUBLIC_KRYON_NETWORK;
  if (primary && primary in ARC_NETWORKS) ids.push(primary as ArcNetworkId);
  return ids.length ? [...new Set(ids)] : ["arc-testnet"];
}

/** Wallet connectors' own endpoints: WalletConnect relay/verify, Coinbase Wallet SDK. */
const WALLET_CONNECT = [
  "https://*.walletconnect.com",
  "https://*.walletconnect.org",
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "https://api.web3modal.org",
];
const COINBASE = ["https://*.coinbase.com", "https://www.walletlink.org", "wss://www.walletlink.org"];

export function buildCsp(opts: { isDev: boolean; env: Env }): string {
  const { isDev, env } = opts;
  const networks = offered(env);
  // A dev server may be pointed at the local stack whatever the build offers.
  if (isDev && !networks.includes("arc-local")) networks.push("arc-local");

  const rpc = new Set<string>();
  for (const id of networks) {
    const n = ARC_NETWORKS[id];
    const o = origin(n.publicRpcUrl);
    if (o) rpc.add(o);
    const w = origin(n.publicWsUrl);
    if (w) rpc.add(w);
  }

  const ws = new Set(
    [
      env.NEXT_PUBLIC_WS_URL_ARC_MAINNET,
      env.NEXT_PUBLIC_WS_URL_ARC_TESTNET,
      env.NEXT_PUBLIC_WS_URL_ARC_LOCAL,
      // Legacy names, still read by the previous chain's UI until it is removed.
      env.NEXT_PUBLIC_WS_URL_MAINNET,
      env.NEXT_PUBLIC_WS_URL_TESTNET,
      env.NEXT_PUBLIC_WS_URL,
    ]
      .map(origin)
      .filter((o): o is string => o !== null)
  );
  if (isDev) for (const o of ["ws://localhost:8080", "ws://127.0.0.1:8080", "ws://localhost:8081"]) ws.add(o);
  // No WS origin configured: allow wss: rather than build a policy that blocks
  // the deployment's own feed (it would silently degrade to REST polling).
  if (ws.size === 0) ws.add("wss:");

  // The previous chain's endpoints stay until its UI is deleted (Phase 4 PR 7).
  const legacy = [
    "https://soroban-testnet.stellar.org",
    "https://soroban-mainnet.stellar.org",
    "https://mainnet.sorobanrpc.com",
    "https://horizon-testnet.stellar.org",
    "https://horizon.stellar.org",
  ];

  const connect = [
    "'self'",
    "https://api.binance.com",
    "https://*.tradingview.com",
    "wss://*.tradingview.com",
    ...rpc,
    ...ws,
    ...WALLET_CONNECT,
    ...COINBASE,
    ...legacy,
  ];

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://s3.tradingview.com`,
    // WalletConnect's verify API runs in an iframe.
    "frame-src 'self' https://s.tradingview.com https://www.tradingview.com https://verify.walletconnect.com https://verify.walletconnect.org",
    `connect-src ${[...new Set(connect)].join(" ")}`,
    "worker-src 'self' blob:",
  ].join("; ");
}
