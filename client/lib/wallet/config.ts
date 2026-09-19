/**
 * The wagmi config for one page load: the selected network's chain and the
 * connectors from §3.1 — injected (MetaMask, Rabby, any EIP-6963 wallet),
 * Coinbase Wallet, WalletConnect and Ledger.
 *
 * WalletConnect (and Ledger Live, which connects through it) needs a project id
 * from `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`. Without one those two are left
 * out rather than offered broken; injected and Coinbase still work.
 *
 * Browser-safe; built once per mount in Providers.
 */

import { connectorsForWallets, type WalletList } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  ledgerWallet,
  metaMaskWallet,
  rabbyWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http, type Config } from "wagmi";

import { arcNetwork, type ArcNetworkId } from "@/lib/network";

import { walletChain } from "./chains";

export const APP_NAME = "Kryon";

/** Literal member expression: Next inlines NEXT_PUBLIC_* by textual substitution. */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

export function walletList(projectId: string): WalletList {
  const wallets = [metaMaskWallet, rabbyWallet, coinbaseWallet, injectedWallet];
  if (projectId) wallets.push(walletConnectWallet, ledgerWallet);
  return [{ groupName: "Wallets", wallets }];
}

export function createWalletConfig(network: ArcNetworkId, projectId = WALLETCONNECT_PROJECT_ID): Config {
  const chain = walletChain(network);
  const connectors = connectorsForWallets(walletList(projectId), {
    appName: APP_NAME,
    // connectorsForWallets requires a string; the wallets that use it are
    // excluded above when it is empty.
    projectId: projectId || "unset",
  });
  return createConfig({
    chains: [chain],
    connectors,
    transports: { [chain.id]: http(arcNetwork(network).publicRpcUrl) },
    ssr: true,
  });
}
