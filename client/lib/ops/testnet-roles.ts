/**
 * The arc-testnet role set: which addresses the deploy script wires into
 * which roles, and how `infra/deploy/environments/arc-testnet.toml` records
 * them. Pure, so the TOML edit is tested.
 *
 * On testnet the governance, guardian and treasury holders may be plain
 * wallets (the deploy preflight requires Safes only on mainnet). One
 * governance wallet is both timelock proposer and executor.
 */

import type { Address } from "viem";

export interface TestnetRoles {
  governance: Address;
  guardian: Address;
  treasury: Address;
  operators: Address[];
  publishers: Address[];
  fundingKeepers: Address[];
  feeTierBots: Address[];
}

const list = (xs: Address[]) => `[${xs.map((x) => `"${x}"`).join(", ")}]`;

/**
 * Rewrite the role lines of the TOML in place, keeping every comment and
 * every other line. Throws if a line it must set is missing, so a renamed key
 * in the config fails loudly instead of deploying with a placeholder.
 */
export function applyTestnetRoles(toml: string, r: TestnetRoles): string {
  const sets: [section: string, key: string, value: string][] = [
    ["governance", "proposers", list([r.governance])],
    ["governance", "executors", list([r.governance])],
    ["governance", "guardian", `"${r.guardian}"`],
    ["governance", "treasury", `"${r.treasury}"`],
    ["roles", "operators", list(r.operators)],
    ["roles", "publishers", list(r.publishers)],
    ["roles", "funding_keepers", list(r.fundingKeepers)],
    ["roles", "fee_tier_bots", list(r.feeTierBots)],
  ];
  const lines = toml.split("\n");
  for (const [section, key, value] of sets) {
    const start = lines.findIndex((l) => l.trim() === `[${section}]`);
    if (start < 0) throw new Error(`arc-testnet.toml has no [${section}] section`);
    let hit = -1;
    for (let i = start + 1; i < lines.length && !lines[i].trim().startsWith("["); i++) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
        hit = i;
        break;
      }
    }
    if (hit < 0) throw new Error(`arc-testnet.toml [${section}] has no ${key}`);
    lines[hit] = `${key} = ${value}`;
  }
  return lines.join("\n");
}
