import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyTestnetRoles, type TestnetRoles } from "./testnet-roles";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const roles: TestnetRoles = {
  governance: a(1),
  guardian: a(2),
  treasury: a(3),
  operators: [a(4)],
  publishers: [a(5), a(6)],
  fundingKeepers: [a(7)],
  feeTierBots: [a(8)],
};

test("fills every placeholder in the real arc-testnet.toml and nothing else", () => {
  const path = resolve(import.meta.dirname, "../../../kryon-protocol/infra/deploy/environments/arc-testnet.toml");
  const before = readFileSync(path, "utf8");
  const after = applyTestnetRoles(before, roles);
  assert.match(after, /^proposers = \["0x0{39}1"\]$/m);
  assert.match(after, /^executors = \["0x0{39}1"\]$/m);
  assert.match(after, /^guardian = "0x0{39}2"$/m);
  assert.match(after, /^treasury = "0x0{39}3"$/m);
  assert.match(after, /^publishers = \["0x0{39}5", "0x0{39}6"\]$/m);
  assert.match(after, /^fee_tier_bots = \["0x0{39}8"\]$/m);
  const changed = before.split("\n").filter((l, i) => l !== after.split("\n")[i]);
  assert.equal(changed.length, 8, "exactly the eight role lines change");
  assert.equal(after.split("\n").length, before.split("\n").length);
});

test("a missing key fails loudly", () => {
  assert.throws(() => applyTestnetRoles("[governance]\nproposers = []\n", roles), /has no executors/);
  assert.throws(() => applyTestnetRoles("[roles]\n", roles), /no \[governance\] section/);
});
