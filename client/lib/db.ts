import { neon, type SqlClient } from "@/lib/sql";
import { ARC_NETWORK_IDS, type ArcNetworkId } from "@/lib/network";

// Server-side only — never import this in client components.
// The DATABASE_URL_* vars are private (no NEXT_PUBLIC_ prefix).

/**
 * Each network has its own physical database (`kryon_arc_mainnet`,
 * `kryon_arc_testnet`, and a throwaway local one), so routing a request to the
 * right venue means routing it to the right connection string.
 *
 * `DATABASE_URL` (unsuffixed) belongs to the network named by `KRYON_NETWORK`
 * — the same variable `serverNetworkId()` reads, so a keeper and the API agree
 * about which database the unsuffixed URL means. A deployment that has only
 * ever set `DATABASE_URL` therefore keeps working unchanged.
 */
const URL_VARS: Record<ArcNetworkId, string> = {
  "arc-mainnet": "DATABASE_URL_MAINNET",
  "arc-testnet": "DATABASE_URL_TESTNET",
  "arc-local": "DATABASE_URL_LOCAL",
};

function urlForNetwork(network: ArcNetworkId): string {
  // Literal member expressions, not `process.env[URL_VARS[network]]`: these are
  // server-only vars so Next's inlining is not at stake here, but the explicit
  // form is what makes a missing variable greppable.
  const explicit =
    network === "arc-mainnet"
      ? process.env.DATABASE_URL_MAINNET
      : network === "arc-testnet"
        ? process.env.DATABASE_URL_TESTNET
        : process.env.DATABASE_URL_LOCAL;
  if (explicit) return explicit;

  const legacy = process.env.DATABASE_URL;
  if (legacy && network === (process.env.KRYON_NETWORK ?? "arc-testnet")) return legacy;

  // Deliberately NOT falling back to another network's database. Serving
  // mainnet rows to a caller who asked for testnet — positions, fills,
  // balances — would be worse than an outage: the UI would present real
  // money as play money against testnet contract addresses. Fail loudly.
  throw new Error(
    `No database configured for network "${network}". Set ${URL_VARS[network]} ` +
      `(or DATABASE_URL if KRYON_NETWORK is ${network}).`
  );
}

// One client per network, created lazily so an unconfigured secondary network
// only throws for requests that actually ask for it.
const clients = new Map<ArcNetworkId, SqlClient>();

/**
 * Get the SQL client for a network.
 *
 * The network argument is REQUIRED, and deliberately so. It used to default to
 * the deployment's primary network, which meant a handler that forgot to thread
 * the caller's choice silently answered from the wrong venue — a bug with no
 * symptom until someone on testnet saw mainnet numbers. There is no correct
 * default for a per-request value, so `tsc` now asks for it at every call site.
 */
function getDb(network: ArcNetworkId): SqlClient {
  if (!(ARC_NETWORK_IDS as readonly string[]).includes(network)) {
    // Reached only from untyped callers (raw JS, a cast). Worth catching here:
    // every Arc table CHECKs its network column, so an id that is merely wrong
    // rather than absent produces a constraint violation deep inside a write.
    throw new Error(`Unknown network "${network}"`);
  }
  const cached = clients.get(network);
  if (cached) return cached;
  const client = neon(urlForNetwork(network));
  clients.set(network, client);
  return client;
}

export const db = getDb;

/**
 * Retry a DB operation on transient errors ("fetch failed", connection resets)
 * which occur sporadically under burst. Deterministic errors (constraint
 * violations, bad SQL) are NOT retried — they surface immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|connect|terminat|timeout/i.test(msg);
      if (!transient || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  throw lastErr;
}
