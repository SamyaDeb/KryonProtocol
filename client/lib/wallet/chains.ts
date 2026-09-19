/**
 * wagmi/viem chain definitions for the wallet, built from the Arc registry.
 *
 * The wallet only ever needs the ONE chain the page is bound to. Switching
 * venue is a full page load (see NetworkContext), so the wagmi config is built
 * per page for the selected network and never has to hold two venues at once —
 * which matters on Arc because `arc-local` and `arc-testnet` share chain id
 * 5042002 and a single wagmi config cannot carry two chains with one id.
 *
 * Only the registry's PUBLIC RPC is used: this runs in the browser, and the
 * wallet may offer the URL to `wallet_addEthereumChain`.
 *
 * Browser-safe.
 */

import { defineChain, type Chain } from "viem";

import { arcNetwork, type ArcNetworkId } from "@/lib/network";

/** Native gas on Arc is USDC with 18 decimals (the ERC-20 view of it has 6). */
export const NATIVE_USDC_DECIMALS = 18;

export function walletChain(id: ArcNetworkId): Chain {
  const n = arcNetwork(id);
  return defineChain({
    id: n.chainId,
    name: n.label,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: NATIVE_USDC_DECIMALS },
    rpcUrls: {
      default: { http: [n.publicRpcUrl], webSocket: n.publicWsUrl ? [n.publicWsUrl] : undefined },
    },
    blockExplorers: { default: { name: "Arc Explorer", url: n.explorerUrl } },
    contracts: { multicall3: { address: n.multicall3 } },
    testnet: id !== "arc-mainnet",
  });
}
