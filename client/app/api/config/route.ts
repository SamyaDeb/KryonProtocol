import { NextRequest, NextResponse } from "next/server";

import { arcNetwork } from "@/lib/network";
import { contractsForNetwork, networkAwareCacheControl, networkFromRequest } from "@/lib/network-server";
import { buildPublicConfig } from "@/lib/public-config";

/**
 * GET /api/config — chain id, contract addresses and EIP-712 domains for the
 * caller's network. See `lib/public-config.ts` for why this is an endpoint.
 *
 * Public and cacheable: it changes only with a redeploy. The shared cache is
 * used only when `?network=` is in the URL, because a CDN keys on the URL and a
 * cookie-resolved answer would otherwise be served to the other network.
 *
 * 503 when the network has no deployment record: a UI with no domain cannot
 * sign, and saying so is better than handing it a guessed address.
 */
export async function GET(req: NextRequest) {
  const network = networkFromRequest(req);
  let contracts;
  try {
    contracts = contractsForNetwork(network);
  } catch (e) {
    console.error(`config: no deployment for ${network}:`, e);
    return NextResponse.json({ error: "config_unavailable", network }, { status: 503 });
  }
  return NextResponse.json(buildPublicConfig(arcNetwork(network), contracts), {
    headers: { "Cache-Control": networkAwareCacheControl(req, "public, max-age=60, s-maxage=300") },
  });
}
