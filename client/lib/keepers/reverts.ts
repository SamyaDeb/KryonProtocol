/**
 * Revert decoding shared by the keepers: find the revert payload inside a
 * viem error and name it against every custom error in the protocol.
 */

import { decodeRevert } from "@/lib/chain/settlement";
import { extractRevertData } from "@/lib/reconciler/jobs";

export function decodeError(err: unknown): { errorName: string | null; errorArgs: readonly unknown[] } {
  const data = extractRevertData(err);
  return data ? decodeRevert(data) : { errorName: null, errorArgs: [] };
}
