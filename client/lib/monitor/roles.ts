/**
 * Who should hold which role, and how to tell when that changed.
 *
 * Two sources of truth, in order:
 *
 *  1. Invariants that hold on every correct deployment, straight from
 *     `DeploymentVerifier` (kryon-protocol/evm/script/lib): the timelock is the
 *     sole holder of every admin role on every proxy, and LEDGER_ROLE /
 *     FEE_SOURCE_ROLE are held by exactly the contracts wired to them. These
 *     need no configuration.
 *  2. A baseline file for everything else (service keys, the guardian, the
 *     timelock's proposers and executors), written from the chain right after
 *     `99_VerifyDeployment` passes: `monitor.ts --print-role-baseline`.
 *
 * Any difference is drift, and drift is a PAGE: it means a grant, a revoke or
 * an upgrade happened, and every one of those should have been expected.
 */

import { readFileSync } from "node:fs";
import { getAddress, keccak256, toHex, zeroHash, type Hex } from "viem";

import type { ProtocolContracts } from "@/lib/chain/networks";

export const PROXY_KEYS = [
  "vault",
  "engine",
  "orderGateway",
  "oracleAdapter",
  "liquidation",
  "insurance",
  "riskParams",
  "feeRouter",
] as const satisfies readonly (keyof ProtocolContracts)[];
export type ProxyKey = (typeof PROXY_KEYS)[number];
export type RoleContractKey = ProxyKey | "timelock";

/** `kryon-protocol/evm/src/governance/Roles.sol`. */
export const PROXY_ROLES = [
  "DEFAULT_ADMIN_ROLE",
  "UPGRADER_ROLE",
  "RISK_ADMIN_ROLE",
  "FEE_ADMIN_ROLE",
  "OPERATOR_ROLE",
  "PUBLISHER_ROLE",
  "KEEPER_ROLE",
  "PAUSER_ROLE",
  "FEE_TIER_ROLE",
  "BACKSTOP_SIGNER_ROLE",
  "LEDGER_ROLE",
  "FEE_SOURCE_ROLE",
] as const;

/** OpenZeppelin TimelockController. */
export const TIMELOCK_ROLES = ["DEFAULT_ADMIN_ROLE", "PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE"] as const;

export const ADMIN_ROLES = ["DEFAULT_ADMIN_ROLE", "UPGRADER_ROLE", "RISK_ADMIN_ROLE", "FEE_ADMIN_ROLE"] as const;

export function roleId(name: string): Hex {
  return name === "DEFAULT_ADMIN_ROLE" ? zeroHash : keccak256(toHex(name));
}

export function rolesFor(contract: RoleContractKey): readonly string[] {
  return contract === "timelock" ? TIMELOCK_ROLES : PROXY_ROLES;
}

/** contract → role → members (lowercase). A role the contract does not use has no members. */
export type RoleMembership = Record<string, Record<string, string[]>>;

export interface RoleDrift {
  contract: string;
  role: string;
  expected: string[];
  actual: string[];
  source: "invariant" | "baseline";
}

export interface RoleVerdict {
  drift: RoleDrift[];
  /** Roles with members that neither an invariant nor the baseline covers. */
  unverified: { contract: string; role: string; actual: string[] }[];
  checkedRoles: number;
}

const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase()).sort();
const same = (a: readonly string[], b: readonly string[]) => {
  const x = lower(a);
  const y = lower(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** The fixed expectations from DeploymentVerifier. */
export function invariantRoles(c: ProtocolContracts): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const k of PROXY_KEYS) {
    out[k] = {};
    for (const r of ADMIN_ROLES) out[k][r] = [c.timelock];
  }
  out.vault.LEDGER_ROLE = [c.engine, c.feeRouter, c.liquidation, c.insurance];
  out.feeRouter.FEE_SOURCE_ROLE = [c.orderGateway, c.liquidation];
  return out;
}

