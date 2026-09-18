/**
 * Local arc-anvil harness for the keeper drills and the end-to-end gate.
 *
 * LOCAL ONLY. Every entry point refuses a non-loopback RPC: the drills fund
 * accounts, impersonate the timelock and move chain time, and pointed at a
 * public network by mistake they would try to do that for real.
 *
 * Boots arc-anvil, deploys Kryon with the arc-local config (the same
 * `DeployAll` the matcher E2E uses), and exposes the handful of cheats the
 * drills need: time travel, impersonating the timelock for RISK_ADMIN changes,
 * and a Chainlink stand-in for the reference feed.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

import { oracleAdapterAbi, vaultAbi } from "@/lib/chain/contracts";
import { ARC_NETWORKS, contractsFromDeploymentJson, type ProtocolContracts } from "@/lib/chain/networks";

const run = promisify(execFile);

export const NETWORK = ARC_NETWORKS["arc-local"];
export const EVM_DIR = resolve(import.meta.dirname, "../../../../kryon-protocol/evm");
const DEPLOYMENT = resolve(EVM_DIR, "deployments/arc-local.json");
const MNEMONIC = "test test test test test test test test test test test junk";

/** Fees above Arc's 20 gwei floor, for the harness's own setup transactions. */
export const FEES = { maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

export const account = (index: number): HDAccount => mnemonicToAccount(MNEMONIC, { addressIndex: index });

export function privateKeyOf(a: HDAccount): Hex {
  const key = a.getHdKey().privateKey;
  if (!key) throw new Error("account has no private key");
  return `0x${Buffer.from(key).toString("hex")}`;
}

/** Well-known indices, fixed by infra/deploy/environments/arc-local.toml. */
export const ROLES = {
  deployer: account(0),
  governance: account(1),
  guardian: account(2),
  operator: account(4),
  publisher: account(5),
  fundingKeeper: account(6),
} as const;

export const roleId = (name: string): Hex => keccak256(toHex(name));

export interface LocalChain {
  rpc: string;
  client: PublicClient;
  chain: ReturnType<typeof defineChain>;
  contracts: ProtocolContracts;
  wallet(a: HDAccount): ReturnType<typeof createWalletClient>;
  /** Advance chain time and mine one block. */
  warp(seconds: number): Promise<void>;
  mine(): Promise<void>;
  now(): Promise<number>;
  /** Native balance (gas USDC, 18 decimals). Anvil only funds dev accounts 0-9. */
  setBalance(who: Address, wei: bigint): Promise<void>;
  /** Send a transaction from any address (the timelock, the insurance fund). */
  asAddress(from: Address, tx: { to: Address; data: Hex }): Promise<void>;
  /** The timelock, which holds RISK_ADMIN_ROLE after handover. */
  timelock(): Promise<Address>;
  deployMockAggregator(decimals: number): Promise<Address>;
  stop(): void;
}

export function assertLocal(rpc: string) {
  const host = new URL(rpc).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`the keeper drills only run against a local node; got ${rpc}`);
  }
}

