/**
 * secrets-check.ts  (M4)
 *
 * Called at startup by server-side processes (matcher, oracle-keeper, reconciler)
 * to verify required secrets are present and warn when a known example/test value
 * is in use. Does NOT access the values beyond checking presence and a short prefix
 * to detect obvious placeholders.
 *
 * Usage:
 *   import { assertRequiredSecrets } from "@/lib/secrets-check";
 *   assertRequiredSecrets(["DATABASE_URL", "ORACLE_PUBLISHER_PRIVATE_KEY"]);
 */

import { bytesToHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const PLACEHOLDER_PREFIXES = [
  "change_me",
  "replace_me",
  "your_",
  "TODO",
  "FIXME",
  "<",
  "example",
];

/**
 * Anvil's development keys: derived from the public "test test … junk"
 * mnemonic, handed to every service by `npm run dev:stack`, and known to
 * everyone. Any of them on a real network is a key anyone can sign with.
 */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const ANVIL_ACCOUNTS = 20;
let knownTestKeys: Set<string> | null = null;

function testKeys(): Set<string> {
  if (!knownTestKeys) {
    knownTestKeys = new Set();
    for (let i = 0; i < ANVIL_ACCOUNTS; i++) {
      const key = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).getHdKey().privateKey;
      if (key) knownTestKeys.add(bytesToHex(key).slice(2).toLowerCase());
    }
  }
  return knownTestKeys;
}

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (PLACEHOLDER_PREFIXES.some((p) => lower.startsWith(p.toLowerCase()))) return true;
  if (value.length < 8) return true;
  return false;
}

/** True for one of anvil's public development keys, with or without 0x. */
export function looksLikeTestKey(value: string): boolean {
  const hex = value.trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(hex) && testKeys().has(hex);
}

/**
 * Asserts that all listed environment variables are set to non-empty, non-placeholder
 * values. Exits the process with status 1 if any are missing.
 *
 * Warns (but does not exit) if a key appears to be a test/example value — to allow
 * testnet operation while surfacing the issue in logs.
 */
export function assertRequiredSecrets(required: string[]): void {
  const missing: string[] = [];
  const suspicious: string[] = [];

  for (const key of required) {
    const value = process.env[key];
    if (!value) {
      missing.push(key);
      continue;
    }
    if (looksLikePlaceholder(value)) {
      suspicious.push(`${key} (looks like a placeholder)`);
    } else if (/SECRET|_KEY$/.test(key) && looksLikeTestKey(value)) {
      suspicious.push(`${key} (a public anvil development key: never use it off arc-local)`);
    }
  }

  if (missing.length > 0) {
    for (const key of missing) {
      process.stderr.write(`FATAL: missing required env var ${key}\n`);
    }
    process.stderr.write(`\nSet the above variables in .env.local (local) or Railway Secrets (production).\n`);
    process.exit(1);
  }

  if (suspicious.length > 0) {
    process.stderr.write(`\nWARNING: secrets check\n`);
    for (const msg of suspicious) {
      process.stderr.write(`   ${msg}\n`);
    }
    process.stderr.write(`\n`);
  }
}

/**
 * Validates that secret keys are NOT exposed via NEXT_PUBLIC_ prefixed env vars,
 * which would cause them to be bundled into the client JS.
 *
 * Call this from instrumentation.ts or a server component on app startup.
 */
export function assertNoPublicSecretLeak(): void {
  const leaks: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("NEXT_PUBLIC_") && key.toLowerCase().includes("secret")) {
      leaks.push(key);
    }
  }
  if (leaks.length > 0) {
    for (const key of leaks) {
      process.stderr.write(`FATAL: secret exposed as a public env var: ${key}\n`);
    }
    process.exit(1);
  }
}

/** Name fragments that never belong in a browser-bundled variable. */
const SECRET_NAME = /SECRET|PRIVATE_KEY|MNEMONIC|KEYSTORE|_TOKEN$|DATABASE_URL|API_KEY/;
/** A raw 32-byte hex key, or a Stellar secret seed. */
const SECRET_VALUE = /^(0x)?[0-9a-fA-F]{64}$|^S[A-Z2-7]{55}$/;

/**
 * NEXT_PUBLIC_* variables that look like secrets, by name or by value. Pure:
 * returns the offending names (never the values) so callers can report them.
 */
export function publicSecretLeaks(env: Record<string, string | undefined>): string[] {
  const leaks: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("NEXT_PUBLIC_")) continue;
    if (SECRET_NAME.test(key.slice("NEXT_PUBLIC_".length)) || (value && SECRET_VALUE.test(value.trim()))) leaks.push(key);
  }
  return leaks.sort();
}