export function evaluateRoles(
  actual: RoleMembership,
  contracts: ProtocolContracts,
  baseline: RoleMembership | null
): RoleVerdict {
  const inv = invariantRoles(contracts);
  const drift: RoleDrift[] = [];
  const unverified: RoleVerdict["unverified"] = [];
  let checkedRoles = 0;
  for (const [contract, roles] of Object.entries(actual)) {
    for (const [role, members] of Object.entries(roles)) {
      const fixed = inv[contract]?.[role];
      if (fixed) {
        checkedRoles += 1;
        if (!same(fixed, members)) drift.push({ contract, role, expected: lower(fixed), actual: lower(members), source: "invariant" });
        continue;
      }
      const base = baseline?.[contract]?.[role];
      if (base) {
        checkedRoles += 1;
        if (!same(base, members)) drift.push({ contract, role, expected: lower(base), actual: lower(members), source: "baseline" });
        continue;
      }
      // With a baseline loaded, a role it does not mention is expected empty:
      // the file is written from a full enumeration.
      if (baseline) {
        checkedRoles += 1;
        if (members.length > 0) drift.push({ contract, role, expected: [], actual: lower(members), source: "baseline" });
        continue;
      }
      if (members.length > 0) unverified.push({ contract, role, actual: lower(members) });
    }
  }
  return { drift, unverified, checkedRoles };
}

export function parseRoleBaseline(json: string): RoleMembership {
  const raw = JSON.parse(json) as unknown;
  if (!raw || typeof raw !== "object") throw new Error("role baseline must be a JSON object");
  const out: RoleMembership = {};
  for (const [contract, roles] of Object.entries(raw as Record<string, unknown>)) {
    if (contract.startsWith("_")) continue; // metadata: _network, _generatedAt
    if (!roles || typeof roles !== "object") throw new Error(`role baseline: "${contract}" must map roles to address lists`);
    out[contract] = {};
    for (const [role, members] of Object.entries(roles as Record<string, unknown>)) {
      if (!Array.isArray(members)) throw new Error(`role baseline: ${contract}.${role} must be an array`);
      out[contract][role] = members.map((m) => getAddress(String(m)).toLowerCase());
    }
  }
  return out;
}

export function loadRoleBaseline(path: string | null): RoleMembership | null {
  return path ? parseRoleBaseline(readFileSync(path, "utf8")) : null;
}

// ─── implementations ────────────────────────────────────────────────────────

/** ERC-1967 implementation slot. */
export const IMPL_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** Deployment-record names (`deployments/<network>.json`) for each proxy. */
const RECORD_NAMES: Record<ProxyKey, string> = {
  vault: "vault",
  engine: "engine",
  orderGateway: "gateway",
  oracleAdapter: "oracle",
  liquidation: "liquidation",
  insurance: "insurance",
  riskParams: "risk",
  feeRouter: "feeRouter",
};

export interface ExpectedImpl {
  implementation: string;
  /** keccak256 of the runtime code, when the source records it. */
  codeHash: string | null;
  source: "DeploymentArtifact" | "deployment-record";
}

/** `implementations` from a deployment record, keyed by proxy. */
export function implementationsFromRecord(json: string, contracts: ProtocolContracts): Map<string, ExpectedImpl> {
  const record = JSON.parse(json) as { implementations?: Record<string, string> };
  const out = new Map<string, ExpectedImpl>();
  if (!record.implementations) return out;
  for (const k of PROXY_KEYS) {
    const impl = record.implementations[RECORD_NAMES[k]];
    if (impl) out.set(contracts[k].toLowerCase(), { implementation: impl.toLowerCase(), codeHash: null, source: "deployment-record" });
  }
  return out;
}

export interface ImplDrift {
  contract: ProxyKey;
  proxy: string;
  expected: string | null;
  actual: string;
  reason: "implementation" | "code-hash" | "no-record";
}

export function evaluateImplementations(
  contracts: ProtocolContracts,
  actual: Map<string, { implementation: string; codeHash: string | null }>,
  expected: Map<string, ExpectedImpl>
): ImplDrift[] {
  const out: ImplDrift[] = [];
  for (const k of PROXY_KEYS) {
    const proxy = contracts[k].toLowerCase();
    const a = actual.get(proxy);
    if (!a) continue;
    const e = expected.get(proxy);
    if (!e) {
      out.push({ contract: k, proxy, expected: null, actual: a.implementation, reason: "no-record" });
      continue;
    }
    if (e.implementation !== a.implementation.toLowerCase()) {
      out.push({ contract: k, proxy, expected: e.implementation, actual: a.implementation, reason: "implementation" });
    } else if (e.codeHash && a.codeHash && e.codeHash.toLowerCase() !== a.codeHash.toLowerCase()) {
      out.push({ contract: k, proxy, expected: e.codeHash, actual: a.codeHash, reason: "code-hash" });
    }
  }
  return out;
}
