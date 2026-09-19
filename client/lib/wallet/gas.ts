/**
 * Gas on Arc is paid in USDC — the same balance a trader deposits. A user who
 * deposits everything cannot afford the next transaction (a withdrawal
 * included), so the UI keeps a reserve out of "max" deposits and warns when
 * the wallet runs low.
 *
 * Amounts are native wei (18 decimals). Sized from the 20 gwei base-fee floor:
 * a deposit, withdrawal or on-chain cancel is well under 1M gas, i.e. under
 * 0.02 USDC at the floor; the reserve covers a couple of dozen of those with
 * room for a fee spike.
 */

import { parseUnits } from "viem";

import { NATIVE_USDC_DECIMALS } from "./chains";

/** Kept back from a "max" deposit. */
export const GAS_RESERVE_WEI = parseUnits("0.5", NATIVE_USDC_DECIMALS);

/** Below this, the wallet chrome warns that the next transaction may not go through. */
export const LOW_GAS_WEI = parseUnits("0.1", NATIVE_USDC_DECIMALS);

export function isLowGas(balanceWei: bigint): boolean {
  return balanceWei < LOW_GAS_WEI;
}
