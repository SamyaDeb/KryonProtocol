/**
 * LEGACY — per-request network resolution for the old chain's API routes.
 *
 * This is the part of the previous `lib/network-server.ts` that the not-yet-
 * migrated routes still need: the old `NetworkId` ("mainnet" / "testnet"), its
 * `NetworkConfig`, and the per-network matcher operator secret. It exists so
 * those routes keep compiling while the Arc seam is rebuilt around them, and it
 * is quarantined under `lib/stellar/` so `grep` finds every caller in one pass.
 *
 * Its only callers are listed in `lib/legacy-quarantine.test.ts`, and that list
 * is expected to shrink to nothing. `@/lib/network-server` is the Arc version.
 *
 * ── The cookie no longer reaches here ────────────────────────────────────────
 * `kryon_network` now holds an Arc network id (`arc-testnet`), which is not a
 * legacy `NetworkId`. `coerceNetwork` therefore rejects it and every request
 * resolves to the legacy primary network. That is deliberate: these routes talk
 * to the old chain, which the Arc toggle has no say over, and quietly mapping
 * `arc-mainnet` onto `mainnet` would let a venue switch reach contracts on a
 * completely different chain.
 */

import type { NextRequest } from "next/server";
import {
  getNetworkConfig,
  isNetworkId,
  PRIMARY_NETWORK,
  type NetworkConfig,
  type NetworkId,
} from "@/lib/stellar/legacy-config";

/** Coerce anything into a legacy network, falling back to the primary one. */
export function coerceLegacyNetwork(value: unknown): NetworkId {
  return isNetworkId(value) ? value : PRIMARY_NETWORK;
}

/**
 * The legacy network for a request. Honours an explicit `?network=mainnet`,
 * which is the only signal that still names an old-chain venue; anything else
 * (including every Arc id) falls back to the primary network.
 */
export function legacyNetworkFromRequest(req: NextRequest): NetworkId {
  return coerceLegacyNetwork(req.nextUrl.searchParams.get("network"));
}

/** The resolved network's full config (contracts, RPC, passphrase, explorer). */
export function legacyNetworkConfigFromRequest(req: NextRequest): NetworkConfig {
  return getNetworkConfig(legacyNetworkFromRequest(req));
}

/**
 * The matcher operator secret for a legacy network.
 *
 * Each network has its own funded operator account — the mainnet operator's key
 * is meaningless on testnet and vice versa — so the secret is per-network.
 * `MATCHER_OPERATOR_SECRET` (unsuffixed) is the legacy single-network var and
 * belongs to the deployment's primary network.
 *
 * Returns undefined rather than throwing so the caller can answer with its own
 * 500 shape; it deliberately never falls back to the other network's key, which
 * would sign a settlement with an account that cannot pay on the target chain.
 */
export function matcherOperatorSecret(network: NetworkId): string | undefined {
  const explicit =
    network === "mainnet"
      ? process.env.MATCHER_OPERATOR_SECRET_MAINNET
      : process.env.MATCHER_OPERATOR_SECRET_TESTNET;
  if (explicit) return explicit;
  if (network === PRIMARY_NETWORK) return process.env.MATCHER_OPERATOR_SECRET;
  return undefined;
}

export { PRIMARY_NETWORK as LEGACY_PRIMARY_NETWORK };
export type { NetworkId as LegacyNetworkId, NetworkConfig as LegacyNetworkConfig };
