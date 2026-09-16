"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { NetworkProvider } from "@/features/network/NetworkContext";
import type { NetworkId } from "@/config";
import { useState } from "react";

export function Providers({ network, children }: { network: NetworkId; children: React.ReactNode }) {
  // Lazy initializer: the QueryClient is created exactly once per mount and is
  // never recreated on re-render (avoids tearing down the cache).
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
        <QueryClientProvider client={client}>
          <TooltipProvider delay={300}>
            {children}
            <Toaster position="bottom-right" theme="dark" />
          </TooltipProvider>
        </QueryClientProvider>
      </NetworkProvider>
    </ErrorBoundary>
  );
}
