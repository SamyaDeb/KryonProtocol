"use client";

import { getNetworkConfig } from "@/config";
import { useNetwork } from "@/features/network/NetworkContext";

/**
 * Warns when the selected venue has no keepers behind it.
 *
 * Without this, a network with no running oracle/matcher/indexer renders as a
 * perfectly normal venue that simply has no orders — indistinguishable from a
 * quiet market. A trader could place an order and wait indefinitely for a match
 * that nothing is running to produce. Say so explicitly instead.
 *
 * Driven by `NEXT_PUBLIC_{MAINNET,TESTNET}_KEEPERS_LIVE`; see config/networks.ts.
 */
export function NetworkBanner() {
  // From context (server-seeded), never the module-scope `KEEPERS_EXPECTED`:
  // that const is the deployment's own network during SSR, which would render
  // the banner for the wrong venue and hydrate-mismatch.
  const { config, switchNetwork } = useNetwork();
  if (config.keepersExpected) return null;

  // Never hardcode the destination: whichever venue is dead, the live one is
  // the *other* one. Writing "switch to Mainnet" into the copy made the banner
  // tell a mainnet user to switch to mainnet.
  const other = getNetworkConfig(config.id === "mainnet" ? "testnet" : "mainnet");
  const otherIsLive = other.keepersExpected;

  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 border-b border-[#48331c] bg-[#2a1f11] px-3 py-[6px] text-center text-[12px] text-[#ff9440]"
    >
      <span aria-hidden="true" className="h-[6px] w-[6px] shrink-0 rounded-full bg-[#ff9440]" />
      <span>
        <strong className="font-semibold">{config.label} is not live.</strong>{" "}
        Its price, matching and indexing services aren&apos;t running, so the order book will be
        empty and orders won&apos;t fill.{" "}
        {otherIsLive ? (
          <>
            <button
              type="button"
              onClick={() => switchNetwork(other.id)}
              className="font-semibold underline underline-offset-2 hover:text-[#ffb271]"
            >
              Switch to {other.shortLabel}
            </button>{" "}
            to trade.
          </>
        ) : (
          "Trading is unavailable on both networks right now."
        )}
      </span>
    </div>
  );
}
