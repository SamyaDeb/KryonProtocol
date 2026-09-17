/**
 * Typed contract bindings over the ABIs generated from kryon-protocol/evm
 * (`npm run wagmi:generate` → generated.ts). Server-side and client-side safe.
 */

import { getContract, type Abi, type AbiItem, type Address, type Client } from "viem";

import {
  engineAbi,
  feeRouterAbi,
  insuranceAbi,
  kryonErrorsAbi,
  kryonTimelockAbi,
  liquidationAbi,
  oracleAdapterAbi,
  orderGatewayAbi,
  riskParamsAbi,
  vaultAbi,
} from "./generated";
import type { ProtocolContracts } from "./networks";

export {
  engineAbi,
  feeRouterAbi,
  insuranceAbi,
  kryonErrorsAbi,
  kryonTimelockAbi,
  liquidationAbi,
  oracleAdapterAbi,
  orderGatewayAbi,
  riskParamsAbi,
  vaultAbi,
};

export function kryonContracts(client: Client, addresses: ProtocolContracts) {
  const at = <const TAbi extends Abi>(abi: TAbi, address: Address) => getContract({ abi, address, client });
  return {
    vault: at(vaultAbi, addresses.vault),
    engine: at(engineAbi, addresses.engine),
    orderGateway: at(orderGatewayAbi, addresses.orderGateway),
    oracleAdapter: at(oracleAdapterAbi, addresses.oracleAdapter),
    liquidation: at(liquidationAbi, addresses.liquidation),
    insurance: at(insuranceAbi, addresses.insurance),
    riskParams: at(riskParamsAbi, addresses.riskParams),
    feeRouter: at(feeRouterAbi, addresses.feeRouter),
    timelock: at(kryonTimelockAbi, addresses.timelock),
  };
}

export type KryonContracts = ReturnType<typeof kryonContracts>;

/**
 * Every custom error any Kryon contract can raise (protocol errors plus the
 * OpenZeppelin errors compiled into each ABI), deduplicated by signature.
 * Used to decode `FillRejected.reason` and failed simulations.
 */
export const ALL_ERRORS_ABI: AbiItem[] = (() => {
  const seen = new Map<string, AbiItem>();
  const abis: Abi[] = [
    kryonErrorsAbi,
    vaultAbi,
    engineAbi,
    orderGatewayAbi,
    oracleAdapterAbi,
    liquidationAbi,
    insuranceAbi,
    riskParamsAbi,
    feeRouterAbi,
    kryonTimelockAbi,
  ];
  for (const abi of abis) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const key = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (!seen.has(key)) seen.set(key, item);
    }
  }
  return [...seen.values()];
})();
