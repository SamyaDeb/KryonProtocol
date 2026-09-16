import { NextResponse } from "next/server";

/**
 * GET /api/time — the venue's clock.
 *
 * Order intake rejects any `expiry_ts` at or before `now + 5s`, where `now` is
 * the SERVER's clock. A bot on a host whose clock drifts a few seconds fast
 * has its orders rejected as "expiry_ts is too soon" with no indication that
 * time is the problem — a genuinely difficult failure to diagnose from the
 * outside, and a common one on VMs that have been suspended.
 *
 * Reading this at startup lets a client measure its own offset and add it to
 * every expiry, rather than guessing at a padding value.
 */
export async function GET() {
  const now = Date.now();
  return NextResponse.json(
    {
      unix_ms: now,
      unix_seconds: Math.floor(now / 1000),
      iso: new Date(now).toISOString(),
      // The intake bounds, so a client can derive a valid expiry without
      // hardcoding constants that may change.
      min_ttl_seconds: 5,
      max_ttl_seconds: 7 * 24 * 3600,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
