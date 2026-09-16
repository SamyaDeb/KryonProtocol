import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { db, withRetry } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { getNetworkConfig } from "@/config/networks";
import { bodyTooLarge, rateLimit, requestKey } from "@/lib/rate-limit";
import {
  CANCEL_ALL_WINDOW_SECONDS,
  cancelAllSigningMessage,
} from "@/lib/market/signing-message";
import { verifySignedMessage } from "@/lib/market/signed-intent";

/**
 * POST /api/orders/cancel-all
 *
 * Cancel every resting order for an account, optionally scoped to one market.
 *
 * ```json
 * { "owner": "G…", "market_id": 1, "issued_at": "1780061000", "signature": "…" }
 * ```
 *
 * `market_id` may be omitted or `"all"` to cancel across every market.
 *
 * This is the kill switch. A bot that detects it is misbehaving — a runaway
 * loop, a bad price feed, a risk limit breached — needs one call that takes it
 * flat, not N cancels that might be rate-limited halfway through leaving half
 * its book live. Without it, the only bulk exit was 60 cancels a minute.
 *
 * The signature covers `issued_at`, which must be within
 * CANCEL_ALL_WINDOW_SECONDS of the server clock. Without that bound a captured
 * cancel-all signature would work forever, since there is no nonce to consume.
 */
export async function POST(req: NextRequest) {
  if (bodyTooLarge(req)) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 413 });
  }

  let body: {
    owner?: unknown;
    market_id?: unknown;
    issued_at?: unknown;
    signature?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const owner = body.owner;
  if (typeof owner !== "string" || !StrKey.isValidEd25519PublicKey(owner)) {
    return NextResponse.json({ ok: false, error: "Invalid owner address" }, { status: 400 });
  }

  // Rate-limit before the ed25519 verify so junk cannot buy free CPU.
  if (!(await rateLimit(requestKey(req, owner), 30))) {
    return NextResponse.json(
      { ok: false, error: "Too many cancel-all requests" },
      { status: 429 }
    );
  }

  // Scope: a market id, or "all". Absent means all.
  const rawMarket = body.market_id;
  let marketId: number | "all";
  if (rawMarket === undefined || rawMarket === null || rawMarket === "all") {
    marketId = "all";
  } else {
    const parsed = Number(rawMarket);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return NextResponse.json({ ok: false, error: "Invalid market_id" }, { status: 400 });
    }
    marketId = parsed;
  }

  const issuedAtStr = String(body.issued_at ?? "");
  if (!/^\d+$/.test(issuedAtStr)) {
    return NextResponse.json({ ok: false, error: "Invalid issued_at" }, { status: 400 });
  }
  const issuedAt = Number(issuedAtStr);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - issuedAt) > CANCEL_ALL_WINDOW_SECONDS) {
    return NextResponse.json(
      {
        ok: false,
        error: `issued_at is outside the ${CANCEL_ALL_WINDOW_SECONDS}s window; check your clock against GET /api/time`,
      },
      { status: 400 }
    );
  }

  if (typeof body.signature !== "string" || body.signature.length > 256) {
    return NextResponse.json({ ok: false, error: "Missing cancel signature" }, { status: 400 });
  }

  const network = networkFromRequest(req);
  const message = cancelAllSigningMessage(
    owner,
    issuedAtStr,
    marketId,
    getNetworkConfig(network).passphrase
  );
  if (!verifySignedMessage(owner, message, body.signature)) {
    return NextResponse.json({ ok: false, error: "Invalid cancel signature" }, { status: 401 });
  }

  try {
    const sql = db(network);

    // Only touch live orders. Re-cancelling a filled or expired order would
    // inflate the reported count and tell the caller nothing useful.
    const rows = await withRetry(() =>
      marketId === "all"
        ? sql`
            UPDATE "Order"
            SET cancelled = true, "updatedAt" = NOW()
            WHERE owner = ${owner}
              AND cancelled = false
              AND "expiryTs" > ${nowSec}
              AND "filledSize"::numeric < size::numeric
            RETURNING nonce
          `
        : sql`
            UPDATE "Order"
            SET cancelled = true, "updatedAt" = NOW()
            WHERE owner = ${owner}
              AND "marketId" = ${marketId}
              AND cancelled = false
              AND "expiryTs" > ${nowSec}
              AND "filledSize"::numeric < size::numeric
            RETURNING nonce
          `
    );

    return NextResponse.json({
      ok: true,
      cancelled: rows.length,
      nonces: rows.map((r) => String(r.nonce)),
    });
  } catch (e) {
    console.error("cancel-all error:", e);
    return NextResponse.json(
      { ok: false, error: "Failed to cancel orders" },
      { status: 500 }
    );
  }
}
