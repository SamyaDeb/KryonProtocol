#!/usr/bin/env tsx
/**
 * verify-decentralization.ts — post-ceremony proof that the deployer EOA has
 * zero privileged power, plus a guardian-veto pause drill on governance.
 *
 * Run AFTER `transfer-admin-to-governance.ts execute` (timelock permitting):
 *
 *   ADMIN_SECRET=S... npx tsx --env-file=.env.local scripts/verify-decentralization.ts
 *
 * Checks per contract (simulation only — nothing is submitted on-chain
 * except the governance pause/unpause drill):
 *   1. An EOA-signed admin call (nominate_admin to self) must FAIL simulation.
 *   2. The governance guardian can emergency_pause + unpause governance
 *      (the execution-veto fast path).
 *
 * Exit code 0 = fully decentralized; 1 = at least one contract still obeys
 * the EOA (ceremony incomplete — DO NOT proceed to mainnet steps).
 */

import {
  Keypair,
  Contract,
  TransactionBuilder,
  Address,
  rpc as sorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK } from "../config";

const FEE = "1000000";

const TARGETS: Array<[string, string]> = [
  ["oracle-adapter", CONTRACTS.oracleAdapter],
  ["vault", CONTRACTS.vault],
  ["engine", CONTRACTS.engine],
  ["order-gateway", CONTRACTS.orderGateway],
  ["liquidation", CONTRACTS.liquidation],
  ["insurance", CONTRACTS.insurance],
];

async function simulateAsEoa(
  server: sorobanRpc.Server,
  kp: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<{ ok: boolean; error?: string }> {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    return { ok: false, error: sim.error?.slice(0, 120) };
  }
  return { ok: true };
}

async function submit(
  server: sorobanRpc.Server,
  kp: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<void> {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) throw new Error(sim.error?.slice(0, 160));
  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") throw new Error("submit rejected");
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") return;
    if (poll.status === "FAILED") throw new Error("tx failed");
  }
  throw new Error("confirmation timeout");
}

async function main() {
  const secret = process.env.ADMIN_SECRET ?? process.env.ORACLE_PUBLISHER_SECRET;
  if (!secret) throw new Error("ADMIN_SECRET required (the FORMER admin EOA)");
  const kp = Keypair.fromSecret(secret);
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const self = new Address(kp.publicKey()).toScVal();

  console.log(`Verifying decentralization on ${NETWORK.name}`);
  console.log(`Former admin EOA: ${kp.publicKey()}\n`);

  let stillCentralized = 0;
  for (const [name, contractId] of TARGETS) {
    const res = await simulateAsEoa(server, kp, contractId, "nominate_admin", [self]);
    if (res.ok) {
      console.log(`  ✗ ${name}: EOA CAN STILL nominate_admin — ceremony incomplete!`);
      stillCentralized++;
    } else {
      console.log(`  ✓ ${name}: EOA admin call rejected (${res.error?.slice(0, 60) ?? "unauthorized"})`);
    }
  }

  // Guardian veto drill on governance itself (guardian = this key on testnet).
  console.log("\nGuardian pause drill (governance execution veto):");
  try {
    await submit(server, kp, CONTRACTS.governance, "emergency_pause", [xdr.ScVal.scvBool(true)]);
    console.log("  ✓ guardian paused governance (proposal execution now vetoed)");
    await submit(server, kp, CONTRACTS.governance, "emergency_pause", [xdr.ScVal.scvBool(false)]);
    console.log("  ✓ guardian unpaused governance");
  } catch (e) {
    console.log(`  ✗ pause drill failed: ${(e as Error).message}`);
    stillCentralized++;
  }

  if (stillCentralized > 0) {
    console.log(`\n✗ ${stillCentralized} check(s) failed — NOT fully decentralized.`);
    process.exit(1);
  }
  console.log("\n✓ Fully decentralized: EOA has no privileged power; guardian veto works.");
}

main().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
