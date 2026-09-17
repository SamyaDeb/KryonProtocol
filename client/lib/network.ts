/**
 * The selected Arc network — the one module both the browser and the server
 * resolve it through.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@/config` used to answer this question, and it answered it for the previous,
 * non-EVM deployment: Soroban RPC URLs, network passphrases, 7-decimal amounts.
 * That module now lives at `@/lib/stellar/legacy-config` and only the legacy
 * chain code reads it. Everything on the Arc path resolves networks here.
 *
 * The network ids are the ones the DATABASE accepts. Every Arc table carries
 * `CHECK ("network" IN ('arc-mainnet', 'arc-testnet', 'arc-local'))`, so a
 * value that does not round-trip through `isArcNetworkId` is not a cosmetic
 * mistake — it is a write Postgres rejects outright.
 *
 * ── The env-inlining trap (do not "clean this up") ───────────────────────────
 * Every `process.env.NEXT_PUBLIC_X` read MUST be written as a literal member
 * expression. Next.js inlines these into the client bundle by *static textual
 * substitution*; a computed key (`process.env[key]`) is not substituted and
 * silently becomes `undefined` in the browser. This cost a day on 2026-07-08 on
 * the previous stack, when the compiled chunk still held a stale address after
 * every env var had been independently verified correct — the culprit was a
 * helper doing exactly that.
 *
 * Dependency-free on purpose: no React, no `next/headers`, no `next/server`.
 * The keeper scripts under `scripts/` import it, and so do client components.
 * Request-scoped resolution lives in `@/lib/network-server`.
 */

import {
  ARC_NETWORK_IDS,
  arcNetwork,
  isArcNetworkId,
  type ArcNetwork,
  type ArcNetworkId,
} from "@/lib/chain/networks";

export { ARC_NETWORK_IDS, arcNetwork, isArcNetworkId };
export type { ArcNetwork, ArcNetworkId };

export const NETWORK_COOKIE = "kryon_network";
export const NETWORK_PARAM = "network";

/** One year. The choice is a durable user preference, not a session detail. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * The deployment's primary network — what an unlabelled request resolves to.
 *
 * `NEXT_PUBLIC_KRYON_NETWORK` is the browser-visible twin of `KRYON_NETWORK`
 * (which `serverNetworkId()` reads for keeper processes). They are separate
 * variables because only the `NEXT_PUBLIC_` one is inlined into the bundle, and
 * a deployment that sets one without the other should fail visibly rather than
 * serve a UI pointed at a different venue than its own API.
 */
export const PRIMARY_NETWORK: ArcNetworkId = isArcNetworkId(process.env.NEXT_PUBLIC_KRYON_NETWORK)
  ? process.env.NEXT_PUBLIC_KRYON_NETWORK
  : "arc-testnet";

/**
 * The networks THIS deployment offers, primary first.
 *
 * A production deployment sets `NEXT_PUBLIC_KRYON_NETWORKS=arc-mainnet` so the
 * navbar toggle disappears and no `?network=arc-local` on a shared link can
 * point a real user's browser at a throwaway anvil database. Unset means "the
 * primary network only", which is the safe reading: offering a second venue is
 * an explicit operator decision, not a default.
 *
 * Unknown entries are dropped rather than thrown on. This value is evaluated at
 * module scope in the browser bundle, so a typo in one env var would otherwise
 * white-screen the whole app instead of degrading to the primary network.
 */
export const AVAILABLE_NETWORKS: readonly ArcNetworkId[] = parseAvailable(
  process.env.NEXT_PUBLIC_KRYON_NETWORKS
);

