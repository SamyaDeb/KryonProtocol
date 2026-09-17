/**
 * viem clients for Arc.
 *
 * Reads go through a fallback transport: paid providers first (in the order
 * given by `ARC_RPC_URLS`), the public RPC last. Every service calls
 * `assertChainId` before doing anything, so a misconfigured URL that points at
 * another chain fails at startup instead of signing for the wrong network.
 *
 * Each service owns exactly one signing key (plan §6.2, §10.3); keys never
 * share nonces. Server-side only.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import type { ArcNetwork, Env } from "./networks";

/** A viem chain built from our registry (not viem's defaults; see networks.ts). */
export function arcChain(network: ArcNetwork, rpcUrls: string[] = [network.publicRpcUrl]): Chain {
  return defineChain({
    id: network.chainId,
    name: network.label,
    // Native gas USDC uses 18 decimals; the ERC-20 interface uses 6.
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls, webSocket: network.publicWsUrl ? [network.publicWsUrl] : undefined } },
    blockExplorers: { default: { name: "Arc Explorer", url: network.explorerUrl } },
    contracts: { multicall3: { address: network.multicall3 } },
  });
}

/** Provider URLs from `ARC_RPC_URLS` (comma separated), public RPC appended last. */
export function rpcUrlsFromEnv(network: ArcNetwork, env: Env = process.env): string[] {
  const configured = (env.ARC_RPC_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const urls = [...configured];
  if (!urls.includes(network.publicRpcUrl)) urls.push(network.publicRpcUrl);
  return urls;
}

export function arcTransport(urls: string[]): Transport {
  if (urls.length === 0) throw new Error("at least one RPC URL is required");
  // rank: false keeps the configured order (paid first, public last) instead of
  // reordering by latency probes that would spend the public RPC's rate limit.
  return fallback(
    urls.map((url) => http(url, { timeout: 10_000, retryCount: 1 })),
    { rank: false, retryCount: 2 }
  );
}

export function createArcPublicClient(network: ArcNetwork, urls = rpcUrlsFromEnv(network)): PublicClient {
  return createPublicClient({
    chain: arcChain(network, urls),
    transport: arcTransport(urls),
    batch: { multicall: true },
  });
}

/**
 * Fail fast unless the RPC reports the expected chain id. Called once at
 * service startup (plan §6.1).
 */
export async function assertChainId(
  client: Pick<PublicClient, "getChainId">,
  network: ArcNetwork
): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== network.chainId) {
    throw new Error(
      `RPC chain id ${actual} does not match ${network.id} (${network.chainId}); refusing to start`
    );
  }
}

/** Load a service key from the environment. The key never touches disk here. */
export function serviceAccount(envVar: string, env: Env = process.env): PrivateKeyAccount {
  const raw = env[envVar];
  if (!raw) throw new Error(`${envVar} is not set`);
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${envVar} is not a 32-byte hex private key`);
  return privateKeyToAccount(key);
}

export function createServiceWalletClient(
  network: ArcNetwork,
  account: PrivateKeyAccount,
  urls = rpcUrlsFromEnv(network)
): WalletClient {
  return createWalletClient({ account, chain: arcChain(network, urls), transport: arcTransport(urls) });
}
