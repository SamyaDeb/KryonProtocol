/**
 * Contract errors in plain language, for rejected fills (`rejectReason`, the
 * decoded error name the indexer stores) and for reverted wallet
 * transactions (deposit, withdraw, cancelUpTo).
 *
 * Only errors a trader can actually hit are worded here; anything else falls
 * back to its name, which is still better than a hex blob.
 */

import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";

import { decodeRevert } from "@/lib/chain/settlement";

export const CONTRACT_ERROR_TEXT: Record<string, string> = {
  AccountInsolvent: "The account would be below its margin requirement after this trade.",
  InsufficientCollateral: "Not enough collateral: the amount exceeds your balance, or what your open positions need.",
  StaleOracle: "The price feed is stale. Trading and withdrawals with open positions wait until it updates.",
  OracleConfidenceTooWide: "The price feed is too uncertain right now. Try again shortly.",
  PriceOutsideBand: "The fill price was too far from the index price.",
  OpenInterestExceeded: "This market's open-interest cap is reached.",
  AggregateOiPolicyExceeded: "The venue's open-interest limit is reached.",
  OrderExpired: "The order expired before it could fill.",
  OrderCancelled: "The order was cancelled on chain.",
  OrderOverfilled: "The order was already filled.",
  SelfTrade: "An order cannot fill against another order from the same account.",
  DepositCapExceeded: "The deposit cap is reached, for the venue or for your account.",
  FillBelowMinNotional: "The fill was below this market's minimum size.",
  MarketInactive: "This market is paused.",
  PositionNotFound: "Reduce-only: there is no position to reduce.",
  DirectionMismatch: "Reduce-only: the order would increase the position.",
  InvalidAmount: "The amount is invalid.",
  InvalidSignature: "The order signature did not verify.",
  NonceReused: "That nonce was already used.",
  ExecutionPaused: "Trading is paused by the guardian.",
  CollateralNotSupported: "That token is not accepted as collateral.",
  TooManyPositions: "Too many open positions on this account.",
  NetFeeBelowFloor: "The fee pairing is below the venue's minimum.",
};

export function contractErrorText(name: string | null | undefined): string {
  if (!name) return "The transaction was reverted.";
  return CONTRACT_ERROR_TEXT[name] ?? `Rejected by the contract (${name}).`;
}

/**
 * A wallet or RPC error as one sentence: user rejection, a decoded Kryon
 * revert, or viem's own short message.
 */
export function describeTxError(e: unknown): string {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return "You rejected the request in your wallet.";
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert) {
      const name = revert.data?.errorName ?? (revert.raw ? decodeRevert(revert.raw).errorName : null);
      return contractErrorText(name);
    }
    return e.shortMessage || e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
