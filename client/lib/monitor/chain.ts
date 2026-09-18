/**
 * Everything the monitor reads from Arc, behind one interface so the checks
 * can be tested against fixed inputs and the drill can point it at arc-anvil.
 *
 * READ-ONLY BY CONSTRUCTION. The viem implementation takes a client that can
 * only `readContract`, `multicall`, `getBlock`, `getBalance`,
 * `getTransactionCount`, `getStorageAt` and `getCode`. There is no wallet, no
 * key and no send method anywhere in this module, so the monitor cannot put a
 * transaction on chain even by mistake.
 */

import { hexToString, keccak256, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";

import {
  engineAbi,
  feeRouterAbi,
  insuranceAbi,
  liquidationAbi,
  oracleAdapterAbi,
  orderGatewayAbi,
  riskParamsAbi,
  vaultAbi,
} from "@/lib/chain/contracts";
import { readAccountHealth, readDepositCaps, type AccountHealth } from "@/lib/chain/collateral";
import type { ProtocolContracts } from "@/lib/chain/networks";
import { decodeError } from "@/lib/keepers/reverts";
import { viemOracleChain } from "@/lib/oracle/chain";
import type { OracleState } from "@/lib/oracle/publisher";

import { IMPL_SLOT, PROXY_KEYS, roleId, rolesFor, type RoleContractKey, type RoleMembership } from "./roles";

export interface ChainHead {
  number: bigint;
  /** Block timestamp: the clock every on-chain age is measured against. */
  timestamp: number;
}

export interface MarketState {
  marketId: number;
  /** `bytes32("BTC")` → "BTC". */
  symbol: string;
  oracleId: Hex;
  active: boolean;
  listed: boolean;
  /** The bound Engine passes to `getPrice`; 0 means the feed's own maxAge. */
  maxOracleAge: number;
  /** 1e18 size. */
  longOi: bigint;
  shortOi: bigint;
  /** 1e18; null when `indexPrice` reverts (a stale or missing price). */
  indexPrice: bigint | null;
  /**
   * `Engine.fundingState().lastUpdate`, unix seconds; 0 before the first
   * update. This is what the contract accrues from, so it — not an indexed
   * event — is what funding freshness is measured against.
   */
  fundingLastUpdate: number;
}

export interface InsuranceState {
  /** null when it cannot be priced (StaleOracle): blocked, never zero. */
  unfundedShortfall: bigint | null;
  marked: bigint;
  priced: boolean;
  badDebt: bigint;
}

export interface MonitorChain {
  head(): Promise<ChainHead>;
  blockTimestamp(n: bigint): Promise<number>;
  solvency(): Promise<{ assets: bigint; liabilities: bigint }>;
  insurance(): Promise<InsuranceState>;
  depositCaps(): Promise<{ totalCap: bigint; perAccountCap: bigint; totalDeposited: bigint }>;
  paused(): Promise<Record<string, boolean>>;
  markets(): Promise<MarketState[]>;
  oracle(): Promise<OracleState>;
  roleMembers(): Promise<RoleMembership>;
  /** proxy (lowercase) → implementation and its runtime code hash. */
  implementations(): Promise<Map<string, { implementation: string; codeHash: string | null }>>;
  balances(addresses: readonly Address[]): Promise<Map<string, bigint>>;
  /** Nonce of the next transaction each address can mine. */
  nonces(addresses: readonly Address[]): Promise<Map<string, number>>;
  accountHealth(accounts: readonly Address[], batchSize?: number): Promise<Map<Address, AccountHealth | null>>;
}

type Reader = Pick<
  PublicClient,
  "readContract" | "multicall" | "getBlock" | "getBalance" | "getTransactionCount" | "getStorageAt" | "getCode" | "call"
>;

const roleAbi = parseAbi(["function getRoleMembers(bytes32 role) view returns (address[])"]);

const PAUSABLE: Partial<Record<keyof ProtocolContracts, readonly unknown[]>> = {
  vault: vaultAbi,
  engine: engineAbi,
  orderGateway: orderGatewayAbi,
  oracleAdapter: oracleAdapterAbi,
  liquidation: liquidationAbi,
  insurance: insuranceAbi,
  feeRouter: feeRouterAbi,
};

export function symbolOfId(id: Hex): string {
  return hexToString(id, { size: 32 }).replace(/\0+$/, "");
}

export function viemMonitorChain(client: Reader, contracts: ProtocolContracts): MonitorChain {
  const read = <T>(address: Address, abi: unknown, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  // `self` is only used by the publisher's simulate(), which the monitor never calls.
  const oracleChain = viemOracleChain({ client, oracle: contracts.oracleAdapter, self: zeroAddress });

  return {
    async head() {
      const b = await client.getBlock({ blockTag: "latest" });
      return { number: b.number, timestamp: Number(b.timestamp) };
    },

    async blockTimestamp(n) {
      return Number((await client.getBlock({ blockNumber: n })).timestamp);
    },

    async solvency() {
      const [assets, liabilities] = await read<[bigint, bigint]>(contracts.vault, vaultAbi, "solvency");
      return { assets, liabilities };
    },

    async insurance() {
      const [marked, badDebt] = await client.multicall({
        allowFailure: false,
        contracts: [
          { address: contracts.insurance, abi: insuranceAbi, functionName: "markedOperatingBalance" },
          { address: contracts.insurance, abi: insuranceAbi, functionName: "badDebt" },
        ],
      });
      let unfundedShortfall: bigint | null;
      try {
        unfundedShortfall = await read<bigint>(contracts.insurance, insuranceAbi, "unfundedShortfall");
      } catch (err) {
        // StaleOracle: the backstop cannot be priced. That is "unknown", which
        // the check reports as blocked; it is never read as zero.
        if (decodeError(err).errorName !== "StaleOracle" && !/StaleOracle/.test(String(err))) throw err;
        unfundedShortfall = null;
      }
      const [m, priced] = marked as readonly [bigint, boolean];
      return { unfundedShortfall, marked: m, priced, badDebt: badDebt as bigint };
    },

    depositCaps: () => readDepositCaps(client, contracts.vault),

    async paused() {
      const keys = Object.keys(PAUSABLE) as (keyof ProtocolContracts)[];
      const res = await client.multicall({
        allowFailure: false,
        contracts: keys.map((k) => ({ address: contracts[k], abi: PAUSABLE[k] as typeof vaultAbi, functionName: "paused" as const })),
      });
      return Object.fromEntries(keys.map((k, i) => [k, Boolean(res[i])]));
    },

    async markets() {
      const ids = ((await read<readonly (number | bigint)[]>(contracts.riskParams, riskParamsAbi, "marketIds")) ?? []).map(Number);
      if (ids.length === 0) return [];
      type Result = { status: "success"; result: unknown } | { status: "failure"; error: unknown };
      const res = (await client.multicall({
        allowFailure: true,
        contracts: ids.flatMap((id) => [
          { address: contracts.riskParams, abi: riskParamsAbi, functionName: "market", args: [id] },
          { address: contracts.engine, abi: engineAbi, functionName: "openInterest", args: [id] },
          { address: contracts.engine, abi: engineAbi, functionName: "indexPrice", args: [id] },
          { address: contracts.engine, abi: engineAbi, functionName: "fundingState", args: [id] },
        ]) as never,
      })) as unknown as Result[];
      const perMarket = 4;
      return ids.map((marketId, i): MarketState => {
        const m = res[i * perMarket];
        const oi = res[i * perMarket + 1];
        const px = res[i * perMarket + 2];
        const funding = res[i * perMarket + 3];
        if (m.status !== "success" || oi.status !== "success") {
          throw new Error(`market ${marketId}: riskParams.market or engine.openInterest failed`);
        }
        const p = m.result as { oracleId: Hex; active: boolean; listed: boolean; maxOracleAge: number };
        const [longOi, shortOi] = oi.result as readonly [bigint, bigint];
        return {
          marketId,
          symbol: symbolOfId(p.oracleId),
          oracleId: p.oracleId,
          active: p.active,
          listed: p.listed,
          maxOracleAge: Number(p.maxOracleAge),
          longOi,
          shortOi,
          indexPrice: px.status === "success" ? (px.result as bigint) : null,
          fundingLastUpdate:
            funding.status === "success" ? Number((funding.result as { lastUpdate: bigint }).lastUpdate) : 0,
        };
      });
    },

    oracle: () => oracleChain.readState(),

    async roleMembers() {
      const targets: { contract: RoleContractKey; role: string }[] = [];
      for (const k of [...PROXY_KEYS, "timelock"] as RoleContractKey[]) {
        for (const role of rolesFor(k)) targets.push({ contract: k, role });
      }
      const res = await client.multicall({
        allowFailure: true,
        contracts: targets.map((t) => ({
          address: contracts[t.contract],
          abi: roleAbi,
          functionName: "getRoleMembers" as const,
          args: [roleId(t.role)] as const,
        })),
      });
      const out: RoleMembership = {};
      targets.forEach((t, i) => {
        const r = res[i];
        if (r.status !== "success") throw new Error(`${t.contract}.getRoleMembers(${t.role}) failed`);
        (out[t.contract] ??= {})[t.role] = (r.result as readonly Address[]).map((a) => a.toLowerCase());
      });
      return out;
    },

    async implementations() {
      const out = new Map<string, { implementation: string; codeHash: string | null }>();
      for (const k of PROXY_KEYS) {
        const slot = await client.getStorageAt({ address: contracts[k], slot: IMPL_SLOT });
        const implementation = `0x${(slot ?? "0x").slice(-40).padStart(40, "0")}`.toLowerCase();
        const code = await client.getCode({ address: implementation as Address });
        out.set(contracts[k].toLowerCase(), {
          implementation,
          codeHash: code && code !== "0x" ? keccak256(code) : null,
        });
      }
      return out;
    },

    async balances(addresses) {
      const out = new Map<string, bigint>();
      await Promise.all(
        addresses.map(async (a) => {
          out.set(a.toLowerCase(), await client.getBalance({ address: a }));
        })
      );
      return out;
    },

    async nonces(addresses) {
      const out = new Map<string, number>();
      await Promise.all(
        addresses.map(async (a) => {
          out.set(a.toLowerCase(), await client.getTransactionCount({ address: a, blockTag: "latest" }));
        })
      );
      return out;
    },

    accountHealth: (accounts, batchSize) => readAccountHealth(client, contracts.engine, accounts, batchSize),
  };
}
