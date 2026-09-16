#!/usr/bin/env tsx
/**
 * Governance Handover — moves each core contract's admin from the deployer
 * keypair to the governance timelock.
 *
 * Why (audit KRY-S3)
 * ------------------
 * Every core contract carries the same comment above `upgrade()`:
 *
 *   "in production the admin MUST be the governance timelock, which makes an
 *    upgrade inherit its delay and cancellation window. While a plain keypair
 *    holds admin, this function turns a key compromise into total protocol
 *    takeover."
 *
 * On mainnet that handover never happened. One compromised key rewrites the
 * vault's WASM instantly, with no delay and no cancellation window. Every other
 * control in the system — the guardian pause, operator separation, oracle
 * guards — sits downstream of an admin that can replace all of it in a single
 * transaction.
 *
 * What handover buys, precisely
 * -----------------------------
 * After this runs, an upgrade must be QUEUED and then wait out the timelock
 * (48h minimum, enforced on-chain by `MIN_SAFE_DELAY_SECS`) before it can
 * execute. That window is the whole point: it is the time in which a
 * compromised proposal can be seen and cancelled, and in which users can exit.
 *
 * It does NOT make the deployer key harmless — governance itself is still
 * admin'd by that key, so the key can still queue anything. What changes is
 * that it can no longer act *instantly and silently*. Moving governance's own
 * admin to a multisig is the next step and is deliberately not automated here.
 *
 * The ordering trap
 * -----------------
 * Set the guardian on the vault and gateway BEFORE handover. The guardian is
 * the only authority that can pause without going through the timelock. Hand
 * over first and the emergency stop becomes subject to a 48-hour delay, which
 * makes it not an emergency stop. This script refuses to proceed if any
 * pausable contract has no guardian.
 *
 * Two phases, 48 hours apart
 * --------------------------
 *   phase 1 (nominate)  For each contract: `nominate_admin(governance)`, then
 *                       `governance.queue(...)` a matching `accept_admin` call.
 *   phase 2 (execute)   After the ETA: `governance.execute(id)` per proposal.
 *                       Governance becomes the direct cross-contract caller, so
 *                       the target's `require_admin` is satisfied by invoker auth.
 *
 * DRY RUN BY DEFAULT. Nothing is submitted without `--execute`.
 *
 * Usage:
 *   npx tsx scripts/governance-handover.ts --phase=nominate
 *   npx tsx scripts/governance-handover.ts --phase=nominate --execute
 *   npx tsx scripts/governance-handover.ts --phase=execute  --execute
 */

import {
  Keypair,
  Account,
  Contract,
  TransactionBuilder,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { CONTRACTS, NETWORK } from "../config";
import { assertNoPublicSecretLeak, assertRequiredSecrets } from "../lib/secrets-check";

assertRequiredSecrets(["GOVERNANCE_ADMIN_SECRET"]);
assertNoPublicSecretLeak();

const FEE = "2000000";
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const PHASE = (args.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "nominate") as
  | "nominate"
  | "execute";

if (PHASE !== "nominate" && PHASE !== "execute") {
  console.error("--phase must be 'nominate' or 'execute'");
  process.exit(1);
}

/**
 * The contracts whose admin moves to governance, and whether each one has a
 * guardian that must be set first.
 *
 * `governance` is deliberately absent: it cannot be its own admin, and moving
 * its admin to a multisig is a separate, manual decision.
 */
const TARGETS: Array<{ name: string; id: string; pausable: boolean }> = [
  { name: "vault", id: CONTRACTS.vault, pausable: true },
  { name: "engine", id: CONTRACTS.engine, pausable: false },
  { name: "orderGateway", id: CONTRACTS.orderGateway, pausable: true },
  { name: "oracleAdapter", id: CONTRACTS.oracleAdapter, pausable: false },
  { name: "liquidation", id: CONTRACTS.liquidation, pausable: false },
  { name: "insurance", id: CONTRACTS.insurance, pausable: false },
  // Advisory-only and unwired, but still admin-gated for set_market and
  // upgrade. Leaving one contract on a plain keypair while the other six sit
  // behind the timelock is the kind of gap that gets forgotten and then found
  // by someone else.
  { name: "risk", id: CONTRACTS.risk, pausable: false },
];

const server = new sorobanRpc.Server(NETWORK.rpcUrl);
const simKp = Keypair.random();
let simSeq = 100;

/** Deterministic proposal id, so phase 2 can find what phase 1 queued. */
function proposalId(contractName: string): Buffer {
  return createHash("sha256")
    .update(`kryon:handover:${NETWORK.name}:${contractName}`)
    .digest();
}

async function read(contractId: string, method: string, args: xdr.ScVal[]): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(simKp.publicKey(), (simSeq++).toString()), {
    fee: FEE,
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) return null;
  const retval = (sim as sorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return retval ? scValToNative(retval) : null;
}

async function send(
  kp: Keypair,
  contractId: string,
  method: string,
  callArgs: xdr.ScVal[]
): Promise<string> {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(new Contract(contractId).call(method, ...callArgs))
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`${method} simulation failed: ${sim.error}`);
  }
  if (!EXECUTE) return "(dry run — not submitted)";

  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`${method} rejected: ${sent.errorResult?.toXDR("base64")}`);
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const got = await server.getTransaction(sent.hash);
    if (got.status === "SUCCESS") return sent.hash;
    if (got.status === "FAILED") throw new Error(`${method} failed on-chain: ${sent.hash}`);
  }
  throw new Error(`${method} never confirmed: ${sent.hash}`);
}

