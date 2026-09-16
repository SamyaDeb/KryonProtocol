#!/usr/bin/env tsx
/**
 * rewire-liquidation.ts — initialize + wire fresh perp-liquidation and
 * perp-insurance instances against the CURRENT core (engine/vault), seed the
 * insurance fund, and enroll both in the governance admin ceremony.
 *
 * Fixes the P0 class of failure found in the 2026-07-05 stress test: a
 * liquidation contract silently pointing at superseded core instances means
 * NO liquidation is possible and every underwater position becomes bad debt.
 *
 * Usage:
 *   NEW_LIQUIDATION=C... NEW_INSURANCE=C... \
 *     npx tsx --env-file=.env.local scripts/rewire-liquidation.ts
 *
 * Optional env:
 *   INSURANCE_SEED_UNITS   USDC stroops (7 dp) to seed, default 5e9 (=500 USDC)
 *   MAX_REWARD_BPS         liquidator reward cap, default 50
 *   SKIP_GOVERNANCE=1      skip nominate/queue (e.g. governance not deployed)
 *
 * The oracle keeper shares this key — STOP it before running, restart after.
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
import { ASSETS, CONTRACTS, NETWORK } from "../config";

const FEE = "2000000";
const ETA_MARGIN_SECS = 600;

const LIQ = process.env.NEW_LIQUIDATION ?? "";
const INS = process.env.NEW_INSURANCE ?? "";
const SEED = BigInt(process.env.INSURANCE_SEED_UNITS ?? "5000000000"); // 500 USDC
const MAX_REWARD_BPS = Number(process.env.MAX_REWARD_BPS ?? "50");

function addr(a: string): xdr.ScVal {
  return new Address(a).toScVal();
}

async function call(
  server: sorobanRpc.Server,
  kp: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  label: string,
  allowFail = false
): Promise<boolean> {
  process.stdout.write(`  [${label}]...`);
  // All wiring calls are idempotent setters — retry transient RPC failures
  // (timeouts, TxBadSeq) but surface deterministic contract errors at once.
  let lastErr = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const account = await server.getAccount(kp.publicKey());
      const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(90)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (sorobanRpc.Api.isSimulationError(sim)) {
        // Deterministic — retrying cannot help.
        const msg = `sim: ${sim.error?.slice(0, 160)}`;
        process.stdout.write(` ✗ ${msg}\n`);
        if (!allowFail) throw new Error(msg);
        return false;
      }
      const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
      prepared.sign(kp);
      const send = await server.sendTransaction(prepared);
      if (send.status === "ERROR") throw new Error("submit rejected");
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await server.getTransaction(send.hash);
        if (poll.status === "SUCCESS") {
          process.stdout.write(" ✓\n");
          return true;
        }
        if (poll.status === "FAILED") throw new Error("tx failed on-chain");
      }
      throw new Error("confirmation timeout");
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt < 4) {
        process.stdout.write(` [retry ${attempt}: ${lastErr.slice(0, 60)}]`);
        await new Promise((r) => setTimeout(r, 20_000));
      }
    }
  }
  process.stdout.write(` ✗ ${lastErr}\n`);
  if (!allowFail) throw new Error(lastErr);
  return false;
}

async function enrollGovernance(server: sorobanRpc.Server, kp: Keypair) {
  const gov = CONTRACTS.governance;
  const minDelay = BigInt(process.env.GOVERNANCE_MIN_DELAY_SECS ?? String(172_800));
  const eta = BigInt(Math.floor(Date.now() / 1000)) + minDelay + BigInt(ETA_MARGIN_SECS);
  for (const [name, target] of [
    ["liquidation", LIQ],
    ["insurance", INS],
  ] as const) {
    await call(server, kp, target, "nominate_admin", [addr(gov)], `${name}.nominate_admin(gov)`);
    const id = createHash("sha256").update(`accept_admin|${target}|${NETWORK.name}`).digest();
    await call(
      server,
      kp,
      gov,
      "queue",
      [
        xdr.ScVal.scvBytes(id),
        addr(target),
        nativeToScVal("accept_admin", { type: "symbol" }),
        xdr.ScVal.scvVec([]),
        xdr.ScVal.scvBytes(Buffer.alloc(32)),
        nativeToScVal(eta, { type: "u64" }),
      ],
      `governance.queue(accept_admin ${name})`,
      true // AlreadyInitialized on rerun
    );
  }
  console.log(`\n  governance execute ETA for these proposals: ${eta}`);
}

async function main() {
  const secret = process.env.ORACLE_PUBLISHER_SECRET;
  if (!secret) throw new Error("ORACLE_PUBLISHER_SECRET (current admin) required");
  if (!/^C[A-Z0-9]{55}$/.test(LIQ) || !/^C[A-Z0-9]{55}$/.test(INS)) {
    throw new Error("NEW_LIQUIDATION and NEW_INSURANCE must be contract addresses");
  }
  const kp = Keypair.fromSecret(secret);
  const admin = kp.publicKey();
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);

  console.log("Rewiring liquidation/insurance against current core");
  console.log(`  admin      : ${admin}`);
  console.log(`  engine     : ${CONTRACTS.engine}`);
  console.log(`  vault      : ${CONTRACTS.vault}`);
  console.log(`  liquidation: ${LIQ} (new)`);
  console.log(`  insurance  : ${INS} (new)`);
  console.log("");

  if (process.env.ONLY_GOVERNANCE === "1") {
    await enrollGovernance(server, kp);
    return;
  }

  // 1. Initialize both (deploy-first resolves the circular reference).
  //    allowFail=true makes reruns idempotent (AlreadyInitialized).
  await call(server, kp, INS, "initialize", [addr(admin), addr(LIQ)], "insurance.initialize", true);
  await call(server, kp, INS, "set_vault", [addr(CONTRACTS.vault)], "insurance.set_vault");
  await call(
    server,
    kp,
    LIQ,
    "initialize",
    [
      addr(admin),
      addr(CONTRACTS.engine),
      addr(CONTRACTS.vault),
      addr(INS),
      addr(ASSETS.usdc),
      nativeToScVal(MAX_REWARD_BPS, { type: "u32" }),
    ],
    "liquidation.initialize",
    true
  );

  // 2. Point the core at the new instances.
  await call(server, kp, CONTRACTS.engine, "set_liquidation", [addr(LIQ)], "engine.set_liquidation");
  await call(server, kp, CONTRACTS.engine, "set_insurance", [addr(INS)], "engine.set_insurance");
  await call(server, kp, CONTRACTS.vault, "set_liquidation", [addr(LIQ)], "vault.set_liquidation");
  await call(server, kp, CONTRACTS.vault, "set_insurance", [addr(INS)], "vault.set_insurance");

  // 3. Seed the insurance fund so bad-debt absorption has real tokens.
  if (SEED > 0n) {
    await call(
      server,
      kp,
      INS,
      "deposit",
      [addr(admin), addr(ASSETS.usdc), nativeToScVal(SEED, { type: "i128" })],
      `insurance.deposit(${SEED} stroops USDC)`
    );
  }

  // 4. Enroll both in the governance ceremony (nominate + queue accept_admin).
  if (process.env.SKIP_GOVERNANCE !== "1") {
    await enrollGovernance(server, kp);
  }

  console.log("\n✓ Rewire complete. Next: update NEXT_PUBLIC_CONTRACT_{LIQUIDATION,INSURANCE}");
  console.log("  everywhere (.env.local local+VM, config default, render.yaml, manifests,");
  console.log("  GitHub production vars), restart services, then run:");
  console.log("  STRESS_SCENARIOS=b npm run dev:stress");
}

main().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
