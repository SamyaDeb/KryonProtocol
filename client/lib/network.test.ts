import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARC_NETWORK_IDS,
  arcNetwork,
  AVAILABLE_NETWORKS,
  coerceNetwork,
  explorerTxUrl,
  isArcNetworkId,
  isAvailableNetwork,
  networkShortLabel,
  NETWORK_COOKIE,
  NETWORK_PARAM,
  PRIMARY_NETWORK,
} from "@/lib/network";

// These run with no NEXT_PUBLIC_KRYON_* set, which is the unconfigured-
// deployment case: primary testnet, and testnet as the only offered venue.
// That default matters — it is what a fresh checkout and CI both get.

test("the default deployment is testnet-only", () => {
  assert.equal(PRIMARY_NETWORK, "arc-testnet");
  assert.deepEqual([...AVAILABLE_NETWORKS], ["arc-testnet"]);
});

test("every network id the database accepts is a known network", () => {
  // The CHECK constraints in 20260917000000_arc_baseline/migration.sql list
  // exactly these three. A fourth id added here without a migration would be
  // rejected by Postgres on first write, so the two lists must agree.
  assert.deepEqual([...ARC_NETWORK_IDS], ["arc-mainnet", "arc-testnet", "arc-local"]);
  for (const id of ARC_NETWORK_IDS) assert.equal(arcNetwork(id).id, id);
});

test("isArcNetworkId rejects the previous deployment's ids", () => {
  // The old chain used bare "mainnet" / "testnet". Those must not coerce into
  // an Arc id: a silent mapping would point a venue switch at another chain.
  assert.equal(isArcNetworkId("mainnet"), false);
  assert.equal(isArcNetworkId("testnet"), false);
  assert.equal(isArcNetworkId("arc-mainnet"), true);
});

test("isArcNetworkId rejects non-strings without throwing", () => {
  for (const v of [undefined, null, 5042, {}, [], true]) {
    assert.equal(isArcNetworkId(v), false);
  }
});

test("the allowlist gates what this deployment will serve", () => {
  // arc-mainnet is a real network but is not offered here, so it is not
  // available — this is what stops `?network=arc-mainnet` on a testnet
  // deployment from reaching a database it has no business reading.
  assert.equal(isArcNetworkId("arc-mainnet"), true);
  assert.equal(isAvailableNetwork("arc-mainnet"), false);
  assert.equal(isAvailableNetwork("arc-testnet"), true);
});

test("coerceNetwork falls back rather than throwing", () => {
  // A stale bookmark or a link shared from another deployment must degrade to
  // the default venue, not 500.
  assert.equal(coerceNetwork("arc-testnet"), "arc-testnet");
  assert.equal(coerceNetwork("arc-mainnet"), "arc-testnet");
  assert.equal(coerceNetwork("mainnet"), "arc-testnet");
  assert.equal(coerceNetwork(undefined), "arc-testnet");
  assert.equal(coerceNetwork(""), "arc-testnet");
  // Traversal-shaped input that also *contains* a valid id: the check has to
  // be equality against the allowlist, never a substring match.
  assert.equal(coerceNetwork("../../arc-mainnet"), "arc-testnet");
  assert.equal(coerceNetwork("arc-testnet-evil"), "arc-testnet");
});

test("coerceNetwork honours an explicit fallback", () => {
  assert.equal(coerceNetwork("nonsense", "arc-local"), "arc-local");
});

test("the cookie and param names are the ones the client writes", () => {
  // Changing either without changing the other silently strands every existing
  // visitor's selection; naming them here makes that a failing test.
  assert.equal(NETWORK_COOKIE, "kryon_network");
  assert.equal(NETWORK_PARAM, "network");
});

test("chain ids match Arc's documented values", () => {
  assert.equal(arcNetwork("arc-mainnet").chainId, 5042);
  assert.equal(arcNetwork("arc-testnet").chainId, 5042002);
  // arc-local is an anvil fork OF testnet, so it shares the chain id — which is
  // exactly why the network id, not the chain id, keys the database.
  assert.equal(arcNetwork("arc-local").chainId, 5042002);
});

test("short labels are distinct per venue", () => {
  const labels = ARC_NETWORK_IDS.map(networkShortLabel);
  assert.equal(new Set(labels).size, labels.length, `ambiguous labels: ${labels.join(", ")}`);
});

test("explorer links point at the right explorer", () => {
  const hash = "0xabc";
  assert.equal(explorerTxUrl("arc-mainnet", hash), "https://explorer.arc.io/tx/0xabc");
  assert.equal(explorerTxUrl("arc-testnet", hash), "https://explorer.testnet.arc.io/tx/0xabc");
});
