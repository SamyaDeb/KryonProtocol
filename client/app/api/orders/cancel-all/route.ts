import { NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { arcNetwork } from "@/lib/network";
import { contractsForNetwork, networkFromRequest } from "@/lib/network-server";
import { cancelAllOrders } from "@/lib/queries/orders";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import {
  claimedOwner,
  erc1271CheckerFor,
  MAX_CANCEL_ALL_WINDOW_SECONDS,
  readBoundedJson,
  reject,
  rejectionBody,
  validateCancelAll,
  type Rejection,
} from "@/lib/validation";

const fail = (r: Rejection) => NextResponse.json(rejectionBody(r), { status: r.status });

/**
 * POST /api/orders/cancel-all — best-effort off-chain cancel of every working
 * order, optionally in one market. The kill switch for a misbehaving bot.
 *
 * ```json
 * { "owner": "0x…", "marketId": 0, "deadline": "1790000000", "signature": "0x…" }
 * ```
 *
 * The signature is over the API-only EIP-712 type
 * `CancelAll(address owner, uint32 marketId, uint64 deadline)` in the Kryon
 * domain (`lib/validation.ts`); `marketId` 0 means every market. The gateway
 * has no such type, so the signature cannot be replayed on chain; the
 * deadline may be at most MAX_CANCEL_ALL_WINDOW_SECONDS ahead, because until
 * then a replay here would also cancel orders placed after it.
 *
 * BEST-EFFORT, like /api/orders/cancel. The authoritative bulk cancel is the
 * wallet calling `cancelUpTo(nonce)` on the gateway, which the indexer
 * projects into `Account.minValidNonce`.
 */
export async function POST(req: NextRequest) {
  const read = await readBoundedJson(req);
  if (!read.ok) return fail(read);
  if (!(await rateLimit(requestKey(req, `cancel-all:${claimedOwner(read.body)}`), 30))) {
    return fail(reject("rate_limited", "Too many cancel-all requests"));
  }

  const network = networkFromRequest(req);
  try {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const result = await validateCancelAll(read.body, {
      network,
      chainId: arcNetwork(network).chainId,
      gateway: contractsForNetwork(network).orderGateway,
      nowSec,
      erc1271: erc1271CheckerFor(network),
    });
    if (!result.ok) return fail(result);

    const { owner, marketId } = result.cancelAll;
    const cancelled = await cancelAllOrders(db(network), network, owner, marketId === 0 ? null : marketId, nowSec);
    return NextResponse.json({
      ok: true,
      cancelled: cancelled.length,
      nonces: cancelled.map((c) => c.nonce.toString()),
      orderHashes: cancelled.map((c) => c.orderHash),
      onChainFinal: false,
      note:
        "Off-chain cancel: the matcher will not match these orders. They remain valid on chain until " +
        "cancelUpTo (or per-order cancels) is mined, and already-matched fills may still settle.",
      maxDeadlineWindowSeconds: Number(MAX_CANCEL_ALL_WINDOW_SECONDS),
    });
  } catch (e) {
    console.error("cancel-all error:", e);
    return NextResponse.json({ ok: false, code: "internal", error: "Failed to cancel orders" }, { status: 500 });
  }
}
