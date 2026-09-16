#!/usr/bin/env tsx
/**
 * Admin → Governance transfer ceremony (P0.2).
 *
 * Moves the admin role of every core contract from the deployer EOA to the
 * perp-governance contract (48h-timelocked). Three phases, run in order:
 *
 *   1. nominate  — EOA admin calls nominate_admin(governance) on each contract.
 *   2. queue     — queue an accept_admin proposal per contract on governance
 *                  (ETA = now + min_delay + 10 min margin).
 *   3. execute   — after the timelock matures, execute each proposal.
 *                  Governance invokes accept_admin on the target; invoker auth
 *                  satisfies the target's next_admin.require_auth().
 *
 * After phase 3, verify: every privileged setter fails when called by the EOA,
 * and only works through a governance proposal. THERE IS NO UNDO without a
 * governance proposal nominating a new admin — quadruple-check the governance
 * contract address and its admin/guardian keys before phase 1.
 *
 * Usage:
 *   ADMIN_SECRET=S... npx tsx scripts/transfer-admin-to-governance.ts nominate
 *   ADMIN_SECRET=S... npx tsx scripts/transfer-admin-to-governance.ts queue
 *   ADMIN_SECRET=S... npx tsx scripts/transfer-admin-to-governance.ts execute
 */

import { createHash } from "node:crypto";
import {
  Keypair,
  Contract,
  TransactionBuilder,
  Address,
  nativeToScVal,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK } from "../config";

const FEE = "1000000";
// 10 min beyond the on-chain minimum so clock skew can't invalidate the queue.
const ETA_MARGIN_SECS = 600;

const TARGETS: Array<[name: string, contractId: string]> = [
  ["oracle-adapter", CONTRACTS.oracleAdapter],
  ["vault", CONTRACTS.vault],
  ["engine", CONTRACTS.engine],
  ["order-gateway", CONTRACTS.orderGateway],
  ["liquidation", CONTRACTS.liquidation],
  ["insurance", CONTRACTS.insurance],
];

function proposalId(contractId: string): Buffer {
  return createHash("sha256").update(`accept_admin|${contractId}|${NETWORK.name}`).digest();
}

async function submit(
  server: sorobanRpc.Server,
  kp: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<string> {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`${method} sim failed: ${sim.error?.slice(0, 200)}`);
  }
  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") {
    throw new Error(`${method} submit failed: ${send.errorResult?.toXDR("base64")?.slice(0, 120)}`);
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") return send.hash;
    if (poll.status === "FAILED") throw new Error(`${method} tx failed on-chain (${send.hash})`);
  }
  throw new Error(`${method} confirmation timeout (${send.hash})`);
}

async function readMinDelay(server: sorobanRpc.Server): Promise<bigint> {
  // MinDelay isn't exposed as a getter; assume the contract-enforced minimum.
  // Override with GOVERNANCE_MIN_DELAY_SECS if governance was initialized higher.
  return BigInt(process.env.GOVERNANCE_MIN_DELAY_SECS ?? String(172_800));
}

async function main() {
  const phase = process.argv[2];
  if (!["nominate", "queue", "execute"].includes(phase ?? "")) {
    console.error("usage: transfer-admin-to-governance.ts <nominate|queue|execute>");
    process.exit(1);
  }
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    console.error("ADMIN_SECRET (current EOA admin, also governance admin) is required");
    process.exit(1);
  }
  const kp = Keypair.fromSecret(secret);
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const governance = CONTRACTS.governance;

  console.log(`Phase      : ${phase}`);
  console.log(`Network    : ${NETWORK.name}`);
  console.log(`Admin key  : ${kp.publicKey()}`);
  console.log(`Governance : ${governance}`);
  if (NETWORK.name === "mainnet") {
    console.log("\n*** MAINNET CEREMONY — verify the governance address and its admin/guardian before continuing. Ctrl-C now if unsure. ***\n");
    await new Promise((r) => setTimeout(r, 10_000));
  }

  if (phase === "nominate") {
    for (const [name, contractId] of TARGETS) {
      const hash = await submit(server, kp, contractId, "nominate_admin", [
        new Address(governance).toScVal(),
      ]);
      console.log(`  ✓ nominated governance as admin of ${name} (${hash.slice(0, 12)}...)`);
    }
    console.log("\nNext: run the `queue` phase.");
    return;
  }

  if (phase === "queue") {
    const minDelay = await readMinDelay(server);
    const eta = BigInt(Math.floor(Date.now() / 1000)) + minDelay + BigInt(ETA_MARGIN_SECS);
    for (const [name, contractId] of TARGETS) {
      const hash = await submit(server, kp, governance, "queue", [
        xdr.ScVal.scvBytes(proposalId(contractId)),
        new Address(contractId).toScVal(),
        nativeToScVal("accept_admin", { type: "symbol" }),
        xdr.ScVal.scvVec([]),
        xdr.ScVal.scvBytes(Buffer.alloc(32)),
        nativeToScVal(eta, { type: "u64" }),
      ]);
      console.log(`  ✓ queued accept_admin for ${name}, eta=${eta} (${hash.slice(0, 12)}...)`);
    }
    console.log(`\nNext: wait until ${new Date(Number(eta) * 1000).toISOString()}, then run the \`execute\` phase.`);
    return;
  }

  // execute
  for (const [name, contractId] of TARGETS) {
    try {
      const hash = await submit(server, kp, governance, "execute", [
        xdr.ScVal.scvBytes(proposalId(contractId)),
      ]);
      console.log(`  ✓ governance accepted admin of ${name} (${hash.slice(0, 12)}...)`);
    } catch (e) {
      console.error(`  ✗ ${name}: ${(e as Error).message}`);
    }
  }
  console.log("\nVerify: direct EOA admin calls on each contract must now fail; all admin ops go through governance proposals.");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
