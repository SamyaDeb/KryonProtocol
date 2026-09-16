"use client";

/**
 * `fetch` for this app's own /api routes, with the selected network attached.
 *
 * Every API route resolves the caller's venue and queries the matching
 * database. The cookie alone would *usually* be enough, but an explicit query
 * parameter is what makes the choice survive the two cases that matter:
 *
 *  - CDN/proxy caching, which keys on the URL and would otherwise be free to
 *    serve one network's order book to the other's callers;
 *  - the reload window during a network switch, where an in-flight request
 *    started before the cookie was rewritten would answer for the old venue.
 *
 * Use this for every relative /api call. Absolute URLs to third parties
 * (Binance tickers and the like) should keep using plain `fetch` — they have no
 * notion of our networks.
 */

import { ACTIVE_NETWORK_ID } from "@/config";
import { NETWORK_PARAM } from "@/lib/network-resolve";
import type { NetworkId } from "@/config/networks";

function withNetwork(path: string, network: NetworkId = ACTIVE_NETWORK_ID): string {
  // Relative paths only; `URL` needs a base, and callers pass "/api/...".
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set(NETWORK_PARAM, network);
  return `${pathname}?${params.toString()}`;
}

export function apiFetch(
  path: string,
  init?: RequestInit,
  network: NetworkId = ACTIVE_NETWORK_ID
): Promise<Response> {
  return fetch(withNetwork(path, network), init);
}
