/**
 * EIP-712 typed data for Kryon orders and cancels.
 *
 * Must match `OrderLib` / `OrderGateway` exactly (domain "Kryon" / "1",
 * verifyingContract = the gateway proxy). `eip712.test.ts` pins a golden digest
 * produced by the Solidity implementation; if either side changes, it fails.
 *
 * Safe to import from client and server code.
 */

import {
  hashTypedData,
  recoverTypedDataAddress,
  zeroAddress,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";

export const EIP712_NAME = "Kryon";
export const EIP712_VERSION = "1";

export const ORDER_TYPES = {
  Order: [
    { name: "owner", type: "address" },
    { name: "marketId", type: "uint32" },
    { name: "isLong", type: "bool" },
    { name: "size", type: "uint256" },
    { name: "limitPrice", type: "uint256" },
    { name: "reduceOnly", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "referrer", type: "address" },
  ],
} as const;

export const CANCEL_TYPES = {
  Cancel: [
    { name: "owner", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

/** Mirrors `struct Order`. `size` and `limitPrice` are 1e18 fixed point. */
export interface Order {
  owner: Address;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  reduceOnly: boolean;
  nonce: bigint;
  /** Unix seconds. */
  expiry: bigint;
  /** zeroAddress when there is none. */
  referrer: Address;
}

export interface Cancel {
  owner: Address;
  nonce: bigint;
  deadline: bigint;
}

export function kryonDomain(chainId: number, gateway: Address): TypedDataDomain {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract: gateway };
}

/** Wallet-ready typed data (`signTypedData` / `eth_signTypedData_v4`). */
export function orderTypedData(chainId: number, gateway: Address, order: Order) {
  return {
    domain: kryonDomain(chainId, gateway),
    types: ORDER_TYPES,
    primaryType: "Order" as const,
    message: order,
  };
}

export function cancelTypedData(chainId: number, gateway: Address, cancel: Cancel) {
  return {
    domain: kryonDomain(chainId, gateway),
    types: CANCEL_TYPES,
    primaryType: "Cancel" as const,
    message: cancel,
  };
}

/** Equals `OrderGateway.hashOrder(order)`. */
export function hashOrder(chainId: number, gateway: Address, order: Order): Hex {
  return hashTypedData(orderTypedData(chainId, gateway, order));
}

/** Equals `OrderGateway.hashCancel(cancel)`. */
export function hashCancel(chainId: number, gateway: Address, cancel: Cancel): Hex {
  return hashTypedData(cancelTypedData(chainId, gateway, cancel));
}

/**
 * EOA pre-check for `POST /api/orders`. Contract wallets (ERC-1271) cannot be
 * checked by recovery; callers fall back to an `eth_call` or let the gateway
 * decide at settlement.
 */
export async function isEoaOrderSignature(
  chainId: number,
  gateway: Address,
  order: Order,
  signature: Hex
): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({ ...orderTypedData(chainId, gateway, order), signature });
    return signer.toLowerCase() === order.owner.toLowerCase();
  } catch {
    return false;
  }
}

export const NO_REFERRER: Address = zeroAddress;
