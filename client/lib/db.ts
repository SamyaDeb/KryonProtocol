import { neon, type SqlClient } from "@/lib/sql";
import { PRIMARY_NETWORK, type NetworkId } from "@/config/networks";

// Server-side only — never import this in client components.
// The DATABASE_URL_* vars are private (no NEXT_PUBLIC_ prefix).

/**
 * Each network has its own physical database (`kryon_mainnet`,
 * `kryon_testnet`), so routing a request to the right venue means routing it to
 * the right connection string.
 *
 * `DATABASE_URL` (unsuffixed) is the legacy single-network var and is treated
 * as belonging to the deployment's PRIMARY network. A deployment that has only
 * ever set `DATABASE_URL` therefore keeps working unchanged.
 */
function urlForNetwork(network: NetworkId): string {
  const explicit =
    network === "mainnet"
      ? process.env.DATABASE_URL_MAINNET
      : process.env.DATABASE_URL_TESTNET;
  if (explicit) return explicit;

  const legacy = process.env.DATABASE_URL;
  if (legacy && network === PRIMARY_NETWORK) return legacy;

  // Deliberately NOT falling back to the other network's database. Serving
  // mainnet rows to a caller who asked for testnet — positions, fills,
  // balances — would be worse than an outage: the UI would present real
  // money as play money against testnet contract addresses. Fail loudly.
  const varName = network === "mainnet" ? "DATABASE_URL_MAINNET" : "DATABASE_URL_TESTNET";
  throw new Error(
    `No database configured for network "${network}". Set ${varName} ` +
      `(or DATABASE_URL if ${network} is this deployment's primary network).`
  );
}

// One client per network, created lazily so an unconfigured secondary network
// only throws for requests that actually ask for it.
const clients = new Map<NetworkId, SqlClient>();

/**
 * Get the SQL client for a network. Defaults to the deployment's primary
 * network so existing `db()` call sites keep their previous behaviour; request
 * handlers should pass the network from `networkFromRequest(req)`.
 */
function getDb(network: NetworkId = PRIMARY_NETWORK): SqlClient {
  const cached = clients.get(network);
  if (cached) return cached;
  const client = neon(urlForNetwork(network));
  clients.set(network, client);
  return client;
}

export const db = getDb;

/**
 * Retry a DB operation on transient Neon errors ("fetch failed",
 * connection resets) which occur sporadically under burst on the serverless
 * driver. Deterministic errors (constraint violations, bad SQL) are NOT
 * retried — they surface immediately.
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
