/**
 * What a check gets to work with during one tick.
 *
 * Reads are memoised per tick through `once`, so the eight oracle checks and
 * the coverage check share one `markets()` multicall instead of issuing nine.
 * A read that fails fails every check that awaited it, each of which then
 * reports `error` for itself; the others carry on.
 */

import type { ProtocolContracts } from "@/lib/chain/networks";

import type { MonitorChain } from "./chain";
import type { MonitorConfig } from "./config";
import type { ExpectedImpl, RoleMembership } from "./roles";
import type { MonitorStore } from "./store";
import type { CheckMeta, CheckResult } from "./types";

export interface Probes {
  /** One JSON-RPC `eth_blockNumber` against one endpoint; latency in ms, or throws. */
  rpc(url: string): Promise<{ latencyMs: number; blockNumber: bigint }>;
  /** GET; resolves with the HTTP status, throws when unreachable. */
  http(url: string): Promise<number>;
  /** Resolves once a WebSocket connection opens; throws otherwise. */
  ws(url: string): Promise<void>;
  /** Seconds a read replica is behind; null when the server is not a replica. */
  replicaLag(): Promise<number | null>;
}

export interface CheckContext {
  cfg: MonitorConfig;
  network: string;
  contracts: ProtocolContracts;
  chain: MonitorChain;
  store: MonitorStore;
  probes: Probes;
  roleBaseline: RoleMembership | null;
  /** Implementations from the deployment record file, when one is configured. */
  deploymentRecord: Map<string, ExpectedImpl>;
  /** Wall clock, ms. Every DB-side age is measured against this, never Date.now(). */
  now(): number;
  once<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export interface Check extends CheckMeta {
  /** The threshold in words, for the registry table and the snapshot. */
  threshold(cfg: MonitorConfig): string;
  run(ctx: CheckContext): Promise<CheckResult[]>;
}

/** A per-tick memo: the first caller starts the read, everyone else awaits it. */
export function memo(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const cache = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>) => {
    let p = cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      cache.set(key, p);
    }
    return p;
  };
}

/** The shared reads, so every check names them the same way. */
export const reads = {
  head: (c: CheckContext) => c.once("head", () => c.chain.head()),
  markets: (c: CheckContext) => c.once("markets", () => c.chain.markets()),
  oracle: (c: CheckContext) => c.once("oracle", () => c.chain.oracle()),
  insurance: (c: CheckContext) => c.once("insurance", () => c.chain.insurance()),
};
