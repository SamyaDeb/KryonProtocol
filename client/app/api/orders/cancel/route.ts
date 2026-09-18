import { NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { arcNetwork } from "@/lib/network";
import { contractsForNetwork, networkFromRequest } from "@/lib/network-server";
import { cancelOrderByNonce } from "@/lib/queries/orders";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import {
  claimedOwner,
  erc1271CheckerFor,
  readBoundedJson,
  reject,
  rejectionBody,
  validateCancel,
  type Rejection,
} from "@/lib/validation";

const fail = (r: Rejection) => NextResponse.json(rejectionBody(r), { status: r.status });

/**
 * POST /api/orders/cancel — best-effort off-chain cancel of one order.
 *
 * ```json
 * { "owner": "0x…", "nonce": "42", "deadline": "1790000000", "signature": "0x…" }
 * ```
 *
 * The signature is over the gateway's own EIP-712 `Cancel(owner, nonce,
 * deadline)`, verified exactly as the gateway's `cancelSigned` would.
 *
 * BEST-EFFORT: this stops the matcher picking the order up. It does not cancel
 * it on chain — the signed order stays valid there until `cancelOrder(nonce)`,
 * `cancelUpTo(n)` or `cancelSigned(cancel, signature)` is mined, and a fill the
 * matcher already committed (PENDING) may still settle. The same `Cancel`
 * signature can be submitted to `cancelSigned` by anyone to make it final.
 */
export async function POST(req: NextRequest) {
  const read = await readBoundedJson(req);
  if (!read.ok) return fail(read);
  if (!(await rateLimit(requestKey(req, `cancel:${claimedOwner(read.body)}`), 60))) {
    return fail(reject("rate_limited", "Too many cancel requests"));
  }

  const network = networkFromRequest(req);
  try {
    const result = await validateCancel(read.body, {
      network,
      chainId: arcNetwork(network).chainId,
      gateway: contractsForNetwork(network).orderGateway,
      nowSec: BigInt(Math.floor(Date.now() / 1000)),
      erc1271: erc1271CheckerFor(network),
    });
    if (!result.ok) return fail(result);

    const cancelled = await cancelOrderByNonce(db(network), network, result.cancel.owner, result.cancel.nonce);
    return NextResponse.json({
      ok: true,
      cancelled: cancelled.length,
      orderHashes: cancelled.map((c) => c.orderHash),
      onChainFinal: false,
      note:
        "Off-chain cancel: the matcher will not match this order. It remains valid on chain until " +
        "cancelOrder/cancelUpTo/cancelSigned is mined, and an already-matched fill may still settle.",
    });
  } catch (e) {
    console.error("order cancel error:", e);
    return NextResponse.json({ ok: false, code: "internal", error: "Failed to cancel order" }, { status: 500 });
  }
}
