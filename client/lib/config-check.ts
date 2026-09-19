/**
 * Boot-time configuration check, per process role.
 *
 * A misconfigured deployment should fail when it starts, with every problem
 * listed at once, not at the first request or the first transaction, one
 * problem per restart. Each service calls `assertServiceConfig(role)` before
 * doing anything else; the web app reports `checkWebConfig()` through
 * `GET /api/ready`.
 *
 * What is checked:
 *   - network id (explicit, valid) and, for chain readers, the deployment
 *     record: present, parseable, and for the right chain id
 *   - RPC: at least two provider URLs (ARC_RPC_URLS) off arc-local, so one
 *     provider outage is not an outage
 *   - database URL
 *   - the role's signer (lib/chain/signer.ts): a mode that is allowed on this
 *     network, and whatever that mode needs (key, keystore file, passphrase)
 *   - role-specific required settings
 *   - web in production: Upstash rate-limit settings (without them
 *     lib/rate-limit.ts denies every request)
 *   - no secret in a NEXT_PUBLIC_* variable, by name or by value
 *
 * Server-side only. Messages name variables, never their values.
 */

import { existsSync } from "node:fs";

import { rpcUrlsFromEnv } from "./chain/clients";
import { serverContracts } from "./chain/contracts-env";
import { arcNetwork, isArcNetworkId, type ArcNetworkId, type Env } from "./chain/networks";
import { signerRole, signerSpec } from "./chain/signer";
import { parseSchedule } from "./keepers/fee-tier";
import { publicSecretLeaks } from "./secrets-check";

export const SERVICE_ROLES = [
  "oracle-keeper",
  "matcher",
  "state-indexer",
  "reconciler",
  "funding-keeper",
  "liquidation-keeper",
  "keeper-refill",
  "monitor",
  "ws-server",
  "stats-aggregator",
  "backstop-unwinder",
  "fee-tier-bot",
] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];

interface RoleSpec {
  /** The role's key variable (names the signer role), if it signs. */
  key?: string;
  /** Reads contracts over RPC: needs the deployment record and RPC URLs. */
  chain: boolean;
  /** Settings the script refuses to start without. */
  required?: string[];
  /** Extra validation of role settings; return problems. */
  validate?: (env: Env) => string[];
}

const ROLES: Record<ServiceRole, RoleSpec> = {
  "oracle-keeper": { key: "ORACLE_PUBLISHER_PRIVATE_KEY", chain: true },
  matcher: { key: "MATCHER_OPERATOR_KEY", chain: true, required: ["MATCHER_MARKETS"] },
  "state-indexer": { chain: true, required: ["INDEXER_START_BLOCK"] },
  reconciler: { chain: true },
  "funding-keeper": { key: "FUNDING_KEEPER_PRIVATE_KEY", chain: true },
  "liquidation-keeper": { key: "LIQUIDATOR_PRIVATE_KEY", chain: true },
  "keeper-refill": { key: "REFILL_FUNDER_PRIVATE_KEY", chain: true, required: ["REFILL_TARGETS"] },
  monitor: { chain: true },
  "ws-server": { chain: false },
  "stats-aggregator": { chain: false },
  "backstop-unwinder": { key: "BACKSTOP_SIGNER_PRIVATE_KEY", chain: true },
  "fee-tier-bot": {
    key: "FEE_TIER_BOT_PRIVATE_KEY",
    chain: true,
    required: ["FEE_TIER_SCHEDULE"],
    validate: (env) => {
      if (!env.FEE_TIER_SCHEDULE) return [];
      try {
        parseSchedule(env.FEE_TIER_SCHEDULE);
        return [];
      } catch (err) {
        return [(err as Error).message];
      }
    },
  },
};

export interface ConfigReport {
  role: string;
  network: ArcNetworkId | null;
  problems: string[];
}

export class ConfigError extends Error {
  constructor(readonly report: ConfigReport) {
    super(
      `${report.role}: configuration invalid for ${report.network ?? "an unknown network"} (${report.problems.length} problem(s)):\n` +
        report.problems.map((p) => `  - ${p}`).join("\n")
    );
    this.name = "ConfigError";
  }
}

const MIN_RPC_URLS = 2;