/** Refuse to hand over a pausable contract that has no fast-path guardian. */
async function assertGuardiansSet(): Promise<void> {
  const missing: string[] = [];
  for (const t of TARGETS.filter((t) => t.pausable)) {
    const guardian = await read(t.id, "guardian", []);
    if (!guardian) missing.push(t.name);
    else console.log(`   guardian on ${t.name.padEnd(13)} ${guardian}`);
  }
  if (missing.length) {
    throw new Error(
      `No guardian set on: ${missing.join(", ")}.\n` +
        `   Set one BEFORE handover. After handover, pausing would have to go\n` +
        `   through the 48h timelock — which is not an emergency stop.`
    );
  }
}

async function phaseNominate(admin: Keypair): Promise<void> {
  const minDelay = Number((await read(CONTRACTS.governance, "min_delay", [])) ?? 172_800);
  // A margin over the on-chain minimum, so the ETA is still valid by the time
  // the queue transaction actually lands.
  const eta = Math.floor(Date.now() / 1000) + minDelay + 600;
  console.log(`\n   timelock ${minDelay}s — earliest execution ${new Date(eta * 1000).toISOString()}\n`);

  for (const t of TARGETS) {
    const current = await read(t.id, "admin", []);
    if (current === CONTRACTS.governance) {
      console.log(`   ${t.name.padEnd(13)} already admin'd by governance — skipping`);
      continue;
    }

    // Idempotent: a proposal id is derived from the contract name, and `queue`
    // rejects a duplicate with AlreadyInitialized. Without this check, adding a
    // single contract to TARGETS aborted the whole run on the first one that had
    // already been queued — so a partially-completed handover could not be
    // finished, only restarted from scratch.
    const existing = (await read(CONTRACTS.governance, "proposal", [
      nativeToScVal(proposalId(t.name), { type: "bytes" }),
    ])) as Record<string, unknown> | null;
    if (existing) {
      console.log(
        `   ${t.name.padEnd(13)} already queued (${String(existing.status)}, eta ${String(existing.eta)}) — skipping`
      );
      continue;
    }

    console.log(`   ${t.name.padEnd(13)} nominate_admin(governance)`);
    await send(admin, t.id, "nominate_admin", [new Address(CONTRACTS.governance).toScVal()]);

    console.log(`   ${t.name.padEnd(13)} queue accept_admin  eta=${eta}`);
    await send(admin, CONTRACTS.governance, "queue", [
      nativeToScVal(proposalId(t.name), { type: "bytes" }),
      new Address(t.id).toScVal(),
      nativeToScVal("accept_admin", { type: "symbol" }),
      nativeToScVal([], { type: "vec" }),
      nativeToScVal(Buffer.alloc(32), { type: "bytes" }),
      nativeToScVal(eta, { type: "u64" }),
    ]);
  }

  console.log(
    `\n   Phase 1 complete. Re-run with --phase=execute --execute after ${new Date(
      eta * 1000
    ).toISOString()}.`
  );
}

async function phaseExecute(admin: Keypair): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let ready = 0;

  for (const t of TARGETS) {
    const current = await read(t.id, "admin", []);
    if (current === CONTRACTS.governance) {
      console.log(`   ${t.name.padEnd(13)} ✓ governance is already admin`);
      continue;
    }

    const id = proposalId(t.name);
    const proposal = (await read(CONTRACTS.governance, "proposal", [
      nativeToScVal(id, { type: "bytes" }),
    ])) as Record<string, unknown> | null;

    if (!proposal) {
      console.log(`   ${t.name.padEnd(13)} ✗ no queued proposal — run --phase=nominate first`);
      continue;
    }
    const eta = Number(proposal.eta ?? 0);
    if (now < eta) {
      const hours = ((eta - now) / 3600).toFixed(1);
      console.log(`   ${t.name.padEnd(13)} ⏳ ${hours}h remaining on the timelock`);
      continue;
    }

    console.log(`   ${t.name.padEnd(13)} execute → governance becomes admin`);
    await send(admin, CONTRACTS.governance, "execute", [nativeToScVal(id, { type: "bytes" })]);
    ready++;
  }

  if (ready > 0 && EXECUTE) {
    console.log(`\n   ${ready} contract(s) handed over. Verify with --phase=execute (dry run).`);
  }
}

async function main(): Promise<void> {
  const admin = Keypair.fromSecret(process.env.GOVERNANCE_ADMIN_SECRET as string);

  console.log(`Governance handover — ${NETWORK.name}`);
  console.log(`  governance ${CONTRACTS.governance}`);
  console.log(`  signer     ${admin.publicKey()}`);
  console.log(`  phase      ${PHASE}`);
  console.log(`  mode       ${EXECUTE ? "⚠ EXECUTE — transactions WILL be submitted" : "dry run"}`);

  if (EXECUTE && NETWORK.name === "mainnet") {
    console.log(
      `\n  ⚠  This is MAINNET and it is irreversible: after handover the deployer\n` +
        `     key can no longer act on these contracts directly, only through a\n` +
        `     48-hour timelock. Confirm the governance address above is correct\n` +
        `     and that you can still sign as governance admin.\n`
    );
    console.log("  Proceeding in 10s — Ctrl-C to abort.");
    await new Promise((r) => setTimeout(r, 10_000));
  }

  console.log("\n── preflight: guardians ─────────────────────────────────────");
  await assertGuardiansSet();

  console.log(`\n── phase: ${PHASE} ──────────────────────────────────────────`);
  if (PHASE === "nominate") await phaseNominate(admin);
  else await phaseExecute(admin);

  if (!EXECUTE) {
    console.log("\n  Dry run only. Re-run with --execute to submit.");
  }
}

main().catch((e) => {
  console.error(`\n❌ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
