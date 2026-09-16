#!/usr/bin/env tsx
/**
 * Upgrade a deployment's contracts in place to the current build.
 *
 * `upgrade()` replaces a contract's WASM while keeping its address, its
 * storage and every peer address wired to it. Nothing migrates: positions,
 * balances, funding indexes and order tombstones all survive. That makes an
 * in-place upgrade strictly safer than redeploying, because redeploying means
 * new addresses in every config and keeper env at once — and when the web tier
 * briefly pointed at one contract set while the keepers ran another, deposits
 * landed in a vault no matcher was watching and one settle job retried 356
 * times.
 *
 * Not every deployment can do this. A contract built without an `upgrade`
 * entrypoint is frozen forever; mainnet is in exactly that state. This script
 * checks and says so rather than failing obscurely.
 *
 * Reads the contract addresses from a deployment state file, so it cannot
 * drift from what was actually deployed.
 *
 * DRY RUN BY DEFAULT. Nothing is submitted without `--execute`.
 *
 * Usage:
 *   DEPLOY_STATE_PATH=../kryon-protocol/infra/deploy/testnet-deployment-v3.json \
 *   PROTOCOL_ADMIN_SECRET=S... npx tsx scripts/upgrade-contracts.ts
 *
 *   ... --execute            actually submit
 *   ... --only=perp_engine   restrict to one contract (repeatable)
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  Account,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { NETWORK } from "../config";
import { assertNoPublicSecretLeak, assertRequiredSecrets } from "../lib/secrets-check";
import { contractExports, missingLifecycleExports } from "../lib/deploy-preflight";

assertRequiredSecrets(["PROTOCOL_ADMIN_SECRET", "DEPLOY_STATE_PATH"]);
assertNoPublicSecretLeak();

const FEE = "40000000";
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const ONLY = args.filter((a) => a.startsWith("--only=")).map((a) => a.split("=")[1]);

const ARTIFACTS = path.resolve(
  process.env.ARTIFACTS_DIR ??
    "../kryon-protocol/target/wasm32v1-none/release/deploy"
);

const server = new sorobanRpc.Server(NETWORK.rpcUrl);
const admin = Keypair.fromSecret(process.env.PROTOCOL_ADMIN_SECRET as string);

interface DeploymentState {
  contracts: Record<string, string>;
}

let simSeq = 100;

/** Does this deployed contract expose `upgrade`? */
async function isUpgradeable(contractId: string): Promise<boolean> {
  const tx = new TransactionBuilder(
    new Account(Keypair.random().publicKey(), (simSeq++).toString()),
    { fee: FEE, networkPassphrase: NETWORK.passphrase }
  )
    .addOperation(
      new Contract(contractId).call("upgrade", nativeToScVal(Buffer.alloc(32), { type: "bytes" }))
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!sorobanRpc.Api.isSimulationError(sim)) return true;
  // Discriminate on the error DOMAIN, not the message. Probing with an all-zero
  // wasm hash makes both outcomes say "MissingValue", meaning opposite things:
  //
  //   Error(WasmVm, MissingValue)   -> no such contract function; frozen
  //   Error(Storage, MissingValue)  -> the function ran and could not find a
  //                                    code entry for the zero hash; upgradeable
  //
  // Matching on "MissingValue" alone reported every upgradeable contract as
  // frozen, which is the more dangerous direction: it would have sent a healthy
  // deployment down the redeploy-and-migrate path for no reason.
  return !sim.error.includes("Error(WasmVm,");
}

async function confirm(hash: string, label: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    const got = await server.getTransaction(hash);
    if (got.status === "SUCCESS") return hash;
    if (got.status === "FAILED") throw new Error(`${label} failed on-chain: ${hash}`);
  }
  throw new Error(`${label} unconfirmed: ${hash}`);
}

async function uploadWasm(wasm: Buffer, label: string): Promise<Buffer> {
  const account = await server.getAccount(admin.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) throw new Error(`upload ${label}: ${sim.error.split("\n")[0]}`);

  // Simulation already tells us the hash, so a dry run reports the real value.
  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  if (!EXECUTE) {
    const retval = (sim as sorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    return Buffer.from(scValToNative(retval as xdr.ScVal) as Buffer);
  }
  prepared.sign(admin);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`upload ${label} rejected`);
  await confirm(sent.hash, `upload ${label}`);
  const got = await server.getTransaction(sent.hash);
  return Buffer.from(scValToNative((got as sorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue as xdr.ScVal) as Buffer);
}

async function upgrade(contractId: string, wasmHash: Buffer, label: string): Promise<string> {
  const account = await server.getAccount(admin.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(
      new Contract(contractId).call("upgrade", nativeToScVal(wasmHash, { type: "bytes" }))
    )
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) throw new Error(`${label}: ${sim.error.split("\n")[0]}`);
  if (!EXECUTE) return "(dry run — not submitted)";
  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(admin);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`${label} rejected: ${sent.errorResult?.toXDR("base64")}`);
  return confirm(sent.hash, label);
}

async function main(): Promise<void> {
  const statePath = path.resolve(process.env.DEPLOY_STATE_PATH as string);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as DeploymentState;
  const names = Object.keys(state.contracts).filter((n) => ONLY.length === 0 || ONLY.includes(n));

  console.log(`Contract upgrade — ${NETWORK.name}`);
  console.log(`  state  ${statePath}`);
  console.log(`  admin  ${admin.publicKey()}`);
  console.log(`  mode   ${EXECUTE ? "⚠ EXECUTE — transactions WILL be submitted" : "dry run"}\n`);

  console.log("── preflight ──────────────────────────────────────────");
  const plan: Array<{ name: string; id: string; wasm: Buffer }> = [];
  for (const name of names) {
    const id = state.contracts[name];
    const wasm = readFileSync(path.join(ARTIFACTS, `${name}.wasm`));

    const missing = missingLifecycleExports(contractExports(wasm));
    if (missing.length) {
      throw new Error(`${name}: the NEW artifact is missing ${missing.join(", ")} — refusing to install a build that cannot itself be upgraded`);
    }
    if (!(await isUpgradeable(id))) {
      console.log(`  ✗ ${name.padEnd(20)} deployed build has no upgrade() — frozen, skipping`);
      continue;
    }
    console.log(`  ✓ ${name.padEnd(20)} upgradeable`);
    plan.push({ name, id, wasm });
  }

  if (plan.length === 0) {
    throw new Error("nothing upgradeable in this deployment — it must be redeployed and its state migrated");
  }

  console.log(`\n── upgrading ${plan.length} contract(s) ─────────────────────────`);
  for (const { name, id, wasm } of plan) {
    const hash = await uploadWasm(wasm, name);
    const tx = await upgrade(id, hash, `${name}.upgrade`);
    console.log(`  ${name.padEnd(20)} ${hash.toString("hex").slice(0, 16)}…  ${tx}`);
  }

  console.log(
    EXECUTE
      ? "\n  Done. Re-tune per-market funding config next: `imbalance_coeff` is now\n" +
        "  premium sensitivity, not open-interest-imbalance sensitivity."
      : "\n  Dry run only. Re-run with --execute to submit."
  );
}

main().catch((e) => {
  console.error(`\n❌ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
