/**
 * Arc network registry and protocol contract addresses.
 *
 * Every value here is public. Sources and verification dates live in
 * docs/arc-facts.md. RPC URLs here are the public fallbacks only; services
 * put their paid provider URLs first via `ARC_RPC_URLS` (see clients.ts).
 *
 * viem ships `arc` / `arcTestnet` chain definitions, but their default RPC
 * hosts (`*.arc.network`) differ from the ones Arc documents (`*.arc.io`), so
 * we define the chains from this registry rather than trusting those defaults.
 *
 * This module is BROWSER-SAFE and must stay that way: the UI resolves chain ids
 * and explorer URLs through `@/lib/network`, which re-exports from here. The
 * one function that read a deployment file lives in `./contracts-env.ts`, since
 * a `node:fs` import anywhere in this graph fails the client build outright.
 */

import { getAddress, type Address } from "viem";

/** Environment lookup; `process.env` in services, a plain object in tests. */
export type Env = Record<string, string | undefined>;

export const ARC_NETWORK_IDS = ["arc-mainnet", "arc-testnet", "arc-local"] as const;
export type ArcNetworkId = (typeof ARC_NETWORK_IDS)[number];

export function isArcNetworkId(value: unknown): value is ArcNetworkId {
  return typeof value === "string" && (ARC_NETWORK_IDS as readonly string[]).includes(value);
}

export interface ArcNetwork {
  id: ArcNetworkId;
  chainId: number;
  label: string;
  /** Last-resort public RPC. */
  publicRpcUrl: string;
  /** Public WebSocket, where Arc documents one (testnet only). */
  publicWsUrl?: string;
  explorerUrl: string;
  /** USDC ERC-20 interface (6 decimals). The same balance as native gas USDC. */
  usdc: Address;
  permit2: Address;
  multicall3: Address;
  /** Transactions priced below the base-fee floor are not reliably included. */
  minBaseFeeGwei: bigint;
}

const USDC: Address = "0x3600000000000000000000000000000000000000";
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const ARC_NETWORKS: Record<ArcNetworkId, ArcNetwork> = {
  "arc-mainnet": {
    id: "arc-mainnet",
    chainId: 5042,
    label: "Arc Mainnet",
    publicRpcUrl: "https://rpc.mainnet.arc.io",
    explorerUrl: "https://explorer.arc.io",
    usdc: USDC,
    permit2: PERMIT2,
    multicall3: MULTICALL3,
    minBaseFeeGwei: 20n,
  },
  "arc-testnet": {
    id: "arc-testnet",
    chainId: 5042002,
    label: "Arc Testnet",
    publicRpcUrl: "https://rpc.testnet.arc.io",
    publicWsUrl: "wss://rpc.testnet.arc.io",
    explorerUrl: "https://explorer.testnet.arc.io",
    usdc: USDC,
    permit2: PERMIT2,
    multicall3: MULTICALL3,
    minBaseFeeGwei: 20n,
  },
  // A local arc-anvil fork of Arc testnet: same chain id, same system contracts.
  "arc-local": {
    id: "arc-local",
    chainId: 5042002,
    label: "Arc Local (anvil fork)",
    publicRpcUrl: "http://127.0.0.1:8545",
    explorerUrl: "https://explorer.testnet.arc.io",
    usdc: USDC,
    permit2: PERMIT2,
    multicall3: MULTICALL3,
    minBaseFeeGwei: 20n,
  },
};

export function arcNetwork(id: ArcNetworkId): ArcNetwork {
  return ARC_NETWORKS[id];
}

/** The network a server process runs against: `KRYON_NETWORK`, default testnet. */
export function serverNetworkId(env: Env = process.env): ArcNetworkId {
  const raw = env.KRYON_NETWORK ?? "arc-testnet";
  if (!isArcNetworkId(raw)) {
    throw new Error(`KRYON_NETWORK must be one of ${ARC_NETWORK_IDS.join(", ")}; got "${raw}"`);
  }
  return raw;
}

// ─── Protocol contracts ─────────────────────────────────────────────────────

export interface ProtocolContracts {
  vault: Address;
  engine: Address;
  orderGateway: Address;
  oracleAdapter: Address;
  liquidation: Address;
  insurance: Address;
  riskParams: Address;
  feeRouter: Address;
  timelock: Address;
}

/** Exported for `./contracts-env.ts`; not part of the public surface. */
export const CONTRACT_KEYS: Record<keyof ProtocolContracts, { env: string; json: string }> = {
  vault: { env: "CONTRACT_VAULT", json: "vault" },
  engine: { env: "CONTRACT_ENGINE", json: "engine" },
  orderGateway: { env: "CONTRACT_ORDER_GATEWAY", json: "gateway" },
  oracleAdapter: { env: "CONTRACT_ORACLE_ADAPTER", json: "oracle" },
  liquidation: { env: "CONTRACT_LIQUIDATION", json: "liquidation" },
  insurance: { env: "CONTRACT_INSURANCE", json: "insurance" },
  riskParams: { env: "CONTRACT_RISK_PARAMS", json: "risk" },
  feeRouter: { env: "CONTRACT_FEE_ROUTER", json: "feeRouter" },
  timelock: { env: "CONTRACT_TIMELOCK", json: "timelock" },
};

/**
 * Parse a deployment record written by `kryon-protocol/evm/script/*.s.sol`
 * (`deployments/<network>.json`). Throws on a record for another chain.
 */
export function contractsFromDeploymentJson(json: string, expectedChainId: number): ProtocolContracts {
  const record = JSON.parse(json) as {
    chainId: number;
    timelock: string;
    proxies: Record<string, string>;
  };
  if (Number(record.chainId) !== expectedChainId) {
    throw new Error(
      `deployment record is for chain ${record.chainId}, expected ${expectedChainId}`
    );
  }
  const out = {} as ProtocolContracts;
  for (const [key, names] of Object.entries(CONTRACT_KEYS) as [keyof ProtocolContracts, { json: string }][]) {
    const raw = key === "timelock" ? record.timelock : record.proxies?.[names.json];
    if (!raw) throw new Error(`deployment record is missing "${names.json}"`);
    out[key] = getAddress(raw);
  }
  return out;
}

/** bytes32 oracle feed id for a symbol, matching `bytes32("BTC")` in Solidity. */
export function oracleId(symbol: string): `0x${string}` {
  const bytes = new TextEncoder().encode(symbol);
  if (bytes.length === 0 || bytes.length > 32) throw new Error(`invalid oracle symbol "${symbol}"`);
  return `0x${Buffer.from(bytes).toString("hex").padEnd(64, "0")}`;
}
