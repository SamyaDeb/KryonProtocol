import { NextRequest, NextResponse } from "next/server";
import { db, withRetry } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { getNetworkConfig } from "@/config/networks";
import { validateOrderIntent } from "@/lib/validation";
import { bodyTooLarge, rateLimit, requestKey } from "@/lib/rate-limit";

// Persist incoming order intent from the frontend to the DB.
// The off-chain matcher will pick these up and settle fills on-chain.
export async function POST(req: NextRequest) {
  if (bodyTooLarge(req)) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  // Rate-limit FIRST, before signature verification — otherwise an attacker
  // gets free ed25519-verify CPU on every junk request. The owner field is
  // taken as-is for the limiter key; validateOrderIntent re-checks it fully.
  const claimedOwner = typeof (body as Record<string, unknown>)?.owner === "string"
    ? ((body as Record<string, unknown>).owner as string).slice(0, 64)
    : "invalid";
  if (!(await rateLimit(requestKey(req, claimedOwner), 30))) {
    return NextResponse.json({ ok: false, error: "Too many order requests" }, { status: 429 });
  }

  // Validate before touching the DB — keeps malformed/abusive intents out of
  // the orderbook and the matcher.
  const network = networkFromRequest(req);
  const result = validateOrderIntent(body, getNetworkConfig(network).passphrase);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  const o = result.order;
  const sig = typeof (body as Record<string, unknown>).signature === "string"
    ? (body as Record<string, unknown>).signature as string
    : null;

  try {
    const sql = db(network);

    await withRetry(async () => {
      // Auto-create Account row if this is a new trader (FK required)
      await sql`
        INSERT INTO "Account" (address, collateral, "cancelledNonces", "filledByNonce", "createdAt", "updatedAt")
        VALUES (${o.owner}, '{}', ARRAY[]::BIGINT[], '{}', NOW(), NOW())
        ON CONFLICT (address) DO NOTHING
      `;

      // Upsert — safe to resubmit same nonce
      await sql`
        INSERT INTO "Order" (
          id, owner, "marketId", "isLong", size, "limitPrice",
          "reduceOnly", nonce, "expiryTs", cancelled, "filledSize",
          signature, "createdAt", "updatedAt"
        ) VALUES (
          ${o.owner + ":" + o.nonce.toString()},
          ${o.owner},
          ${o.marketId},
          ${o.isLong},
          ${o.size.toString()},
          ${o.limitPrice.toString()},
          ${o.reduceOnly},
          ${o.nonce},
          ${o.expiryTs},
          false,
          '0',
          ${sig},
          NOW(),
          NOW()
        )
        ON CONFLICT (id) DO NOTHING
      `;
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    // Log server-side; never leak internal errors to the client.
    console.error("order intake error:", e);
    return NextResponse.json({ ok: false, error: "Failed to persist order" }, { status: 500 });
  }
}
