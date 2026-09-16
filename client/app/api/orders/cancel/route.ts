import { NextRequest, NextResponse } from "next/server";
import { db, withRetry } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { getNetworkConfig } from "@/config/networks";
import { StrKey } from "@stellar/stellar-sdk";
import { bodyTooLarge, rateLimit, requestKey } from "@/lib/rate-limit";
import { assertU64, cancelSigningMessage } from "@/lib/market/signing-message";
import { verifySignedMessage } from "@/lib/market/signed-intent";

export async function POST(req: NextRequest) {
  const network = networkFromRequest(req);

  if (bodyTooLarge(req)) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 413 });
  }

  let body: { owner?: unknown; nonce?: unknown; signature?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const owner = body.owner;
  if (typeof owner !== "string" || !StrKey.isValidEd25519PublicKey(owner)) {
    return NextResponse.json({ ok: false, error: "Invalid owner address" }, { status: 400 });
  }
  const nonceStr = String(body.nonce ?? "");
  if (!/^\d+$/.test(nonceStr)) {
    return NextResponse.json({ ok: false, error: "Invalid nonce" }, { status: 400 });
  }
  const nonce = BigInt(nonceStr);
  if (!assertU64(nonce)) {
    return NextResponse.json({ ok: false, error: "Invalid nonce" }, { status: 400 });
  }
  if (typeof body.signature !== "string" || body.signature.length > 256) {
    return NextResponse.json({ ok: false, error: "Missing cancel signature" }, { status: 400 });
  }
  // Rate-limit before signature verification so junk requests don't get free
  // ed25519-verify CPU.
  if (!(await rateLimit(requestKey(req, owner), 60))) {
    return NextResponse.json({ ok: false, error: "Too many cancel requests" }, { status: 429 });
  }
  if (!verifySignedMessage(owner, cancelSigningMessage(owner, nonce, getNetworkConfig(network).passphrase), body.signature)) {
    return NextResponse.json({ ok: false, error: "Invalid cancel signature" }, { status: 401 });
  }

  try {
    const sql = db(network);
    await withRetry(() =>
      sql`
        UPDATE "Order"
        SET cancelled = true, "updatedAt" = NOW()
        WHERE owner = ${owner} AND nonce = ${nonce}
      `
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("order cancel error:", e);
    return NextResponse.json({ ok: false, error: "Failed to cancel order" }, { status: 500 });
  }
}
