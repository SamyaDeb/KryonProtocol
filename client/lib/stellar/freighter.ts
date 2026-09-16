"use client";

import {
  getAddress,
  isConnected,
  requestAccess,
  signTransaction,
  signAuthEntry,
  signMessage,
  getNetworkDetails,
} from "@stellar/freighter-api";
import { NETWORK_PASSPHRASE } from "./client";

export async function freighterIsInstalled(): Promise<boolean> {
  try {
    const res = await isConnected();
    return !res.error;
  } catch {
    return false;
  }
}

export async function freighterConnect(): Promise<string> {
  const access = await requestAccess();
  if (access.error) throw new Error(access.error.message);
  const addr = await getAddress();
  if (addr.error) throw new Error(addr.error.message);
  return addr.address;
}

export async function freighterGetAddress(): Promise<string | null> {
  try {
    const addr = await getAddress();
    if (addr.error) return null;
    return addr.address;
  } catch {
    return null;
  }
}

export async function freighterSignTx(xdr: string): Promise<string> {
  const res = await signTransaction(xdr, { networkPassphrase: NETWORK_PASSPHRASE });
  if (res.error) throw new Error(res.error.message);
  return res.signedTxXdr;
}

async function freighterGetNetwork(): Promise<{ passphrase: string } | null> {
  try {
    const res = await getNetworkDetails();
    if (res.error) return null;
    return { passphrase: res.networkPassphrase };
  } catch {
    return null;
  }
}

export async function freighterSignAuthEntry(entryXdr: string): Promise<string> {
  const res = await signAuthEntry(entryXdr, { networkPassphrase: NETWORK_PASSPHRASE });
  if (res.error) throw new Error(res.error.message);
  if (!res.signedAuthEntry) throw new Error("Freighter returned empty auth entry");
  return res.signedAuthEntry;
}

export async function freighterSignMessage(message: string, address?: string): Promise<string> {
  const res = await signMessage(message, { networkPassphrase: NETWORK_PASSPHRASE, address });
  if (res.error) throw new Error(res.error.message);
  if (!res.signedMessage) throw new Error("Freighter returned empty signature");
  return typeof res.signedMessage === "string"
    ? res.signedMessage
    : btoa(String.fromCharCode(...new Uint8Array(res.signedMessage)));
}

/**
 * Whether the wallet is on the network this deployment targets. The name is
 * network-agnostic on purpose: the same check guards testnet and mainnet, and
 * the passphrase it compares against comes from the active network config.
 */
export async function isOnExpectedNetwork(): Promise<boolean> {
  const net = await freighterGetNetwork();
  return net?.passphrase === NETWORK_PASSPHRASE;
}
