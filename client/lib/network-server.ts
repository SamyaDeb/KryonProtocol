/**
 * Per-request network resolution for API routes and server components.
 *
 * Module-scope constants cannot carry a per-request value on the server — the
 * Node process is shared across every caller — so server code must resolve the
 * network from the request itself and thread it through explicitly. That is why
 * `ACTIVE_NETWORK_ID` from `@/lib/network` is the *deployment's* network on the
 * server and must not be used to answer a request.
 *
 * Server-side only: this module reads the filesystem and `next/headers`.
 */

import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";

import {
  arcNetwork,
  coerceNetwork,
  NETWORK_COOKIE,
  NETWORK_PARAM,
  PRIMARY_NETWORK,
  type ArcNetwork,
  type ArcNetworkId,
} from "@/lib/network";
import { contractsFromDeploymentJson, type ProtocolContracts } from "@/lib/chain/networks";
import { serverContracts } from "@/lib/chain/contracts-env";

/**
 * Resolve the caller's network.
 *
 * Precedence matches the client: explicit `?network=` (what `apiFetch` sends on
 * every call) → the `kryon_network` cookie → the deployment default. An
 * unrecognised value falls back rather than erroring, so a stale bookmark
 * degrades to the default venue instead of a 500 — and a network this
 * deployment does not offer is unrecognised, because `coerceNetwork` applies
 * the allowlist.
 */
export function networkFromRequest(req: NextRequest): ArcNetworkId {
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

/** The resolved network's registry entry (chain id, RPC, explorer, USDC). */
export function arcNetworkFromRequest(req: NextRequest): ArcNetwork {
  return arcNetwork(networkFromRequest(req));
}

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
export async function networkFromCookies(): Promise<ArcNetworkId> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return coerceNetwork(store.get(NETWORK_COOKIE)?.value);
}

// ─── Contracts ───────────────────────────────────────────────────────────────

/**
 * Deployment records are per network, because the addresses are. A deployment
 * serving two venues points each at its own record; `KRYON_DEPLOYMENT_FILE`
 * (unsuffixed) belongs to the primary network, mirroring `DATABASE_URL`.
 *
 * There is no baked default and no cross-network fallback: answering a testnet
 * request with mainnet addresses would have the UI quote real vault state
 * against a venue the caller is not trading on, and would have any signed
 * payload carry the wrong `verifyingContract`.
 */
function deploymentFileFor(network: ArcNetworkId): string | undefined {
  const explicit =
    network === "arc-mainnet"
      ? process.env.KRYON_DEPLOYMENT_FILE_ARC_MAINNET
      : network === "arc-testnet"
        ? process.env.KRYON_DEPLOYMENT_FILE_ARC_TESTNET
        : process.env.KRYON_DEPLOYMENT_FILE_ARC_LOCAL;
  if (explicit) return explicit;
  return network === PRIMARY_NETWORK ? process.env.KRYON_DEPLOYMENT_FILE : undefined;
}

const contractCache = new Map<ArcNetworkId, ProtocolContracts>();

/**
 * Protocol contract addresses for a network.
 *
 * Cached per network: reading and parsing a deployment record on every request
 * is wasted work, and the file cannot change under a running process without a
 * redeploy. `contractsFromDeploymentJson` asserts the record's chain id matches,
 * so a record for the wrong chain fails here rather than at signing time.
 */
export function contractsForNetwork(network: ArcNetworkId): ProtocolContracts {
  const cached = contractCache.get(network);
  if (cached) return cached;

  const chain = arcNetwork(network);
  const file = deploymentFileFor(network);
  const contracts = file
    ? contractsFromDeploymentJson(readFileSync(file, "utf8"), chain.chainId)
    : // No per-network record: fall back to the CONTRACT_* variables, which are
      // single-network by construction and therefore only valid for the network
      // this process was configured for.
      serverContracts(chain);

  contractCache.set(network, contracts);
  return contracts;
}

export function contractsFromRequest(req: NextRequest): ProtocolContracts {
  return contractsForNetwork(networkFromRequest(req));
}

export { PRIMARY_NETWORK };
export type { ArcNetworkId, ArcNetwork, ProtocolContracts };
