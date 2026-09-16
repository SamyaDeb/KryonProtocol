// Both live deployments shipped without an `upgrade` entrypoint, which froze
// every contract permanently. These pin the checks that would have refused it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contractExports,
  missingLifecycleExports,
  keySeparationViolations,
  REQUIRED_LIFECYCLE_EXPORTS,
} from "./deploy-preflight";

test("an artifact missing upgrade is reported", () => {
  const missing = missingLifecycleExports(["initialize", "nominate_admin", "accept_admin"]);
  assert.deepEqual(missing, ["upgrade"]);
});

test("a complete artifact reports nothing", () => {
  assert.deepEqual(missingLifecycleExports([...REQUIRED_LIFECYCLE_EXPORTS, "initialize"]), []);
});

test("the exact mainnet engine interface is refused", () => {
  // Verbatim from the deployed mainnet engine, which cannot be upgraded.
  const deployed = [
    "accept_admin", "charge_trade_fee", "close_position", "extend_instance_ttl",
    "funding_state", "increase_position", "initialize", "liquidate_reduce",
    "long_open_interest", "nominate_admin", "open_interest", "open_position",
    "positions", "reduce_position", "set_fee_collector", "set_fee_config",
    "set_fee_recipient", "set_funding_config", "set_insurance", "set_liquidation",
    "set_market", "set_order_gateway", "short_open_interest", "update_funding",
  ];
  assert.deepEqual(
    missingLifecycleExports(deployed),
    ["upgrade"],
    "the build that is live on mainnet must fail this check"
  );
});

test("contractExports reads function exports from real wasm", () => {
  // Minimal module exporting one function, hand-assembled: magic + version,
  // type section (() -> ()), function section, export section, code section.
  const wasm = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x0b, 0x01, 0x07, 0x75, 0x70, 0x67, 0x72, 0x61, 0x64, 0x65, 0x00, 0x00,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
  ]);
  assert.deepEqual(contractExports(wasm), ["upgrade"]);
});

test("the oracle publisher holding admin is flagged", () => {
  // The shape testnet actually shipped with.
  const problems = keySeparationViolations({
    admin: "GA3SSO6D4YL5W6NDCO5V72BN5PHXC3SOBRAFMDSMUOM7OTXY2S6UAUHF",
    oracle: "GA3SSO6D4YL5W6NDCO5V72BN5PHXC3SOBRAFMDSMUOM7OTXY2S6UAUHF",
    matcher: "GC3JI2IC7ROSBFL5GVAIWKMBHV4E6ZUZKHC6N4R37NO4VK3UJTYRK63O",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /oracle shares a key with admin/);
});

test("two keepers sharing a key is flagged", () => {
  const problems = keySeparationViolations({
    admin: "GADMIN000000000000000000000000000000000000000000000000AA",
    oracle: "GSHARED00000000000000000000000000000000000000000000000BB",
    liquidator: "GSHARED00000000000000000000000000000000000000000000000BB",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /liquidator shares a key with oracle/);
});

test("distinct roles pass, and absent roles are not invented", () => {
  assert.deepEqual(
    keySeparationViolations({
      admin: "GADMIN000000000000000000000000000000000000000000000000AA",
      oracle: "GORACLE00000000000000000000000000000000000000000000000BB",
      matcher: undefined,
    }),
    []
  );
});
