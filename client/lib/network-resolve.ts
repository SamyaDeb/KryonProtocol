/**
 * Where the "currently selected network" comes from.
 *
 * Kept dependency-free (no React, no next/headers, no @/config) because it is
 * imported by `config/index.ts`, which is in turn imported by the standalone
 * keeper scripts under `scripts/`.
 *
 * ── Why a cookie, not localStorage ───────────────────────────────────────────
 * The selection has to be visible to the *server* as well as the browser: the
 * root layout renders the network label, and the API routes must query the
 * matching database. A cookie is sent with every request, so server and client
 * agree on the first paint. localStorage would be browser-only and would
 * hydrate-mismatch every network-labelled element on load.
 */

import { PRIMARY_NETWORK, isNetworkId, type NetworkId } from "@/config/networks";

export const NETWORK_COOKIE = "kryon_network";
export const NETWORK_PARAM = "network";

/** One year. The choice is a durable user preference, not a session detail. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Coerce anything into a valid network, falling back to the deployment default. */
export function coerceNetwork(value: unknown, fallback: NetworkId = PRIMARY_NETWORK): NetworkId {
  return isNetworkId(value) ? value : fallback;
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  // Cookie values here are a fixed enum, so a simple scan is sufficient.
  for (const part of document.cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/**
 * Resolve the active network *in the browser*, at module-evaluation time.
 *
 * The COOKIE is the single source of truth here — deliberately, and not the URL.
 * The server renders from the same cookie (see `networkFromCookies`), so the two
 * always agree and no network-dependent markup can hydrate-mismatch. Preferring
 * a `?network=` param here would reintroduce exactly that mismatch for anyone
 * arriving on a shared deep link, because a root layout cannot read the query
 * string.
 *
 * Deep links still work: `pendingUrlNetwork()` detects the disagreement and the
 * NetworkProvider reconciles it by writing the cookie and reloading once.
 */
export function resolveClientNetwork(): NetworkId {
  if (typeof window === "undefined") return PRIMARY_NETWORK;
  return coerceNetwork(readCookie(NETWORK_COOKIE));
}

/**
 * A `?network=` in the URL that disagrees with the cookie, or undefined.
 * Lets a shared link like `/trade/BTC-PERP?network=testnet` land on the right
 * venue for a visitor whose cookie says otherwise.
 */
export function pendingUrlNetwork(): NetworkId | undefined {
  if (typeof window === "undefined") return undefined;
  const fromUrl = new URLSearchParams(window.location.search).get(NETWORK_PARAM);
  if (!isNetworkId(fromUrl)) return undefined;
  return fromUrl === resolveClientNetwork() ? undefined : fromUrl;
}

/** Persist the choice so the next request — and the next visit — agrees. */
export function writeNetworkCookie(network: NetworkId): void {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${NETWORK_COOKIE}=${network}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}
