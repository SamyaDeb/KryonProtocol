// Preflight checks that run before a deployment writes anything to a network.
//
// The existing preflight pins each artifact's sha256 against a rehearsed set.
// That answers "is this the build we tested?" — a good question — but it never
// asks "can this build ever be fixed?". Both live deployments were shipped from
// a build with no `upgrade` entrypoint, so every contract on testnet and
// mainnet is permanently immutable: no audit finding can be patched, and the
// only remedy is a full redeploy and state migration. A hash check cannot catch
// that, because the hash was correct.
//
// Pure functions, no I/O, so they can be tested.

/**
 * Entrypoints every deployable contract must expose.
 *
 * `upgrade` is the one that matters: without it the contract's code is frozen
 * at deployment, forever. The two-step admin transfer is included because a
 * contract that cannot hand over ownership is stuck with whatever key deployed
 * it, which is the same failure in a different dimension.
 */
export const REQUIRED_LIFECYCLE_EXPORTS = ["upgrade", "nominate_admin", "accept_admin"] as const;

/** Read the exported function names from a compiled Soroban contract. */
export function contractExports(wasm: Uint8Array | Buffer): string[] {
  // Not named `module`: assigning that identifier is forbidden by the Next
  // lint rule, since it shadows the CommonJS global.
  const compiled = new WebAssembly.Module(wasm as BufferSource);
  return WebAssembly.Module.exports(compiled)
    .filter((e) => e.kind === "function")
    .map((e) => e.name);
}

/**
 * Lifecycle entrypoints this artifact is missing. Empty means it is safe to
 * deploy on that axis.
 */
export function missingLifecycleExports(exports: readonly string[]): string[] {
  const present = new Set(exports);
  return REQUIRED_LIFECYCLE_EXPORTS.filter((fn) => !present.has(fn));
}

export interface RoleKeys {
  /** Role name -> the public key that will hold it. */
  [role: string]: string | undefined;
}

/**
 * Roles that must never share a key with `admin`.
 *
 * The admin can replace every contract's code. The operator roles sign
 * continuously from keeper hosts, which makes them the most exposed keys in the
 * system — so a key that is both is a single compromise away from total
 * takeover. Testnet shipped with the oracle publisher AS the protocol admin,
 * which is precisely the pairing the settlement route already warns against:
 * "one key must never serve two roles".
 */
export const OPERATOR_ROLES = ["oracle", "matcher", "liquidator", "ttl", "funding"] as const;

/**
 * Human-readable violations of key separation. Empty means the roles are
 * distinct. Roles that are absent are skipped rather than reported — a
 * deployment need not configure every keeper up front.
 */
export function keySeparationViolations(roles: RoleKeys): string[] {
  const problems: string[] = [];
  const admin = roles.admin;

  if (admin) {
    for (const role of OPERATOR_ROLES) {
      if (roles[role] && roles[role] === admin) {
        problems.push(
          `${role} shares a key with admin (${admin.slice(0, 8)}…) — a compromise of ` +
            `the ${role} keeper would grant power to replace every contract`
        );
      }
    }
  }

  // Distinct operator roles sharing a key is milder but still collapses the
  // blast radius of any one keeper host into all of them.
  const seen = new Map<string, string>();
  for (const role of OPERATOR_ROLES) {
    const key = roles[role];
    if (!key) continue;
    const first = seen.get(key);
    if (first) {
      problems.push(`${role} shares a key with ${first} (${key.slice(0, 8)}…)`);
    } else {
      seen.set(key, role);
    }
  }

  return problems;
}