function parseAvailable(raw: string | undefined): readonly ArcNetworkId[] {
  const parsed = (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(isArcNetworkId);
  const unique = Array.from(new Set(parsed));
  if (unique.length === 0) return [PRIMARY_NETWORK];
  // Primary first so the toggle's default and `AVAILABLE_NETWORKS[0]` agree.
  return unique.includes(PRIMARY_NETWORK)
    ? [PRIMARY_NETWORK, ...unique.filter((id) => id !== PRIMARY_NETWORK)]
    : unique;
}

/** Whether this deployment serves `id` at all. */
export function isAvailableNetwork(value: unknown): value is ArcNetworkId {
  return isArcNetworkId(value) && AVAILABLE_NETWORKS.includes(value);
}

/**
 * Coerce anything into a network this deployment actually offers.
 *
 * Falls back rather than throwing: a stale bookmark or a link shared from a
 * testnet deployment should degrade to the default venue, not 500. The
 * allowlist is applied here and not only at the edges, so there is exactly one
 * place a network id can enter the system.
 */
export function coerceNetwork(
  value: unknown,
  fallback: ArcNetworkId = AVAILABLE_NETWORKS[0]
): ArcNetworkId {
  return isAvailableNetwork(value) ? value : fallback;
}

// ─── Browser-side selection ──────────────────────────────────────────────────

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
 * Resolve the active network *in the browser*.
 *
 * The COOKIE is the single source of truth here — deliberately, and not the
 * URL. The server renders from the same cookie (`networkFromCookies`), so the
 * two always agree and no network-dependent markup can hydrate-mismatch.
 * Preferring a `?network=` param here would reintroduce exactly that mismatch
 * for anyone arriving on a shared deep link, because a root layout cannot read
 * the query string.
 *
 * Deep links still work: `pendingUrlNetwork()` detects the disagreement and the
 * NetworkProvider reconciles it by writing the cookie and reloading once.
 */
export function resolveClientNetwork(): ArcNetworkId {
  if (typeof window === "undefined") return AVAILABLE_NETWORKS[0];
  return coerceNetwork(readCookie(NETWORK_COOKIE));
}

/**
 * A `?network=` in the URL that disagrees with the cookie, or undefined.
 * Lets a shared link like `/trade/BTC-PERP?network=arc-testnet` land on the
 * right venue for a visitor whose cookie says otherwise.
 */
export function pendingUrlNetwork(): ArcNetworkId | undefined {
  if (typeof window === "undefined") return undefined;
  const fromUrl = new URLSearchParams(window.location.search).get(NETWORK_PARAM);
  if (!isAvailableNetwork(fromUrl)) return undefined;
  return fromUrl === resolveClientNetwork() ? undefined : fromUrl;
}

/** Persist the choice so the next request — and the next visit — agrees. */
export function writeNetworkCookie(network: ArcNetworkId): void {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${NETWORK_COOKIE}=${network}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

/** The network the flat, browser-side values on this page are bound to. */
export const ACTIVE_NETWORK_ID: ArcNetworkId =
  typeof window === "undefined" ? PRIMARY_NETWORK : resolveClientNetwork();

// ─── Display ─────────────────────────────────────────────────────────────────

/** Human label for chrome: "Arc Testnet". */
export function networkLabel(id: ArcNetworkId): string {
  return arcNetwork(id).label;
}

/** Short label for the navbar toggle: "Testnet", "Local". */
export function networkShortLabel(id: ArcNetworkId): string {
  return id === "arc-mainnet" ? "Mainnet" : id === "arc-testnet" ? "Testnet" : "Local";
}

/** Block-explorer base URL for a network. */
export function explorerUrl(id: ArcNetworkId): string {
  return arcNetwork(id).explorerUrl;
}

/** Explorer link for a transaction hash. */
export function explorerTxUrl(id: ArcNetworkId, hash: string): string {
  return `${explorerUrl(id)}/tx/${hash}`;
}

/** Explorer link for an address. */
export function explorerAddressUrl(id: ArcNetworkId, address: string): string {
  return `${explorerUrl(id)}/address/${address}`;
}

// ─── Off-chain service endpoints ─────────────────────────────────────────────
// The matcher and indexer are reached through this app's own /api routes, so
// they need no per-network URL — the route resolves the caller's network and
// picks the matching database.
//
// The WebSocket server is a separate process per network (one ws-server can
// only tail one database), so it DOES need a per-network address. Each is
// optional: unset means the UI falls back to REST polling for that venue.

const WS_URL_BY_NETWORK: Record<ArcNetworkId, string> = {
  "arc-mainnet": process.env.NEXT_PUBLIC_WS_URL_ARC_MAINNET ?? "",
  "arc-testnet": process.env.NEXT_PUBLIC_WS_URL_ARC_TESTNET ?? "",
  "arc-local": process.env.NEXT_PUBLIC_WS_URL_ARC_LOCAL ?? "",
};

export function getWsUrl(network: ArcNetworkId): string {
  return WS_URL_BY_NETWORK[network] ?? "";
}

/**
 * Whether the selected venue has keepers behind it (drives the degraded-venue
 * banner). Unset means "only the primary network is live", which is the safe
 * reading: an empty order book presented as real market state is worse than a
 * banner saying the venue is not running.
 */
export function keepersExpected(network: ArcNetworkId): boolean {
  const raw =
    network === "arc-mainnet"
      ? process.env.NEXT_PUBLIC_ARC_MAINNET_KEEPERS_LIVE
      : network === "arc-testnet"
        ? process.env.NEXT_PUBLIC_ARC_TESTNET_KEEPERS_LIVE
        : process.env.NEXT_PUBLIC_ARC_LOCAL_KEEPERS_LIVE;
  if (raw === undefined || raw === "") return network === PRIMARY_NETWORK;
  return raw === "true" || raw === "1";
}
