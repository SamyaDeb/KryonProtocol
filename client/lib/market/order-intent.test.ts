// Regression guard for the cross-market nonce collision (MULTI-MARKET-PLAN §7.3).
// Run: npm run test:config

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOrderIntent, nextOrderNonce } from "./order-intent";

const OWNER = "GBTL7SKBHYAROO5CYGTQ4ITTEPTUUPIXDFDYZNDNAYQJ4J5XENX4TGDI";

test("nonces are unique within a single millisecond", () => {
  const start = Date.now();
  const nonces = new Set<bigint>();
  // Tight loop: on any modern machine these all land in the same millisecond,
  // which is exactly the case a bare Date.now() could not distinguish.
  // Deliberately more than the 1000-per-ms counter width, so the monotonic
  // clamp — not the counter — is what has to carry uniqueness here.
  for (let i = 0; i < 5000; i++) nonces.add(nextOrderNonce());
  assert.equal(nonces.size, 5000, "nextOrderNonce produced duplicates");
  assert.ok(Date.now() - start < 250, "loop was too slow to exercise the same-ms case");
});

test("orders in two different markets never share a nonce", () => {
  // The (owner, nonce) key is global per account — the market id is NOT part
  // of it, on-chain or in the DB — so two markets must still differ.
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    for (const marketId of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const intent = buildOrderIntent({
        owner: OWNER,
        marketId,
        isLong: true,
        size: 10n,
        limitPrice: 1n,
      });
      const key = `${intent.owner}:${intent.nonce}`;
      assert.ok(!seen.has(key), `collision on (owner, nonce) across markets at i=${i} market=${marketId}`);
      seen.add(key);
    }
  }
});

test("nonces are monotonically increasing", () => {
  let prev = nextOrderNonce();
  for (let i = 0; i < 200; i++) {
    const next = nextOrderNonce();
    assert.ok(next > prev, `nonce went backwards: ${prev} -> ${next}`);
    prev = next;
  }
});

test("nonces fit in a u64", () => {
  const U64_MAX = 2n ** 64n - 1n;
  for (let i = 0; i < 50; i++) {
    const n = nextOrderNonce();
    assert.ok(n > 0n && n <= U64_MAX, `nonce ${n} out of u64 range`);
  }
});
