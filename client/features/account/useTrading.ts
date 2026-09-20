"use client";

/**
 * Order placement and cancellation for the connected wallet, wired to the
 * API, the wallet's signer and the account's cached queries.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { zeroAddress, type Address, type Hex } from "viem";
import { usePublicClient, useSignTypedData, useWriteContract } from "wagmi";

import { useAccountState, useProtocolConfig } from "@/features/account/chain";
import { accountKeys } from "@/features/account/queries";
import { useNetwork } from "@/features/network/NetworkContext";
import { withNetwork } from "@/lib/api";
import { orderGatewayAbi } from "@/lib/chain/contracts";
import type { Order } from "@/lib/market/eip712";
import {
  allocateNonce,
  cancelAllOrders,
  cancelOrder,
  orderExpiry,
  placeOrder,
  type Domain,
  type Outcome,
  type SignTypedData,
} from "@/lib/market/trading";
import { arcNetwork } from "@/lib/network";

export interface NewOrder {
  marketId: number;
  isLong: boolean;
  /** 1e18 */
  size: bigint;
  /** 1e18 */
  limitPrice: bigint;
  reduceOnly: boolean;
  ttlSeconds: bigint;
}

export function useTrading(address: Address | null | undefined) {
  const { network } = useNetwork();
  const chainId = arcNetwork(network).chainId;
  const queryClient = useQueryClient();
  const { data: cfg } = useProtocolConfig();
  const account = useAccountState(address);
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId });
  const lastNonce = useRef(0n);

  const sign = signTypedDataAsync as unknown as SignTypedData;
  const domain = cfg?.eip712_domain as Domain | undefined;
  const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

  const refresh = useCallback(() => {
    if (!address) return;
    const lower = address.toLowerCase();
    void queryClient.invalidateQueries({ queryKey: accountKeys.orders(network, lower) });
    void queryClient.invalidateQueries({ queryKey: accountKeys.fills(network, lower) });
    void queryClient.invalidateQueries({ queryKey: accountKeys.positions(network, lower) });
    void queryClient.invalidateQueries({ queryKey: account.queryKey });
  }, [address, network, queryClient, account.queryKey]);

  const submit = useCallback(
    async (o: NewOrder): Promise<Outcome<{ orderHash: string; duplicate: boolean }>> => {
      if (!address || !domain) return { ok: false, code: "unavailable", message: "Wallet or network config not ready." };
      const nonce = allocateNonce({ minNonce: account.data?.minNonce ?? 0n, last: lastNonce.current, nowMs: Date.now() });
      lastNonce.current = nonce;
      const order: Order = {
        owner: address,
        marketId: o.marketId,
        isLong: o.isLong,
        size: o.size,
        limitPrice: o.limitPrice,
        reduceOnly: o.reduceOnly,
        nonce,
        expiry: orderExpiry(nowSec(), o.ttlSeconds),
        referrer: zeroAddress,
      };
      const r = await placeOrder({ domain, order, sign, path: withNetwork("/api/orders", network) });
      refresh();
      return r;
    },
    [address, domain, account.data?.minNonce, sign, network, refresh]
  );

  const cancel = useCallback(
    async (nonce: bigint): Promise<Outcome> => {
      if (!address || !domain) return { ok: false, code: "unavailable", message: "Wallet or network config not ready." };
      const r = await cancelOrder({ domain, owner: address, nonce, nowSec: nowSec(), sign, path: withNetwork("/api/orders/cancel", network) });
      refresh();
      return r;
    },
    [address, domain, sign, network, refresh]
  );

  const cancelAll = useCallback(
    async (marketId: number): Promise<Outcome<{ cancelled: number }>> => {
      if (!address || !domain) return { ok: false, code: "unavailable", message: "Wallet or network config not ready." };
      const r = await cancelAllOrders({ domain, owner: address, marketId, nowSec: nowSec(), sign, path: withNetwork("/api/orders/cancel-all", network) });
      refresh();
      return r;
    },
    [address, domain, sign, network, refresh]
  );

  /**
   * The authoritative cancel: `cancelUpTo(nonce)` on the gateway makes every
   * order with a lower nonce unfillable, whatever the matcher does. One
   * transaction, paid in USDC gas.
   */
  const cancelOnChainUpTo = useCallback(
    async (nonce: bigint): Promise<Hex> => {
      if (!cfg || !publicClient) throw new Error("Network config is still loading");
      const hash = await writeContractAsync({
        chainId,
        address: cfg.contracts.order_gateway,
        abi: orderGatewayAbi,
        functionName: "cancelUpTo",
        args: [nonce],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The cancel transaction reverted.");
      lastNonce.current = nonce > lastNonce.current ? nonce : lastNonce.current;
      refresh();
      return hash;
    },
    [cfg, publicClient, writeContractAsync, chainId, refresh]
  );

  return { submit, cancel, cancelAll, cancelOnChainUpTo, ready: !!domain && !!address, account };
}
