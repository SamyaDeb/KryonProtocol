#!/usr/bin/env tsx
/**
 * testnet-usdt0-golive.ts — take testnet from "USDC only" to "traders can
 * deposit USDT0 and trade", in one auditable sequence.
 *
 * ── Why this is not just `list-usdt0.ts` ─────────────────────────────────────
 * The vault deployed on testnet predates multi-collateral support. It has no
 * seize_for_deficit, no settle_deficit, no `collateral` view — and no `upgrade`,
 * which is the part that hurts: the fix cannot be shipped in place, because the
 * function that would ship it does not exist in the deployed WASM. That is
 * unavoidable exactly once, and this run is that once. Afterwards every contract
 * carries upgrade() and this never repeats.
 *
 * Listing USDT0 on the OLD vault would technically let traders deposit and
 * trade. It would also run with the solvency bug the seizure work exists to fix:
 * a USDT0-margined trader's losses drain the insurance fund while their USDT0
 * sits untouched. This script will not do that.
 *
 * ── What gets destroyed ──────────────────────────────────────────────────────
 * A new vault holds none of the old balances. Every tester's deposit and open
 * position stays with the OLD contract and does not follow. On testnet that is
 * an inconvenience — they re-deposit — but it is real, it is irreversible, and
 * the preflight prints the exact amount before asking.
 *
 * The engine is replaced alongside the vault only when it has no set_vault; a
 * vault built from current source does, so future swaps re-point instead.
 *
 * Usage:
 *   TESTNET_DEPLOYER_SECRET=S… npx tsx scripts/testnet-usdt0-golive.ts          # preflight only
 *   TESTNET_DEPLOYER_SECRET=S… npx tsx scripts/testnet-usdt0-golive.ts --confirm-redeploy
 */

import { spawnSync } from "node:child_process";
import {
  Keypair, Account, Address, Contract, TransactionBuilder,
  xdr, scValToNative, rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK, COLLATERAL, SETTLEMENT_ASSET } from "@/config";
import { amountToHuman } from "@/lib/format";

const CONFIRMED = process.argv.includes("--confirm-redeploy");
const server = new sorobanRpc.Server(NETWORK.rpcUrl);
const probeKp = Keypair.random();
let probeSeq = 1;

/** Simulates a read. Returns `{ missing: true }` when the METHOD is absent from
 *  the deployed WASM, which is how we detect an out-of-date contract. */
async function probe(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = []
): Promise<{ value?: unknown; missing: boolean; error?: string }> {
  const account = new Account(probeKp.publicKey(), String(probeSeq++));
  const tx = new TransactionBuilder(account, {
    fee: "1000000", networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    const err = sim.error ?? "";
    return { missing: /WasmVm, MissingValue/.test(err), error: err.split("\n")[0] };
  }
  const retval = (sim as sorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return { value: retval ? scValToNative(retval) : null, missing: false };
}

function run(script: string, env: Record<string, string | undefined>, args: string[] = []): void {
  console.log(`\n▶ ${script} ${args.join(" ")}`);
  const res = spawnSync("npx", ["tsx", `scripts/${script}`, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    throw new Error(`${script} exited ${res.status} — stopping before the next step.`);
  }
}

async function main() {
  if (NETWORK.name !== "testnet") {
    console.error(`❌  Testnet only; active network is ${NETWORK.name}.`);
    process.exit(1);
  }
  const secret = process.env.TESTNET_DEPLOYER_SECRET;
  if (!secret) {
    console.error("❌  TESTNET_DEPLOYER_SECRET is required — it must be the vault's current admin.");
    process.exit(1);
  }
  const deployer = Keypair.fromSecret(secret);

  console.log("═══ Preflight ═══\n");

  const admin = await probe(CONTRACTS.vault, "admin");
  console.log(`  vault            : ${CONTRACTS.vault}`);
  console.log(`  vault admin      : ${admin.value ?? "unreadable"}`);
  console.log(`  deployer         : ${deployer.publicKey()}`);
  if (admin.value && admin.value !== deployer.publicKey()) {
    console.error(
      `\n❌  TESTNET_DEPLOYER_SECRET is not the vault admin. Nothing here can be signed with it.`
    );
    process.exit(1);
  }

  // Does the live vault already understand multi-collateral?
  const hasCollateralView = !(await probe(
    CONTRACTS.vault, "collateral", [new Address(SETTLEMENT_ASSET.contract).toScVal()]
  )).missing;
  const hasUpgrade = !(await probe(
    CONTRACTS.vault, "upgrade", [xdr.ScVal.scvBytes(Buffer.alloc(32))]
  )).missing;

  console.log(`\n  collateral view  : ${hasCollateralView ? "present" : "MISSING"}`);
  console.log(`  upgrade()        : ${hasUpgrade ? "present" : "MISSING"}`);

  if (hasCollateralView) {
    console.log("\n✓ Vault is already multi-collateral — skipping redeploy, listing only.\n");
    run("deploy-testnet-usdt0.ts", {});
    console.log("\n⚠  Set NEXT_PUBLIC_ASSET_USDT0 / NEXT_PUBLIC_USDT0_ISSUER from the output above,");
    console.log("   then rerun this script to finish the listing.");
    return;
  }

  // What a redeploy would strand.
  console.log("\n═══ What a redeploy destroys ═══\n");
  let stranded = 0;
  for (const asset of COLLATERAL) {
    const dep = await probe(CONTRACTS.vault, "total_deposited", [
      new Address(asset.contract).toScVal(),
    ]);
    const human = dep.value ? amountToHuman(BigInt(String(dep.value))) : 0;
    stranded += human;
    console.log(`  ${asset.code.padEnd(6)} deposited: ${human.toFixed(2)}`);
  }
  console.log(
    `\n  These balances and every open position stay with the OLD vault.\n` +
    `  Testers must re-deposit against the new one. This cannot be undone.`
  );

  if (!CONFIRMED) {
    console.log(
      `\n─────────────────────────────────────────────────────────────\n` +
      `  Preflight only. Nothing has been changed.\n\n` +
      `  The deployed vault has no upgrade(), so this fix cannot ship in\n` +
      `  place — a redeploy is the only path, exactly once.\n\n` +
      `  To proceed:\n` +
      `    TESTNET_DEPLOYER_SECRET=S… npx tsx scripts/testnet-usdt0-golive.ts --confirm-redeploy\n` +
      `─────────────────────────────────────────────────────────────`
    );
    return;
  }

  console.log(`\n═══ Redeploying (${stranded.toFixed(2)} of deposits will be stranded) ═══`);
  run("redeploy-core.ts", { TESTNET_DEPLOYER_SECRET: secret });

  console.log(
    `\n─────────────────────────────────────────────────────────────\n` +
    `  Redeploy done. Before continuing:\n\n` +
    `   1. Update the contract addresses in client/.env.local and every\n` +
    `      keeper env from redeploy-core.ts's output.\n` +
    `   2. Restart the keepers with:\n` +
    `        ORACLE_PUBLISH_USDT0=true\n` +
    `        VAULT_SETTLE_DEFICITS=true\n` +
    `   3. Rerun this script to issue and list USDT0.\n` +
    `─────────────────────────────────────────────────────────────`
  );
}

main().catch((e) => {
  console.error("\n❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
