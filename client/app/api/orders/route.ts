import { NextRequest, NextResponse } from "next/server";
import { zeroAddress } from "viem";

import { db } from "@/lib/db";
import { arcNetwork } from "@/lib/network";
import { contractsForNetwork, networkFromRequest } from "@/lib/network-server";
import { insertOrder } from "@/lib/queries/orders";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import {
  claimedOwner,
  erc1271CheckerFor,
  readBoundedJson,
  reject,
  rejectionBody,
  validateOrderSubmission,
  type Rejection,
} from "@/lib/validation";

/** Orders per minute, per claimed owner and — separately — per client IP. */
const ORDER_RATE_LIMIT = 30;

const fail = (r: Rejection) => NextResponse.json(rejectionBody(r), { status: r.status });

/**
 * POST /api/orders — submit an EIP-712 signed order.
 *
 * ```json
 * { "owner": "0x…", "marketId": 2, "isLong": true,
 *   "size": "1500000000000000000", "limitPrice": "65000000000000000000000",
 *   "reduceOnly": false, "nonce": "42", "expiry": "1790000000",
 *   "referrer": "0x0000000000000000000000000000000000000000",
 *   "signature": "0x…", "chainId": 5042002 }
 * ```
 *
 * Fields are exactly the `Order` struct the wallet signed (domain `Kryon`/`1`,
 * verifyingContract = the OrderGateway proxy of the caller's network); uint256
 * values as decimal strings. `referrer` may be omitted; `chainId` is optional
 * and, when sent, turns a wrong-chain signature into a clear error.
 *
 * The API accepts only orders the gateway would accept (lib/validation.ts),
 * stores them by EIP-712 hash, and hands them to the matcher. Resubmitting the
 * identical signed order is an idempotent no-op (200, `duplicate: true`).
 *
 * 201 { ok, orderHash, status: "OPEN" } | 200 { ok, orderHash, duplicate }
 * 4xx/503 { ok: false, code, error, contractError }
 */
export async function POST(req: NextRequest) {
  const read = await readBoundedJson(req);
  if (!read.ok) return fail(read);

  // Rate-limit BEFORE any signature work: ECDSA recovery costs CPU, and an
  // ERC-1271 check costs an RPC call. Two buckets, so neither rotating owners
  // from one IP nor one owner from many IPs gets past the limit.
  const [byOwner, byIp] = await Promise.all([
    rateLimit(`order-owner:${claimedOwner(read.body)}`, ORDER_RATE_LIMIT),
    rateLimit(requestKey(req, "order-ip"), ORDER_RATE_LIMIT),
  ]);
  if (!byOwner || !byIp) return fail(reject("rate_limited", "Too many order requests"));

  const network = networkFromRequest(req);
  let gateway;
  try {
    gateway = contractsForNetwork(network).orderGateway;
  } catch (e) {
    console.error("order intake: contracts not configured:", e);
    return NextResponse.json({ ok: false, code: "unavailable", error: "Order intake is not configured" }, { status: 503 });
  }

  try {
    const sql = db(network);
    const result = await validateOrderSubmission(read.body, {
      network,
      chainId: arcNetwork(network).chainId,
      gateway,
      nowSec: BigInt(Math.floor(Date.now() / 1000)),
      erc1271: erc1271CheckerFor(network),
      q: sql,
    });
    if (!result.ok) return fail(result);

    const o = result.order;
    const outcome = await insertOrder(sql, network, {
      orderHash: result.orderHash,
      owner: o.owner.toLowerCase(),
      marketId: o.marketId,
      isLong: o.isLong,
      size: o.size,
      limitPrice: o.limitPrice,
      reduceOnly: o.reduceOnly,
      nonce: o.nonce,
      expiry: o.expiry,
      referrer: o.referrer === zeroAddress ? null : o.referrer.toLowerCase(),
      signature: result.signature,
    });
    if (outcome === "nonce_reused") {
      return fail(reject("nonce_reused", `nonce ${o.nonce} already carries a different order for this owner`));
    }
    return NextResponse.json(
      outcome === "inserted"
        ? { ok: true, orderHash: result.orderHash, status: "OPEN" }
        : { ok: true, orderHash: result.orderHash, duplicate: true },
      { status: outcome === "inserted" ? 201 : 200 }
    );
  } catch (e) {
    // Log server-side; never leak internals to the client.
    console.error("order intake error:", e);
    return NextResponse.json({ ok: false, code: "internal", error: "Failed to accept order" }, { status: 500 });
  }
}
