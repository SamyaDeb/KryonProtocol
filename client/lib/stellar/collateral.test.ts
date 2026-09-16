import test from "node:test";
import assert from "node:assert/strict";
import { roundToBridgeable } from "./collateral";
import type { CollateralAsset } from "@/config";

const usdt0: CollateralAsset = {
  code: "USDT0",
  contract: "C".padEnd(56, "A"),
  issuer: "G".padEnd(56, "A"),
  oracleSymbol: "USDT0",
  settlement: false,
  bridgeDecimals: 6,
};

const usdc: CollateralAsset = {
  code: "USDC",
  contract: "C".padEnd(56, "B"),
  issuer: "G".padEnd(56, "B"),
  oracleSymbol: "USDC",
  settlement: true,
};

test("truncates the 7th decimal USDT0 cannot bridge", () => {
  // 1.2345678 USDC-units -> 1.234567, the most the OFT's 6 shared decimals hold.
  assert.equal(roundToBridgeable(12_345_678n, usdt0), 12_345_670n);
});

test("leaves an already-bridgeable amount alone", () => {
  assert.equal(roundToBridgeable(12_345_670n, usdt0), 12_345_670n);
});

test("rounds down, never up, so a withdrawal cannot exceed the balance", () => {
  assert.equal(roundToBridgeable(9n, usdt0), 0n);
  assert.equal(roundToBridgeable(19_999_999n, usdt0), 19_999_990n);
});

test("leaves assets with no bridge constraint at full precision", () => {
  assert.equal(roundToBridgeable(12_345_678n, usdc), 12_345_678n);
});
