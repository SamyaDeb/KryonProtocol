/**
 * Plain-language wallet errors. A raw provider message ("User rejected the
 * request." / "Unrecognized chain ID 0x4cef52") is not something a trader
 * should have to decode.
 */

import { BaseError, SwitchChainError, UserRejectedRequestError } from "viem";

function find<T extends Error>(e: unknown, cls: new (...args: never[]) => T): T | null {
  if (e instanceof BaseError) return (e.walk((x) => x instanceof cls) as T | null) ?? null;
  return e instanceof cls ? e : null;
}

export function isUserRejection(e: unknown): boolean {
  if (find(e, UserRejectedRequestError)) return true;
  const code = (e as { code?: unknown } | null)?.code;
  return code === 4001 || code === "ACTION_REJECTED";
}

export function describeSwitchError(e: unknown, networkLabel: string): string {
  if (isUserRejection(e)) return `Network switch cancelled. Kryon needs your wallet on ${networkLabel} to sign.`;
  if (find(e, SwitchChainError)) {
    return `Your wallet could not switch to ${networkLabel}. Add the network in the wallet and try again.`;
  }
  return `Could not switch to ${networkLabel}. Switch networks in your wallet, then return here.`;
}
