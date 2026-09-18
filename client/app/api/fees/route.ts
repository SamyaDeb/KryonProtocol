import { NextRequest, NextResponse } from "next/server";

import { createArcPublicClient } from "@/lib/chain/clients";
import { db } from "@/lib/db";
import { feesToJson, resolveFees, viemFeeChain, type FeeChain } from "@/lib/fees";
import { arcNetwork, type ArcNetworkId } from "@/lib/network";
import { contractsForNetwork, networkAwareCacheControl, networkFromRequest } from "@/lib/network-server";
import type { Queryable } from "@/lib/queries/client";
import { parseAddress } from "@/lib/queries/scalars";
import { rateLimit, requestKey } from "@/lib/rate-limit";

const chains = new Map<ArcNetworkId, FeeChain>();

function feeChain(network: ArcNetworkId): FeeChain {
  let c = chains.get(network);
  if (!c) {
    const contracts = contractsForNetwork(network);
    c = viemFeeChain(createArcPublicClient(arcNetwork(network)), contracts.feeRouter, contracts.riskParams);
    chains.set(network, c);
  }
  return c;
}

function database(network: ArcNetworkId): Queryable | null {
  try {
    return db(network);
  } catch {
    // No database configured for this network: the chain answers alone.
    return null;
  }
}

/**
 * GET /api/fees[?address=0x…] — the fee schedule per market, and with an
 * address, that account's tier and effective rates. The UI shows this before
 * the user signs. See `lib/fees.ts` for the resolution and its sources.
 *
 * Rates are integers in millionths of notional (`rate_denominator`). A
 * negative `maker_rate` is a rebate. An account's `maker_rate` is a lower
 * bound: when a fill's maker + taker rate would net below `net_rate_floor`, the
 * FeeRouter raises the maker side to meet it.
 *
 * 503 when the FeeRouter cannot be read: without `rebates_enabled` and the
 * floor the fee cannot be stated, and a UI must not guess it.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("address");
  const address = raw === null ? null : parseAddress(raw);
  if (raw !== null && !address) return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  if (!(await rateLimit(requestKey(req, address ?? "fees"), 120))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const network = networkFromRequest(req);
  try {
    const fees = await resolveFees({
      network,
      sql: database(network),
      chain: feeChain(network),
      address,
      onDbError: (e) => console.error("fees: database unavailable, reading the chain:", e),
    });
    return NextResponse.json(feesToJson(network, fees), {
      headers: {
        // Per-account answers are private; the bare schedule is shared-cacheable.
        "Cache-Control": address ? "private, no-store" : networkAwareCacheControl(req, "public, max-age=15, s-maxage=30"),
      },
    });
  } catch (e) {
    console.error("fees error:", e);
    return NextResponse.json({ error: "fees_unavailable" }, { status: 503 });
  }
}