export async function startLocalChain(opts: { port?: number; blockTime?: number; log?: (m: string) => void } = {}): Promise<LocalChain> {
  const port = opts.port ?? Number(process.env.KRYON_E2E_RPC_PORT ?? "8545");
  const rpc = `http://127.0.0.1:${port}`;
  assertLocal(rpc);
  const log = opts.log ?? (() => {});

  const chain = defineChain({
    id: NETWORK.chainId,
    name: NETWORK.label,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    contracts: { multicall3: { address: NETWORK.multicall3 } },
  });

  const args = ["--chain-id", String(NETWORK.chainId), "--port", String(port), "--silent"];
  if (opts.blockTime) args.push("--block-time", String(opts.blockTime));
  const proc: ChildProcess = spawn("arc-anvil", args, { stdio: ["ignore", "ignore", "pipe"] });
  proc.stderr?.on("data", (d) => process.stderr.write(`anvil: ${d}`));
  const client = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      if ((await client.getChainId()) !== NETWORK.chainId) throw new Error("wrong chain");
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!up) {
    proc.kill();
    throw new Error("arc-anvil did not come up");
  }
  log(`anvil up on ${rpc}`);

  await run(
    "arc-forge",
    [
      "script",
      "script/DeployAll.s.sol:DeployAll",
      "--rpc-url",
      rpc,
      "--broadcast",
      "--skip-simulation",
      "--with-gas-price",
      "100gwei",
      "--private-key",
      privateKeyOf(ROLES.deployer),
    ],
    { cwd: EVM_DIR, env: { ...process.env, KRYON_NETWORK: NETWORK.id }, maxBuffer: 64 * 1024 * 1024 }
  );
  const contracts = contractsFromDeploymentJson(readFileSync(DEPLOYMENT, "utf8"), NETWORK.chainId);
  log(`deployed; oracle ${contracts.oracleAdapter}`);

  const rpcCall = (method: string, params: unknown[] = []) => client.request({ method, params } as never);
  const wallet = (a: HDAccount) => createWalletClient({ account: a, chain, transport: http(rpc) });

  return {
    rpc,
    client,
    chain,
    contracts,
    wallet,
    async warp(seconds) {
      await rpcCall("evm_increaseTime", [seconds]);
      await rpcCall("evm_mine");
    },
    async mine() {
      await rpcCall("evm_mine");
    },
    async now() {
      return Number((await client.getBlock({ blockTag: "latest" })).timestamp);
    },
    async setBalance(who, wei) {
      await rpcCall("anvil_setBalance", [who, toHex(wei)]);
    },
    async asAddress(from, tx) {
      await rpcCall("anvil_impersonateAccount", [from]);
      await rpcCall("anvil_setBalance", [from, "0x3635C9ADC5DEA00000"]);
      const w = createWalletClient({ account: from, chain, transport: http(rpc) });
      const hash = await w.sendTransaction({ account: from, chain, to: tx.to, data: tx.data, ...FEES });
      const r = await client.waitForTransactionReceipt({ hash });
      await rpcCall("anvil_stopImpersonatingAccount", [from]);
      if (r.status !== "success") throw new Error(`impersonated call from ${from} reverted`);
    },
    async timelock() {
      return (await client.readContract({
        address: contracts.oracleAdapter,
        abi: oracleAdapterAbi,
        functionName: "getRoleMember",
        args: [roleId("RISK_ADMIN_ROLE"), 0n],
      })) as Address;
    },
    async deployMockAggregator(decimals) {
      // DeployAll does not compile test/, so build and deploy the mock in one go.
      const { stdout } = await run(
        "arc-forge",
        [
          "create",
          "test/mocks/MockAggregator.sol:MockAggregator",
          "--rpc-url",
          rpc,
          "--private-key",
          privateKeyOf(ROLES.deployer),
          "--gas-price",
          "100gwei",
          "--broadcast",
          "--constructor-args",
          String(decimals),
        ],
        { cwd: EVM_DIR, maxBuffer: 64 * 1024 * 1024 }
      );
      const m = /Deployed to:\s*(0x[0-9a-fA-F]{40})/.exec(stdout);
      if (!m) throw new Error(`MockAggregator deploy failed:\n${stdout.slice(-500)}`);
      return m[1] as Address;
    },
    stop() {
      if (!process.env.KRYON_E2E_KEEP_ANVIL) proc.kill();
    },
  };
}

export const mockAggregatorAbi = [
  {
    type: "function",
    name: "set",
    stateMutability: "nonpayable",
    inputs: [{ type: "int256" }, { type: "uint256" }],
    outputs: [],
  },
] as const;

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Approve and deposit `usdc6` (6-decimal USDC) into the vault for `who`. */
export async function depositUsdc(lc: LocalChain, who: HDAccount, usdc6: bigint) {
  const w = lc.wallet(who);
  const a = await w.writeContract({
    address: NETWORK.usdc,
    abi: erc20ApproveAbi,
    functionName: "approve",
    args: [lc.contracts.vault, usdc6],
    chain: lc.chain,
    account: who,
    ...FEES,
  });
  await lc.client.waitForTransactionReceipt({ hash: a });
  const d = await w.writeContract({
    address: lc.contracts.vault,
    abi: vaultAbi,
    functionName: "deposit",
    args: [usdc6],
    chain: lc.chain,
    account: who,
    ...FEES,
  });
  const r = await lc.client.waitForTransactionReceipt({ hash: d });
  if (r.status !== "success") throw new Error(`deposit for ${who.address} reverted`);
}

/** Scenario reporter shared by the drills: ✓/✗ lines and a failure count. */
export function reporter(out: (s: string) => void = (s) => process.stdout.write(`${s}\n`)) {
  let failures = 0;
  return {
    step(msg: string) {
      out(`\n── ${msg} ${"─".repeat(Math.max(0, 66 - msg.length))}`);
    },
    check(name: string, ok: boolean, detail = "") {
      if (ok) out(`  ✓ ${name}`);
      else {
        failures += 1;
        out(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
      }
    },
    note(msg: string) {
      out(`    ${msg}`);
    },
    get failures() {
      return failures;
    },
  };
}