function rpcProblems(network: ArcNetworkId, env: Env): string[] {
  if (network === "arc-local") return [];
  const configured = (env.ARC_RPC_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const problems: string[] = [];
  if (configured.length < MIN_RPC_URLS) {
    problems.push(`ARC_RPC_URLS lists ${configured.length} provider URL(s); ${network} needs at least ${MIN_RPC_URLS}`);
  }
  for (const u of configured) {
    try {
      const { protocol } = new URL(u);
      if (protocol !== "https:" && protocol !== "wss:") problems.push(`ARC_RPC_URLS has a non-TLS URL (${protocol}) on ${network}`);
    } catch {
      problems.push("ARC_RPC_URLS has an entry that is not a URL");
    }
  }
  // rpcUrlsFromEnv appends the public RPC; make sure that still resolves.
  if (rpcUrlsFromEnv(arcNetwork(network), env).length === 0) problems.push("no RPC URL resolves");
  return problems;
}

function deploymentProblems(network: ArcNetworkId, env: Env, fileVar = "KRYON_DEPLOYMENT_FILE"): string[] {
  const file = env[fileVar];
  if (file && !existsSync(file)) return [`${fileVar} points at a file that does not exist`];
  try {
    serverContracts(arcNetwork(network), file ? { ...env, KRYON_DEPLOYMENT_FILE: file } : env);
    return [];
  } catch (err) {
    return [`deployment record: ${(err as Error).message}`];
  }
}

/** The signer the role will load: mode allowed here, and what that mode needs. */
function signerProblems(keyEnvVar: string, network: ArcNetworkId, env: Env): string[] {
  const role = signerRole(keyEnvVar);
  let spec;
  try {
    spec = signerSpec(keyEnvVar, network, env);
  } catch (err) {
    return [(err as Error).message];
  }
  if (spec.mode === "env") {
    const raw = env[keyEnvVar];
    if (!raw) return [`${keyEnvVar} is not set (signer mode env)`];
    const key = raw.startsWith("0x") ? raw : `0x${raw}`;
    return /^0x[0-9a-fA-F]{64}$/.test(key) ? [] : [`${keyEnvVar} is not a 32-byte hex private key`];
  }
  if (spec.mode === "keystore") {
    const problems: string[] = [];
    const path = env[`KRYON_KEYSTORE_${role}`];
    if (!path) problems.push(`KRYON_KEYSTORE_${role} (keystore path) is not set`);
    else if (!existsSync(path)) problems.push(`KRYON_KEYSTORE_${role} points at a file that does not exist`);
    const passFile = env[`KRYON_KEYSTORE_${role}_PASSPHRASE_FILE`];
    if (!env[`KRYON_KEYSTORE_${role}_PASSPHRASE`] && !passFile) {
      problems.push(`KRYON_KEYSTORE_${role}_PASSPHRASE_FILE (or _PASSPHRASE) is not set`);
    } else if (passFile && !existsSync(passFile)) {
      problems.push(`KRYON_KEYSTORE_${role}_PASSPHRASE_FILE points at a file that does not exist`);
    }
    if (env[keyEnvVar]) problems.push(`${keyEnvVar} is set but unused in keystore mode; remove the plaintext key`);
    return problems;
  }
  // kms: the key id came from the spec. A plaintext key alongside it is a leak waiting to happen.
  return env[keyEnvVar] ? [`${keyEnvVar} is set but unused in kms mode; remove the plaintext key`] : [];
}

function leakProblems(env: Env): string[] {
  return publicSecretLeaks(env).map((k) => `${k} looks like a secret in a browser-bundled NEXT_PUBLIC_ variable`);
}

/** Validate a service's whole configuration. Pure apart from file-existence checks. */
export function checkServiceConfig(role: ServiceRole, env: Env = process.env): ConfigReport {
  const spec = ROLES[role];
  const problems: string[] = [];
  const raw = env.KRYON_NETWORK;
  if (!raw) problems.push("KRYON_NETWORK is not set (arc-mainnet | arc-testnet | arc-local)");
  else if (!isArcNetworkId(raw)) problems.push(`KRYON_NETWORK "${raw}" is not an Arc network id`);
  const network = isArcNetworkId(raw) ? raw : null;

  const dbVars =
    role === "stats-aggregator" && network
      ? [{ "arc-mainnet": "DATABASE_URL_MAINNET", "arc-testnet": "DATABASE_URL_TESTNET", "arc-local": "DATABASE_URL_LOCAL" }[network], "DATABASE_URL"]
      : ["DATABASE_URL"];
  if (!dbVars.some((v) => env[v])) problems.push(`${dbVars.join(" or ")} is not set`);

  for (const v of spec.required ?? []) if (!env[v]) problems.push(`${v} is not set`);
  problems.push(...(spec.validate?.(env) ?? []));
  problems.push(...leakProblems(env));

  if (network) {
    if (spec.chain) {
      problems.push(...deploymentProblems(network, env));
      problems.push(...rpcProblems(network, env));
    }
    if (spec.key) problems.push(...signerProblems(spec.key, network, env));
  }
  return { role, network, problems };
}

/** Throw a ConfigError listing every problem, or return the network. */
export function assertServiceConfig(role: ServiceRole, env: Env = process.env): ArcNetworkId {
  const report = checkServiceConfig(role, env);
  if (report.problems.length > 0) throw new ConfigError(report);
  return report.network!;
}

// ─── web ────────────────────────────────────────────────────────────────────

const DB_VAR: Record<ArcNetworkId, string> = {
  "arc-mainnet": "DATABASE_URL_MAINNET",
  "arc-testnet": "DATABASE_URL_TESTNET",
  "arc-local": "DATABASE_URL_LOCAL",
};
const DEPLOYMENT_VAR: Record<ArcNetworkId, string> = {
  "arc-mainnet": "KRYON_DEPLOYMENT_FILE_ARC_MAINNET",
  "arc-testnet": "KRYON_DEPLOYMENT_FILE_ARC_TESTNET",
  "arc-local": "KRYON_DEPLOYMENT_FILE_ARC_LOCAL",
};

/**
 * The web app serves every network in NEXT_PUBLIC_KRYON_NETWORKS (primary
 * first); each needs its own database and deployment record, resolved the way
 * lib/db.ts and lib/network-server.ts resolve them.
 */
export function checkWebConfig(env: Env = process.env): ConfigReport {
  const problems: string[] = [];
  const primaryRaw = env.NEXT_PUBLIC_KRYON_NETWORK;
  if (!primaryRaw) problems.push("NEXT_PUBLIC_KRYON_NETWORK is not set");
  else if (!isArcNetworkId(primaryRaw)) problems.push(`NEXT_PUBLIC_KRYON_NETWORK "${primaryRaw}" is not an Arc network id`);
  const primary = isArcNetworkId(primaryRaw) ? primaryRaw : null;
  if (primary && env.KRYON_NETWORK && env.KRYON_NETWORK !== primary) {
    problems.push(`KRYON_NETWORK (${env.KRYON_NETWORK}) and NEXT_PUBLIC_KRYON_NETWORK (${primary}) disagree`);
  }

  const listed = (env.NEXT_PUBLIC_KRYON_NETWORKS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of listed) if (!isArcNetworkId(id)) problems.push(`NEXT_PUBLIC_KRYON_NETWORKS has unknown network "${id}"`);
  const offered = [...new Set([...(primary ? [primary] : []), ...listed.filter(isArcNetworkId)])];

  const production = env.NODE_ENV === "production" || offered.some((n) => n !== "arc-local");
  if (production && offered.includes("arc-local") && offered.length > 1) {
    problems.push("NEXT_PUBLIC_KRYON_NETWORKS offers arc-local next to a public network");
  }

  for (const n of offered) {
    const legacyDb = env.DATABASE_URL && n === (env.KRYON_NETWORK ?? "arc-testnet");
    if (!env[DB_VAR[n]] && !legacyDb) problems.push(`${n}: ${DB_VAR[n]} is not set`);
    const fileVar = env[DEPLOYMENT_VAR[n]] ? DEPLOYMENT_VAR[n] : n === primary ? "KRYON_DEPLOYMENT_FILE" : null;
    if (!fileVar || !env[fileVar]) problems.push(`${n}: ${DEPLOYMENT_VAR[n]} is not set`);
    else problems.push(...deploymentProblems(n, env, fileVar).map((p) => `${n}: ${p}`));
    problems.push(...rpcProblems(n, env).map((p) => `${n}: ${p}`));
  }

  if (production) {
    for (const v of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
      if (!env[v]) problems.push(`${v} is not set: in production lib/rate-limit.ts denies every request without it`);
    }
  }
  problems.push(...leakProblems(env));
  return { role: "web", network: primary, problems };
}
