/**
 * The public, per-network configuration a browser needs before it can sign or
 * send anything: chain id, contract addresses, and the two EIP-712 domains.
 *
 * WHY AN ENDPOINT
 * ---------------
 * Contract addresses live in a server-side deployment record
 * (`contractsForNetwork`), and they cannot be inlined into the bundle as
 * `NEXT_PUBLIC_*` values: one bundle serves several networks, and a redeploy of
 * the contracts must not require rebuilding the app. So the browser asks
 * `GET /api/config` and the answer comes from the same record the order intake
 * verifies signatures against — a UI that signs with this domain signs exactly
 * what the API will accept.
 *
 * Everything here is public. The RPC URL is the registry's PUBLIC endpoint
 * (the one a wallet would add), never `ARC_RPC_URLS`, which may carry a paid
 * provider's credential in its path.
 *
 * Browser-safe: the builder takes its inputs as arguments and the response
 * type is shared with the client.
 */

import type { Address, TypedDataDomain } from "viem";

import type { ArcNetwork, ArcNetworkId, ProtocolContracts } from "@/lib/chain/networks";
import { USDC_DECIMALS, LEDGER_DECIMALS } from "@/lib/chain/collateral";
import { kryonDomain } from "@/lib/market/eip712";

/**
 * Arc USDC's EIP-2612 domain. Verified on-chain (`eip712Domain()` on
 * 0x3600…0000): name "USDC", version "2". `depositWithPermit` signs against it.
 */
export const USDC_PERMIT_NAME = "USDC";
export const USDC_PERMIT_VERSION = "2";

export interface PublicContracts {
  vault: Address;
  order_gateway: Address;
  engine: Address;
  fee_router: Address;
  insurance: Address;
  oracle_adapter: Address;
  liquidation: Address;
  risk_params: Address;
  timelock: Address;
  usdc: Address;
  permit2: Address;
  multicall3: Address;
}

export interface PublicConfig {
  network: ArcNetworkId;
  chain_id: number;
  label: string;
  explorer_url: string;
  /** The registry's public RPC. Suitable for `wallet_addEthereumChain`. */
  public_rpc_url: string;
  contracts: PublicContracts;
  /** Exactly the domain `lib/market/eip712.ts` builds; pass it to `signTypedData` unchanged. */
  eip712_domain: TypedDataDomain & { chainId: number; verifyingContract: Address };
  usdc_permit_domain: TypedDataDomain & { chainId: number; verifyingContract: Address };
  usdc_decimals: number;
  ledger_decimals: number;
  /** Orders' `size` and `limitPrice` are 1e18 fixed point. */
  price_precision: string;
  amount_precision: string;
}

export function buildPublicConfig(network: ArcNetwork, contracts: ProtocolContracts): PublicConfig {
  const domain = kryonDomain(network.chainId, contracts.orderGateway);
  return {
    network: network.id,
    chain_id: network.chainId,
    label: network.label,
    explorer_url: network.explorerUrl,
    public_rpc_url: network.publicRpcUrl,
    contracts: {
      vault: contracts.vault,
      order_gateway: contracts.orderGateway,
      engine: contracts.engine,
      fee_router: contracts.feeRouter,
      insurance: contracts.insurance,
      oracle_adapter: contracts.oracleAdapter,
      liquidation: contracts.liquidation,
      risk_params: contracts.riskParams,
      timelock: contracts.timelock,
      usdc: network.usdc,
      permit2: network.permit2,
      multicall3: network.multicall3,
    },
    eip712_domain: {
      name: domain.name,
      version: domain.version,
      chainId: network.chainId,
      verifyingContract: contracts.orderGateway,
    },
    usdc_permit_domain: {
      name: USDC_PERMIT_NAME,
      version: USDC_PERMIT_VERSION,
      chainId: network.chainId,
      verifyingContract: network.usdc,
    },
    usdc_decimals: USDC_DECIMALS,
    ledger_decimals: LEDGER_DECIMALS,
    price_precision: (10n ** 18n).toString(),
    amount_precision: (10n ** 18n).toString(),
  };
}
