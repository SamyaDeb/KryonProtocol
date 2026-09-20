// The gate exists to catch a venue that disagrees with itself. These pin each
// disagreement it must catch.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";

import type { ProtocolContracts } from "@/lib/chain/networks";
import {
  checkApiConfig,
  checkApiMarkets,
  checkDeploymentCode,
  checkMarketParity,
  checkReady,
  describeCaps,
  renderChecks,
  summarise,
} from "./venue-gate";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const contracts: ProtocolContracts = {
  vault: a(1),
  engine: a(2),
  orderGateway: a(3),
  oracleAdapter: a(4),
  liquidation: a(5),
  insurance: a(6),
  riskParams: a(7),
  feeRouter: a(8),
  timelock: a(9),
};
const apiConfig = {
  network: "arc-testnet",
  chain_id: 5042002,
  contracts: {
    vault: a(1),
    engine: a(2),
    order_gateway: a(3),
    oracle_adapter: a(4),
    liquidation: a(5),
    insurance: a(6),
    risk_params: a(7),
    fee_router: a(8),
    timelock: a(9),
  } as Record<string, string>,
};

test("deployment code: names the addresses with no contract", () => {
  assert.equal(checkDeploymentCode(contracts, () => true).status, "ok");
  const missing = checkDeploymentCode(contracts, (x) => x !== contracts.engine);
  assert.equal(missing.status, "fail");
  assert.match(missing.detail, /engine/);
});

test("api config: the app must serve the deployment's addresses and chain", () => {
  assert.equal(checkApiConfig(apiConfig, contracts, 5042002, "arc-testnet").status, "ok");
  // Case differences are not a mismatch; a different address is.
  const cased = { ...apiConfig, contracts: { ...apiConfig.contracts, vault: a(1).toUpperCase() } };
  assert.equal(checkApiConfig(cased, contracts, 5042002, "arc-testnet").status, "ok");
  const stale = { ...apiConfig, contracts: { ...apiConfig.contracts, order_gateway: a(99) } };
  const r = checkApiConfig(stale, contracts, 5042002, "arc-testnet");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /order_gateway/);
  assert.match(checkApiConfig({ ...apiConfig, chain_id: 5042 }, contracts, 5042002, "arc-testnet").detail, /chain id/);
  const missing = { ...apiConfig, contracts: { ...apiConfig.contracts } };
  delete missing.contracts.insurance;
  assert.equal(checkApiConfig(missing, contracts, 5042002, "arc-testnet").status, "fail");
});

test("market parity: an inactive flag the chain disagrees with is a failure", () => {
  const chain = [
    { id: 2, active: true },
    { id: 3, active: true },
    { id: 4, active: false },
  ];
  assert.equal(checkMarketParity(chain, chain).status, "ok");
  // The Market.active bug: the chain lists them live, the index says otherwise.
  const flagged = checkMarketParity(chain.map((m) => ({ ...m, active: false })), chain);
  assert.equal(flagged.status, "fail");
  assert.match(flagged.detail, /market 2: indexed active=false, chain says true/);
  // Not indexed at all (indexer behind, or pointed at another deployment).
  assert.match(checkMarketParity([chain[0]], chain).detail, /market 3 is not indexed/);
  // Indexed from a different deployment.
  assert.match(checkMarketParity([...chain, { id: 9, active: true }], chain).detail, /market 9 is indexed but not listed/);
});

test("api markets: same comparison, reported against the API", () => {
  const chain = [{ id: 2, active: true }];
  assert.equal(checkApiMarkets(chain, chain).id, "api.markets");
  assert.equal(checkApiMarkets([], chain).status, "fail");
});

test("ready: only a 200 with ok counts", () => {
  assert.equal(checkReady(200, { ok: true }).status, "ok");
  const bad = checkReady(503, { ok: false, error: "config_invalid", problems: 3 });
  assert.equal(bad.status, "fail");
  assert.match(bad.detail, /503 config_invalid \(3 config problem/);
});

test("caps are reported, not failed, and closed deposits say so", () => {
  assert.match(describeCaps(0n, 0n, 0n).detail, /CLOSED/);
  assert.equal(describeCaps(0n, 0n, 0n).status, "ok");
  assert.match(describeCaps(250_000_000_000n, 10_000_000_000n, 1_000_000n).detail, /\$1 of \$250,000 used/);
});

test("summary and rendering", () => {
  const checks = [
    { id: "a", status: "ok" as const, detail: "fine" },
    { id: "bb", status: "fail" as const, detail: "broken" },
    { id: "ccc", status: "warn" as const, detail: "did not run" },
  ];
  const s = summarise(checks);
  assert.equal(s.ok, false);
  assert.deepEqual(s.failed.map((c) => c.id), ["bb"]);
  assert.deepEqual(s.warned.map((c) => c.id), ["ccc"]);
  assert.equal(renderChecks(checks), "ok    a    fine\nFAIL  bb   broken\nWARN  ccc  did not run");
  // A warning alone passes, unless the caller asks for strict.
  const warnOnly = [{ id: "a", status: "warn" as const, detail: "" }];
  assert.equal(summarise(warnOnly).ok, true);
  assert.equal(summarise(warnOnly, { strict: true }).ok, false);
});
