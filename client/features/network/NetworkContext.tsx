"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getNetworkConfig, type NetworkConfig, type NetworkId } from "@/config";
import { NETWORK_PARAM, pendingUrlNetwork, writeNetworkCookie } from "@/lib/network-resolve";

interface NetworkContextValue {
  network: NetworkId;
  config: NetworkConfig;
  /** True while the page is reloading into the newly selected network. */
  switching: boolean;
  switchNetwork: (next: NetworkId) => void;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

export function NetworkProvider({
  network,
  children,
}: {
  /**
   * Resolved on the SERVER from the request cookie, then passed down. The
   * client resolves `ACTIVE_NETWORK_ID` from the same cookie, so this prop and
   * the app's config constants always name the same network — and the markup
   * this context drives renders identically on both sides.
   */
  network: NetworkId;
  children: React.ReactNode;
}) {
  const [switching, setSwitching] = useState(false);

  // Split from `switchNetwork` because it touches no React state: the deep-link
  // reconciliation effect below calls it, and a setState there would be a
  // cascading render for a page that is about to be torn down anyway.
  const navigateToNetwork = useCallback((next: NetworkId) => {
    writeNetworkCookie(next);


    // A FULL PAGE LOAD, not a client-side navigation. This is the whole reason
    // a single static `CONTRACTS` const remains safe.
    //
    // Switching venue has to invalidate every piece of network-derived state at
    // once: the memoised Soroban RPC client, the open WebSocket, the React
    // Query cache, in-flight polls, the connected wallet's balances and
    // positions, and the signing passphrase. Those are scattered across module
    // singletons and component state; an in-place swap would have to find and
    // reset each one, and missing a single one shows mainnet balances against
    // testnet contracts. A reload resets all of them by construction.
    //
    // The `?network=` param makes the choice authoritative for the very first
    // request of the new page, before any cookie round-trip is relied on.
    const url = new URL(window.location.href);
    url.searchParams.set(NETWORK_PARAM, next);
    window.location.assign(url.toString());
  }, []);

  /** User-initiated switch: shows the pending state, then navigates. */
  const switchNetwork = useCallback(
    (next: NetworkId) => {
      if (next === network) return;
      setSwitching(true);
      navigateToNetwork(next);
    },
    [network, navigateToNetwork]
  );

  // Shared deep links (`/trade/BTC-PERP?network=testnet`) arrive with a param
  // that may disagree with the visitor's cookie. The cookie is what both server
  // and client render from, so honouring the param means writing it and
  // reloading — done in an effect, after hydration has already matched.
  useEffect(() => {
    const pending = pendingUrlNetwork();
    if (pending) navigateToNetwork(pending);
  }, [navigateToNetwork]);

  const value = useMemo<NetworkContextValue>(
    () => ({ network, config: getNetworkConfig(network), switching, switchNetwork }),
    [network, switching, switchNetwork]
  );

  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error("useNetwork must be used within a NetworkProvider");
  return ctx;
}
