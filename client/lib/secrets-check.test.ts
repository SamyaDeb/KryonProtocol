import { test } from "node:test";
import assert from "node:assert/strict";

import { looksLikeTestKey } from "./secrets-check";

test("anvil's public development keys are recognised, with or without 0x", () => {
  // Account 0 of the "test test … junk" mnemonic.
  assert.equal(looksLikeTestKey("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), true);
  assert.equal(looksLikeTestKey("AC0974BEC39A17E36BA4A6B4D238FF944BACB478CBED5EFCAE784D7BF4F2FF80"), true);
  // Account 1.
  assert.equal(looksLikeTestKey("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"), true);
});

test("anything else is not", () => {
  assert.equal(looksLikeTestKey(`0x${"1".repeat(64)}`), false);
  assert.equal(looksLikeTestKey("kms:alias/kryon-matcher"), false);
  assert.equal(looksLikeTestKey(""), false);
});
