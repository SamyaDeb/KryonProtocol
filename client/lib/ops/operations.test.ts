// Each builder must encode the call the contract actually exposes, and say in
// words what it will do. Calldata is decoded back with the same ABI, so a
// wrong function or argument order fails here rather than 48 hours later.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, keccak256, toHex, type Address } from "viem";

import { feeRouterAbi, oracleAdapterAbi, riskParamsAbi, vaultAbi } from "@/lib/chain/contracts";
import type { ProtocolContracts } from "@/lib/chain/networks";
import {
  grantRole,
  operationSalt,
  revokeRole,
  roleId,
  scheduledCall,
  setDepositCaps,
  setMarketActive,
  setMarketFees,
  setPublishers,
  ZERO_BYTES32,
  type MarketParamsInput,
} from "./operations";
import { setFundingConfig, setLiquidationParams, setMarket, setOiPolicy } from "./operations";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const contracts: ProtocolContracts = {
  vault: a(1), engine: a(2), orderGateway: a(3), oracleAdapter: a(4),
  liquidation: a(5), insurance: a(6), riskParams: a(7), feeRouter: a(8), timelock: a(9),
};
const params: MarketParamsInput = {
  oracleId: toHex("BTC", { size: 32 }),
  initialMarginBps: 200,
  maintenanceMarginBps: 100,
  liquidationFeeBps: 25,
  maxExecutionDeviationBps: 75,
  maxOracleConfidenceBps: 100,
  maxOracleAge: 15,
  maxLeverageBps: 500_000,
  active: true,
  listed: true,
  maxOpenInterest: 25n * 10n ** 18n,
  minFillNotional: 40n * 10n ** 18n,
};

test("pausing a market encodes setMarketActive and says what it stops", () => {
  const op = setMarketActive(2, false);
  assert.equal(op.contract, "riskParams");
  assert.match(op.description, /Pause market 2.*reduce-only still works/);
  const decoded = decodeFunctionData({ abi: riskParamsAbi, data: op.data });
  assert.equal(decoded.functionName, "setMarketActive");
  assert.deepEqual(decoded.args, [2, false]);
  assert.match(setMarketActive(2, true).description, /^Activate market 2$/);
});

test("setMarket carries the whole struct through", () => {
  const op = setMarket(2, params);
  const decoded = decodeFunctionData({ abi: riskParamsAbi, data: op.data });
  assert.equal(decoded.functionName, "setMarket");
  assert.equal((decoded.args as [number, MarketParamsInput])[0], 2);
  assert.deepEqual((decoded.args as [number, MarketParamsInput])[1], params);
  assert.match(op.description, /initial 2\.00%, maintenance 1\.00%, max leverage 50x, OI cap 25, min fill \$40, active/);
});

test("funding config and OI policy", () => {
  const f = decodeFunctionData({ abi: riskParamsAbi, data: setFundingConfig(3, 1n, 5n * 10n ** 14n).data });
  assert.equal(f.functionName, "setFundingConfig");
  assert.deepEqual((f.args as [number, { premiumCoeff: bigint; maxRatePerHour: bigint }])[1], {
    premiumCoeff: 1n,
    maxRatePerHour: 500_000_000_000_000n,
  });
  const o = decodeFunctionData({ abi: riskParamsAbi, data: setOiPolicy(3, 500).data });
  assert.equal(o.functionName, "setOiPolicy");
  assert.deepEqual(o.args, [3, 500n]);
});

test("deposit caps, including the closed case", () => {
  const op = setDepositCaps(250_000_000_000n, 10_000_000_000n);
  const decoded = decodeFunctionData({ abi: vaultAbi, data: op.data });
  assert.equal(decoded.functionName, "setDepositCaps");
  assert.deepEqual(decoded.args, [250_000_000_000n, 10_000_000_000n]);
  assert.match(op.description, /\$250,000 total, \$10,000 per account/);
  assert.match(setDepositCaps(0n, 0n).description, /CLOSE deposits/);
});

test("fees: a negative maker rate is called a rebate", () => {
  const op = setMarketFees(2, -50, 350);
  const decoded = decodeFunctionData({ abi: feeRouterAbi, data: op.data });
  assert.equal(decoded.functionName, "setMarketFees");
  assert.deepEqual(decoded.args, [2, -50, 350]);
  assert.match(op.description, /maker -0\.50 bps \(rebate\), taker 3\.50 bps/);
});

test("liquidation params", () => {
  assert.match(setLiquidationParams(15, 5000).description, /reward cap 0\.15% of notional, partial close 50\.00% of the position/);
});

test("publishers are replaced as a set, and the description says so", () => {
  const op = setPublishers([a(11), a(12)]);
  const decoded = decodeFunctionData({ abi: oracleAdapterAbi, data: op.data });
  assert.equal(decoded.functionName, "setPublishers");
  // viem decodes addresses checksummed.
  const [keys] = decoded.args as [readonly Address[]];
  assert.deepEqual(keys.map((k) => k.toLowerCase()), [a(11), a(12)]);
  assert.match(op.description, /Anyone not listed stops being a publisher/);
});

test("role ids match keccak of the name, with admin as zero", () => {
  assert.equal(roleId("DEFAULT_ADMIN_ROLE"), ZERO_BYTES32);
  assert.equal(roleId("BACKSTOP_SIGNER_ROLE"), keccak256(toHex("BACKSTOP_SIGNER_ROLE")));
  const op = grantRole("insurance", "BACKSTOP_SIGNER_ROLE", a(20));
  assert.equal(op.contract, "insurance");
  assert.match(op.description, /Grant BACKSTOP_SIGNER_ROLE on insurance/);
  assert.match(revokeRole("orderGateway", "OPERATOR_ROLE", a(21)).description, /Revoke OPERATOR_ROLE on orderGateway/);
});

test("a scheduled call points at the right contract, with no value and no predecessor", () => {
  const op = setMarketActive(2, false);
  const salt = operationSalt(op.description, 1_800_000_000_000);
  const call = scheduledCall(op, contracts, salt, 172_800n);
  assert.equal(call.target, contracts.riskParams);
  assert.equal(call.value, 0n);
  assert.equal(call.predecessor, ZERO_BYTES32);
  assert.equal(call.delaySeconds, 172_800n);
  assert.equal(call.salt, salt);
});

test("the salt separates the same change repeated later", () => {
  const d = "Set deposit caps";
  assert.notEqual(operationSalt(d, 1), operationSalt(d, 2));
  assert.equal(operationSalt(d, 1), operationSalt(d, 1));
});
