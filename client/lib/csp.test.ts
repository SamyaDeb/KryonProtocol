// The CSP must allow every endpoint the wallet layer and data feeds call. A
// missing connect-src origin fails silently in the browser (a blank balance, a
// feed that quietly falls back to polling), so it is asserted here instead.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ARC_NETWORKS } from "./chain/networks";
import { buildCsp } from "./csp";

/** connect-src as a set of exact sources: every check below is an exact match, never a substring. */
function connectSrc(csp: string): Set<string> {
  const d = csp.split("; ").find((x) => x.startsWith("connect-src "));
  assert.ok(d, "connect-src present");
  return new Set(d.slice("connect-src ".length).split(" "));
}

const originOf = (u: string) => new URL(u).origin;

test("production mainnet build allows mainnet RPC, its WS feed and the wallet relays — and no local node", () => {
  const src = connectSrc(
    buildCsp({
      isDev: false,
      env: {
        NEXT_PUBLIC_KRYON_NETWORK: "arc-mainnet",
        NEXT_PUBLIC_KRYON_NETWORKS: "arc-mainnet",
        NEXT_PUBLIC_WS_URL_ARC_MAINNET: "wss://ws.example.org/feed",
      },
    })
  );
  assert.ok(src.has(originOf(ARC_NETWORKS["arc-mainnet"].publicRpcUrl)));
  assert.ok(src.has("wss://ws.example.org"));
  assert.ok(src.has("wss://relay.walletconnect.org") && src.has("wss://relay.walletconnect.com"));
  assert.ok(src.has("https://*.coinbase.com") && src.has("wss://www.walletlink.org"));
  const loopback = [...src].filter((o) => {
    try {
      return ["127.0.0.1", "localhost"].includes(new URL(o).hostname);
    } catch {
      return false;
    }
  });
  assert.deepEqual(loopback, [], "no loopback in production");
  assert.ok(!src.has("wss:"), "a configured feed is named, not wildcarded");
});

test("testnet build allows its RPC and public WS", () => {
  const src = connectSrc(buildCsp({ isDev: false, env: { NEXT_PUBLIC_KRYON_NETWORKS: "arc-testnet" } }));
  const t = ARC_NETWORKS["arc-testnet"];
  assert.ok(src.has(originOf(t.publicRpcUrl)));
  assert.ok(src.has(originOf(t.publicWsUrl!)));
});

test("dev server reaches the local stack: anvil RPC and the dev:stack WS server", () => {
  const src = connectSrc(buildCsp({ isDev: true, env: { NEXT_PUBLIC_KRYON_NETWORKS: "arc-testnet" } }));
  assert.ok(src.has("http://127.0.0.1:8545"));
  assert.ok(src.has("ws://127.0.0.1:8080"), "dev:stack writes ws://127.0.0.1:8080");
});

test("unconfigured feed falls back to wss: rather than blocking it", () => {
  const src = connectSrc(buildCsp({ isDev: false, env: {} }));
  assert.ok(src.has("wss:"));
});

test("WalletConnect verify may frame; nothing else changes the frame policy", () => {
  const csp = buildCsp({ isDev: false, env: {} });
  assert.match(csp, /frame-src [^;]*https:\/\/verify\.walletconnect\.org/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /'unsafe-eval'/, "no eval in production");
});
