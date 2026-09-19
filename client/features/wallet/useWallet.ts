"use client";

/**
 * The connected wallet, as the app needs to reason about it.
 *
 * Replaces the Freighter-era zustand store. The wallet's state lives in wagmi
 * now; this hook only adds what wagmi cannot know — which chain the selected
 * venue expects — so "connected but on the wrong chain" is one boolean every
 * component reads the same way instead of each re-deriving it.
 *
 * `address` is the checksummed address when connected, else null. It stays set
 * while the wallet is on the wrong chain (so a portfolio can still be shown),
 * but anything that signs or sends must check `ready`, not `connected`.
 */

import { useCallback } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import type { Address } from "viem";
import { useAccount, useBalance, useDisconnect, useSwitchChain } from "wagmi";

import { useNetwork } from "@/features/network/NetworkContext";
import { arcNetwork } from "@/lib/network";
import { isLowGas } from "@/lib/wallet/gas";

export interface WalletView {
  address: Address | null;
  connected: boolean;
  connecting: boolean;
  /** The chain the wallet reports, when connected. */
  chainId: number | null;
  /** The chain the selected venue runs on. */
  expectedChainId: number;
  wrongNetwork: boolean;
  /** Connected AND on the expected chain: safe to sign and send. */
  ready: boolean;
  /** Native gas USDC in wei (18 decimals); null until read. */
  gasBalance: bigint | null;
  lowGas: boolean;
  connect: () => void;
  disconnect: () => void;
  /** Ask the wallet to switch (adding the chain first if it does not know it). */
  switchToExpected: () => Promise<void>;
  switching: boolean;
}

export function useWallet(): WalletView {
  const { network } = useNetwork();
  const expectedChainId = arcNetwork(network).chainId;
  const account = useAccount();
  const { openConnectModal } = useConnectModal();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();

  const connected = account.status === "connected";
  const address = connected ? (account.address ?? null) : null;
  const chainId = connected ? (account.chainId ?? null) : null;
  const wrongNetwork = connected && chainId !== expectedChainId;

  const balance = useBalance({
    address: address ?? undefined,
    chainId: expectedChainId,
    query: { enabled: connected && !wrongNetwork, refetchInterval: 15_000 },
  });
  const gasBalance = balance.data?.value ?? null;

  const connect = useCallback(() => openConnectModal?.(), [openConnectModal]);
  const switchToExpected = useCallback(async () => {
    await switchChainAsync({ chainId: expectedChainId });
  }, [switchChainAsync, expectedChainId]);

  return {
    address,
    connected,
    // Not while the modal is merely open: nothing is pending until a wallet is picked.
    connecting: account.status === "connecting" || account.status === "reconnecting",
    chainId,
    expectedChainId,
    wrongNetwork,
    ready: connected && !wrongNetwork,
    gasBalance,
    lowGas: gasBalance !== null && isLowGas(gasBalance),
    connect,
    disconnect: () => disconnect(),
    switchToExpected,
    switching,
  };
}
