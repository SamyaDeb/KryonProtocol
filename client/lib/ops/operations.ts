/**
 * Governance operations as calldata: what the ops CLI can ask the timelock to
 * do, and what each one says it will do.
 *
 * Every admin function on Kryon belongs to the timelock, so an operator never
 * calls a contract directly: an operation is scheduled, waits at least 48
 * hours (`KryonTimelock.MIN_SAFE_DELAY`, enforced by the contract), and is
 * then executed. That delay is the point — anyone watching the chain sees a
 * parameter change before it takes effect — so the CLI's job is to make the
 * right call easy to build and to describe it in words before it is sent.
 *
 * Pure: builders return `{ contract, description, data }` and are tested
 * against the ABIs without a chain.
 */

import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";

import { feeRouterAbi, liquidationAbi, oracleAdapterAbi, riskParamsAbi, vaultAbi } from "@/lib/chain/contracts";
import type { ProtocolContracts } from "@/lib/chain/networks";

/** Which deployed contract an operation calls. */
export type ContractKey = keyof ProtocolContracts;

export interface Operation {
  contract: ContractKey;
  /** One line in plain words: what this does when it executes. */
  description: string;
  data: Hex;
}

/** `AccessControl.grantRole` / `revokeRole`, shared by every protocol contract. */
const ACCESS_CONTROL_ABI = [
  { type: "function", name: "grantRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
  { type: "function", name: "revokeRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
] as const;

/** The roles an operator grants by name (contracts/governance/Roles.sol). */
export const ROLE_NAMES = [
  "DEFAULT_ADMIN_ROLE",
  "RISK_ADMIN_ROLE",
  "FEE_ADMIN_ROLE",
  "FEE_TIER_ROLE",
  "OPERATOR_ROLE",
  "KEEPER_ROLE",
  "PAUSER_ROLE",
  "PUBLISHER_ROLE",
  "BACKSTOP_SIGNER_ROLE",
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** `DEFAULT_ADMIN_ROLE` is zero; every other role is the hash of its name. */
export function roleId(name: RoleName): Hex {
  return name === "DEFAULT_ADMIN_ROLE" ? `0x${"0".repeat(64)}` : keccak256(toHex(name));
}

const usd = (v: bigint) => `$${(v / 1_000_000n).toLocaleString("en-US")}`;
const bps = (v: number) => `${(v / 100).toFixed(2)}%`;

// ── Markets ──────────────────────────────────────────────────────────────────

export function setMarketActive(marketId: number, active: boolean): Operation {
  return {
    contract: "riskParams",
    description: `${active ? "Activate" : "Pause"} market ${marketId}${active ? "" : " (it stops accepting exposure-increasing fills; reduce-only still works)"}`,
    data: encodeFunctionData({ abi: riskParamsAbi, functionName: "setMarketActive", args: [marketId, active] }),
  };
}

/** The `MarketParams` struct, as `RiskParams.setMarket` takes it. */
export interface MarketParamsInput {
  oracleId: Hex;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  liquidationFeeBps: number;
  maxExecutionDeviationBps: number;
  maxOracleConfidenceBps: number;
  maxOracleAge: number;
  maxLeverageBps: number;
  active: boolean;
  listed: boolean;
  /** 1e18 base units. */
  maxOpenInterest: bigint;
  /** 1e18 USD. */
  minFillNotional: bigint;
}

export function setMarket(marketId: number, params: MarketParamsInput): Operation {
  return {
    contract: "riskParams",
    description:
      `Set market ${marketId}: initial ${bps(params.initialMarginBps)}, maintenance ${bps(params.maintenanceMarginBps)}, ` +
      `max leverage ${Math.floor(params.maxLeverageBps / 10_000)}x, OI cap ${params.maxOpenInterest / 10n ** 18n}, ` +
      `min fill $${params.minFillNotional / 10n ** 18n}, ${params.active ? "active" : "inactive"}`,
    data: encodeFunctionData({ abi: riskParamsAbi, functionName: "setMarket", args: [marketId, params] }),
  };
}

export function setFundingConfig(marketId: number, premiumCoeff: bigint, maxRatePerHour: bigint): Operation {
  return {
    contract: "riskParams",
    description: `Set market ${marketId} funding: premium coefficient ${premiumCoeff}, clamp ${maxRatePerHour} per hour (1e18 = 100%)`,
    data: encodeFunctionData({ abi: riskParamsAbi, functionName: "setFundingConfig", args: [marketId, { premiumCoeff, maxRatePerHour }] }),
  };
}

export function setOiPolicy(marketId: number, policyBps: number): Operation {
  return {
    contract: "riskParams",
    description: `Set market ${marketId} OI policy to ${bps(policyBps)} of the insurance fund (0 = no ceiling)`,
    data: encodeFunctionData({ abi: riskParamsAbi, functionName: "setOiPolicy", args: [marketId, BigInt(policyBps)] }),
  };
}

// ── Vault, fees, liquidation ────────────────────────────────────────────────

export function setDepositCaps(total: bigint, perAccount: bigint): Operation {
  return {
    contract: "vault",
    description:
      total === 0n
        ? "CLOSE deposits (cap 0): no new collateral can enter the vault"
        : `Set deposit caps: ${usd(total)} total, ${usd(perAccount)} per account`,
    data: encodeFunctionData({ abi: vaultAbi, functionName: "setDepositCaps", args: [total, perAccount] }),
  };
}

/** Rates are millionths of notional; a negative maker rate is a rebate. */
export function setMarketFees(marketId: number, makerRate: number, takerRate: number): Operation {
  const rate = (r: number) => `${(r / 100).toFixed(2)} bps`;
  return {
    contract: "feeRouter",
    description: `Set market ${marketId} fees: maker ${rate(makerRate)}${makerRate < 0 ? " (rebate)" : ""}, taker ${rate(takerRate)}`,
    data: encodeFunctionData({ abi: feeRouterAbi, functionName: "setMarketFees", args: [marketId, makerRate, takerRate] }),
  };
}

export function setLiquidationParams(maxRewardBps: number, partialBps: number): Operation {
  return {
    contract: "liquidation",
    description: `Set liquidation: reward cap ${bps(maxRewardBps)} of notional, partial close ${bps(partialBps)} of the position`,
    data: encodeFunctionData({ abi: liquidationAbi, functionName: "setParams", args: [maxRewardBps, partialBps] }),
  };
}

// ── Oracle ───────────────────────────────────────────────────────────────────

/**
 * Publishers are replaced as a whole set: whoever is not in the list loses
 * PUBLISHER_ROLE when this executes.
 */
export function setPublishers(keys: Address[]): Operation {
  return {
    contract: "oracleAdapter",
    description: `Replace the publisher set with ${keys.length} key(s): ${keys.join(", ")}. Anyone not listed stops being a publisher`,
    data: encodeFunctionData({ abi: oracleAdapterAbi, functionName: "setPublishers", args: [keys] }),
  };
}

// ── Roles ────────────────────────────────────────────────────────────────────

export function grantRole(contract: ContractKey, role: RoleName, account: Address): Operation {
  return {
    contract,
    description: `Grant ${role} on ${contract} to ${account}`,
    data: encodeFunctionData({ abi: ACCESS_CONTROL_ABI, functionName: "grantRole", args: [roleId(role), account] }),
  };
}

export function revokeRole(contract: ContractKey, role: RoleName, account: Address): Operation {
  return {
    contract,
    description: `Revoke ${role} on ${contract} from ${account}`,
    data: encodeFunctionData({ abi: ACCESS_CONTROL_ABI, functionName: "revokeRole", args: [roleId(role), account] }),
  };
}

// ── Timelock plumbing ────────────────────────────────────────────────────────

export const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;

/**
 * A salt makes two identical operations distinguishable — scheduling the same
 * call twice with the same salt reverts, because the id is the same. It is
 * derived from the description and the time so a repeat of the same change
 * (raise the cap again next week) gets its own id, and is printed so the
 * execute step can reproduce it.
 */
export function operationSalt(description: string, nowMs: number): Hex {
  return keccak256(toHex(`${description}@${nowMs}`));
}

export interface ScheduledCall {
  target: Address;
  value: bigint;
  data: Hex;
  predecessor: Hex;
  salt: Hex;
  delaySeconds: bigint;
}

export function scheduledCall(op: Operation, contracts: ProtocolContracts, salt: Hex, delaySeconds: bigint): ScheduledCall {
  return { target: contracts[op.contract], value: 0n, data: op.data, predecessor: ZERO_BYTES32, salt, delaySeconds };
}
