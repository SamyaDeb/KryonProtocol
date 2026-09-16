import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { db } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { rateLimit, requestKey } from "@/lib/rate-limit";

// GET /api/settlements?address=G...
// Returns pending settle_fill jobs where the caller is maker or taker
// and has not yet signed their auth entry.
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address || !StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json([], { status: 400 });
  }
  if (!(await rateLimit(requestKey(req, address), 120))) {
    return NextResponse.json([], { status: 429 });
  }

  try {
    const sql = db(networkFromRequest(req));
    const rows = await sql`
      SELECT id, "payloadHash", "unsignedXdr", "createdAt"
      FROM "TxJob"
      WHERE kind = 'settle_fill'
        AND status = 'QUEUED'
        AND "unsignedXdr" IS NOT NULL
      ORDER BY "createdAt" DESC
      LIMIT 20
    `;

    const pending = [];
    for (const row of rows) {
      try {
        const data = JSON.parse(row.unsignedXdr as string);
        if (data.makerAddress !== address && data.takerAddress !== address) continue;

        const isMaker = data.makerAddress === address;
        const myEntrySigned = isMaker ? !!data.makerSignedEntry : !!data.takerSignedEntry;
        const bothSigned = !!data.makerSignedEntry && !!data.takerSignedEntry;

        // If only my entry is signed (waiting for other party), skip — nothing to do.
        // If BOTH entries are signed but still QUEUED, the previous submission must have
        // failed (stale sequence). Expose it for retry — the submit path will re-run.
        if (myEntrySigned && !bothSigned) continue;

        pending.push({
          id:          String(row.id),
          fillHash:    row.payloadHash,
          isMaker,
          makerAddress: data.makerAddress,
          takerAddress: data.takerAddress,
          // For retry (both signed but submission failed): reuse the stored signed entry.
          // For first sign: provide the unsigned auth entry XDR.
          authEntryXdr: bothSigned
            ? (isMaker ? data.makerSignedEntry! : data.takerSignedEntry!)
            : (isMaker ? data.makerAuthXdr : data.takerAuthXdr),
          retryNeeded: bothSigned,
          fillPrice:   data.fillPrice,
          fillSize:    data.fillSize,
          marketId:    data.marketId,
          createdAt:   row.createdAt,
        });
      } catch { /* malformed row — skip */ }
    }

    return NextResponse.json(pending, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json([], { status: 500 });
  }
}
