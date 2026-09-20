/**
 * Jurisdiction blocking, decided per request in `proxy.ts`.
 *
 * The blocked list is `KRYON_BLOCKED_COUNTRIES`: ISO 3166-1 alpha-2 codes,
 * comma separated, server-side only. Unset or empty blocks nothing: which
 * jurisdictions to block is counsel's decision, not a code default.
 *
 * The country comes from the CDN in front of the app (Cloudflare's
 * `cf-ipcountry`, or Vercel's `x-vercel-ip-country`). Without either header
 * the request is not blocked; a deployment that must geoblock has to sit
 * behind a CDN that sets one. That header is only trustworthy when the origin
 * accepts traffic from the CDN alone.
 *
 * Pages and APIs differ: a blocked page request is rewritten to /restricted,
 * and a blocked API request gets 451 with a JSON reason. The legal pages, the
 * restricted page itself and health checks stay reachable from everywhere.
 */

const COUNTRY_HEADERS = ["cf-ipcountry", "x-vercel-ip-country"] as const;

/** Paths that must answer from anywhere. */
const ALWAYS_ALLOWED = [/^\/restricted(\/|$)/, /^\/terms(\/|$)/, /^\/privacy(\/|$)/, /^\/risk(\/|$)/, /^\/api\/(health|ready|time)(\/|$)/];

export function parseBlockedCountries(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter((c) => /^[A-Z]{2}$/.test(c))
  );
}

/** The request's country per the CDN, or null. "XX"/"T1" (unknown, Tor) count as unknown. */
export function requestCountry(headers: Pick<Headers, "get">): string | null {
  for (const h of COUNTRY_HEADERS) {
    const v = headers.get(h)?.trim().toUpperCase();
    if (v && /^[A-Z][A-Z0-9]$/.test(v) && v !== "XX") return v;
  }
  return null;
}

export type GeoDecision = { action: "allow" } | { action: "rewrite"; to: "/restricted" } | { action: "reject"; status: 451 };

export function geoDecision(path: string, country: string | null, blocked: Set<string>): GeoDecision {
  if (blocked.size === 0 || country === null || !blocked.has(country)) return { action: "allow" };
  if (ALWAYS_ALLOWED.some((re) => re.test(path))) return { action: "allow" };
  return path.startsWith("/api/") ? { action: "reject", status: 451 } : { action: "rewrite", to: "/restricted" };
}
