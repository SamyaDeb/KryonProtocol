"use client";

import "@rainbow-me/rainbowkit/styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { darkTheme, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { NetworkProvider } from "@/features/network/NetworkContext";
import { arcNetwork, type ArcNetworkId } from "@/lib/network";
import { createWalletConfig } from "@/lib/wallet/config";

/**
 * The one provider tree: network → wagmi → react-query → RainbowKit.
 *
 * The wagmi config is built for the server-resolved network, once per mount.
 * A network switch is a full page load (NetworkContext), so the config never
 * has to change underneath a mounted tree.
 */
export function Providers({ network, children }: { network: ArcNetworkId; children: React.ReactNode }) {
  // Lazy initializers: created exactly once per mount, never on re-render.
  const [wagmiConfig] = useState(() => createWalletConfig(network));
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchInterval: 10_000,
            // Don't poll/refetch in background tabs — saves RPC load & avoids
            // multi-tab thundering herd against the live infra.
            refetchIntervalInBackground: false,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      })
  );

  return (
    <ErrorBoundary>
      <NetworkProvider network={network}>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={client}>
            <RainbowKitProvider
              initialChain={arcNetwork(network).chainId}
              modalSize="compact"
              theme={darkTheme({ accentColor: "#f5f5f5", accentColorForeground: "#19191A", borderRadius: "small" })}
            >
              <TooltipProvider delay={300}>
                {children}
                <Toaster position="bottom-right" theme="dark" />
              </TooltipProvider>
            </RainbowKitProvider>
          </QueryClientProvider>
        </WagmiProvider>
      </NetworkProvider>
    </ErrorBoundary>
  );
}
