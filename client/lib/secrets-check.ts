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
 *   assertRequiredSecrets(["DATABASE_URL", "ORACLE_PUBLISHER_SECRET"]);
 */

const PLACEHOLDER_PREFIXES = [
  "change_me",
  "replace_me",
  "your_",
  "TODO",
  "FIXME",
  "<",
  "example",
];

// These Stellar secret-key prefixes identify keys that are widely-used test vectors
// and should never appear in a production environment.
const KNOWN_TEST_KEYS = [
  // Stellar SDK well-known test mnemonic keys (first few chars)
  "SCZANGBA",
  "SBGJMPZ",
];

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (PLACEHOLDER_PREFIXES.some((p) => lower.startsWith(p.toLowerCase()))) return true;
  if (value.length < 8) return true;
  return false;
}

function looksLikeTestKey(value: string): boolean {
  return KNOWN_TEST_KEYS.some((prefix) => value.startsWith(prefix));
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
    } else if (key.includes("SECRET") && looksLikeTestKey(value)) {
      suspicious.push(`${key} (matches known test key prefix — rotate before mainnet)`);
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
