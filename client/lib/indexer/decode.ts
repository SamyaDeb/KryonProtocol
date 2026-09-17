/**
 * Log decoding for the indexer. Every Kryon log is decoded against the ABI of
 * the contract that emitted it and normalised into JSON-safe values, which is
 * exactly what `ProtocolEvent.args` stores and what projections consume. Live
 * indexing and a rebuild from `ProtocolEvent` therefore run the same code.
 */

import { decodeErrorResult, decodeEventLog, hexToString, type Abi, type Address, type Hex } from "viem";

import {
  ALL_ERRORS_ABI,
  engineAbi,
  feeRouterAbi,
  insuranceAbi,
  kryonTimelockAbi,
  liquidationAbi,
  oracleAdapterAbi,
  orderGatewayAbi,
  riskParamsAbi,
  vaultAbi,
} from "@/lib/chain/contracts";
import type { ProtocolContracts } from "@/lib/chain/networks";

export type ContractName = keyof ProtocolContracts;

const ABIS: Record<ContractName, Abi> = {
  vault: vaultAbi,
  engine: engineAbi,
  orderGateway: orderGatewayAbi,
  oracleAdapter: oracleAdapterAbi,
  liquidation: liquidationAbi,
  insurance: insuranceAbi,
  riskParams: riskParamsAbi,
  feeRouter: feeRouterAbi,
  timelock: kryonTimelockAbi,
};

/** JSON-safe decoded value: bigints as decimal strings, hex lowercased. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type EventArgs = Record<string, Json>;

export interface RawLog {
  address: Address;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  topics: readonly Hex[];
  data: Hex;
}

/** A log as stored in, and replayed from, `ProtocolEvent`. */
export interface StoredEvent {
  network: string;
  blockNumber: bigint;
  blockTimestamp: Date;
  txHash: string;
  logIndex: number;
  contract: string;
  eventName: string;
  args: EventArgs;
}

export class ContractRegistry {
  private readonly byAddress = new Map<string, ContractName>();

  constructor(readonly contracts: ProtocolContracts) {
    for (const [name, address] of Object.entries(contracts) as [ContractName, Address][]) {
      this.byAddress.set(address.toLowerCase(), name);
    }
  }

  addresses(): Address[] {
    return Object.values(this.contracts);
  }

  nameOf(address: string): ContractName | undefined {
    return this.byAddress.get(address.toLowerCase());
  }

  /**
   * Decode a log. Logs the ABI does not know (should not happen for our own
   * contracts) are kept as `Unknown` with their raw topics and data, so the
   * cursor never stalls on them and they stay visible for investigation.
   */
  decode(log: RawLog): { eventName: string; args: EventArgs } {
    const name = this.nameOf(log.address);
    if (name) {
      try {
        const decoded = decodeEventLog({
          abi: ABIS[name],
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data,
          strict: true,
        });
        return { eventName: decoded.eventName ?? "Unknown", args: normalize(decoded.args ?? {}) as EventArgs };
      } catch {
        // fall through
      }
    }
    return { eventName: "Unknown", args: { topics: log.topics.map(lower), data: lower(log.data) } };
  }
}

export function normalize(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.startsWith("0x") ? value.toLowerCase() : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalize(v);
    return out;
  }
  return String(value);
}

/** `bytes32("TRADE")` → "TRADE". */
export function bytes32ToString(value: string): string {
  return hexToString(value as Hex, { size: 32 }).replace(/\0+$/, "");
}

/** Readable reason for `FillRejected.reason` (ABI-encoded revert data). */
export function decodeRevertReason(data: string): string {
  if (data === "0x") return "empty revert";
  try {
    const { errorName, args } = decodeErrorResult({ abi: ALL_ERRORS_ABI, data: data as Hex });
    const rendered = (args ?? []).map((a) => String(normalize(a)));
    return rendered.length ? `${errorName}(${rendered.join(", ")})` : errorName;
  } catch {
    return data.toLowerCase();
  }
}

function lower(v: string): string {
  return v.toLowerCase();
}
