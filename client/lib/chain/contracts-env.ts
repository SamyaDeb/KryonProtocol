/**
 * Protocol contract addresses from the environment. SERVER ONLY.
 *
 * Split out of `./networks.ts` because it reads a deployment record from disk,
 * and `node:fs` anywhere in that module's import graph fails the client build:
 * `lib/network.ts` re-exports the network registry to the browser, and Turbopack
 * refuses to chunk an external module for a client bundle.
 */

import { readFileSync } from "node:fs";
import { getAddress } from "viem";

import {
  CONTRACT_KEYS,
  contractsFromDeploymentJson,
  type ArcNetwork,
  type Env,
  type ProtocolContracts,
} from "./networks";

/**
 * Server-side contract addresses. `KRYON_DEPLOYMENT_FILE` (a deployment
 * record) wins; otherwise every `CONTRACT_*` variable must be set. There is no
 * baked default: pointing a keeper at the wrong vault is worse than not starting.
 */
export function serverContracts(
  network: ArcNetwork,
  env: Env = process.env
): ProtocolContracts {
  if (env.KRYON_DEPLOYMENT_FILE) {
    return contractsFromDeploymentJson(readFileSync(env.KRYON_DEPLOYMENT_FILE, "utf8"), network.chainId);
  }
  const out = {} as ProtocolContracts;
  const missing: string[] = [];
  for (const [key, names] of Object.entries(CONTRACT_KEYS) as [keyof ProtocolContracts, { env: string }][]) {
    const raw = env[names.env];
    if (!raw) {
      missing.push(names.env);
      continue;
    }
    out[key] = getAddress(raw);
  }
  if (missing.length > 0) {
    throw new Error(
      `Contract addresses for ${network.id} are not configured. Set KRYON_DEPLOYMENT_FILE or: ${missing.join(", ")}`
    );
  }
  return out;
}
