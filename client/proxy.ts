import { NextResponse, type NextRequest } from "next/server";

import { geoDecision, parseBlockedCountries, requestCountry } from "@/lib/geoblock";

const BLOCKED = parseBlockedCountries(process.env.KRYON_BLOCKED_COUNTRIES);

/** Jurisdiction blocking (lib/geoblock.ts). Everything else passes through untouched. */
export function proxy(request: NextRequest) {
  const decision = geoDecision(request.nextUrl.pathname, requestCountry(request.headers), BLOCKED);
  if (decision.action === "rewrite") return NextResponse.rewrite(new URL(decision.to, request.url));
  if (decision.action === "reject") {
    return NextResponse.json(
      { ok: false, code: "restricted_jurisdiction", error: "Kryon is not available in your jurisdiction." },
      { status: decision.status }
    );
  }
  return NextResponse.next();
}

export const config = {
  // Skip Next's own assets and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon\\.|logo|docs/).*)"],
};
