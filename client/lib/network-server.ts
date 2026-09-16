/**
 * Per-request network resolution for API routes and server components.
 *
 * Module-scope constants cannot carry a per-request value on the server — the
 * Node process is shared across every caller — so server code must resolve the
 * network from the request itself and thread it through explicitly. That is why
 * `NETWORK` / `CONTRACTS` from `@/config` are the *deployment's* network on the
 * server and must not be used to answer a request.
 */

import type { NextRequest } from "next/server";
import { getNetworkConfig, PRIMARY_NETWORK, type NetworkConfig, type NetworkId } from "@/config/networks";
import { coerceNetwork, NETWORK_COOKIE, NETWORK_PARAM } from "@/lib/network-resolve";

/**
 * Resolve the caller's network.
 *
 * Precedence matches the client: explicit `?network=` (what `apiFetch` sends on
 * every call) → the `kryon_network` cookie → the deployment default. An
 * unrecognised value falls back rather than erroring, so a stale bookmark
 * degrades to the default venue instead of a 500.
 */
export function networkFromRequest(req: NextRequest): NetworkId {
  const fromQuery = req.nextUrl.searchParams.get(NETWORK_PARAM);
  if (fromQuery) return coerceNetwork(fromQuery);
  return coerceNetwork(req.cookies.get(NETWORK_COOKIE)?.value);
}

/**
 * Whether the network came from the URL rather than the cookie.
 *
 * This matters for routes that set a SHARED cache header (`s-maxage`). A CDN
 * keys its cache on the URL, so two callers on different networks hitting the
 * same param-less path would share one cache entry — and one of them would be
 * served the other network's leaderboard or portfolio. Responses whose network
 * was inferred from a cookie must therefore not be shared-cached.
 *
 * `apiFetch` always sends the param, so the fast path stays cacheable; this
 * only downgrades direct/param-less callers.
 */
function networkIsExplicit(req: NextRequest): boolean {
  return Boolean(req.nextUrl.searchParams.get(NETWORK_PARAM));
}

/**
 * Cache-Control for a network-dependent response. Shared caching is only safe
 * when the network is part of the cache key, i.e. present in the URL.
 */
export function networkAwareCacheControl(req: NextRequest, sharedValue: string): string {
  return networkIsExplicit(req) ? sharedValue : "private, no-store";
}

/** The resolved network's full config (contracts, RPC, passphrase, explorer). */
export function networkConfigFromRequest(req: NextRequest): NetworkConfig {
  return getNetworkConfig(networkFromRequest(req));
}

/**
 * The matcher operator secret for a network.
 *
 * Each network has its own funded operator account — the mainnet operator's key
 * is meaningless on testnet and vice versa — so the secret is per-network.
 * `MATCHER_OPERATOR_SECRET` (unsuffixed) is the legacy single-network var and
 * belongs to the deployment's primary network, so existing deployments are
 * unaffected.
 *
 * Returns undefined rather than throwing so the caller can answer with its own
 * 500 shape; it deliberately never falls back to the other network's key, which
 * would sign a settlement with an account that cannot pay on the target chain.
 */
export function matcherOperatorSecret(network: NetworkId): string | undefined {
  const explicit =
    network === "mainnet"
      ? process.env.MATCHER_OPERATOR_SECRET_MAINNET
      : process.env.MATCHER_OPERATOR_SECRET_TESTNET;
  if (explicit) return explicit;
  if (network === PRIMARY_NETWORK) return process.env.MATCHER_OPERATOR_SECRET;
  return undefined;
}

export { PRIMARY_NETWORK };
export type { NetworkId, NetworkConfig };

/**
 * The network for a Server Component render, from the request cookie.
 *
 * Server Components have no access to a `NextRequest`, and a root layout cannot
 * see the query string — so the cookie is the only signal available here. That
 * is precisely why the client also resolves from the cookie alone: both sides
 * read the same value, so network-dependent markup (the navbar toggle, the
 * degraded-venue banner) renders identically on server and client and never
 * hydrate-mismatches.
 */
export async function networkFromCookies(): Promise<NetworkId> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return coerceNetwork(store.get(NETWORK_COOKIE)?.value);
}
