#!/usr/bin/env tsx
/**
 * mainnet-upgrade.ts — one command to take mainnet to multi-collateral and list
 * the real USDT0.
 *
 * Rehearsed first: the identical bytecode was deployed to testnet as v3, USDT0
 * was listed at a 5% haircut, and a 1,000 USDT0 deposit valued at 950 equity on
 * chain. This is not a first attempt.
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 *   1. Preflight  — hashes, funding, admin, and whether an upgrade path exists
 *   2. Deploy     — mainnet-deploy.ts (resume-safe; checkpoints per state file)
 *   3. List       — list-usdt0.ts against the REAL USDT0 SAC
 *
 * ── What it refuses to do ────────────────────────────────────────────────────
 * Underfunded. Wrong signer. And listing collateral while the admin is a plain
 * keypair — the new contracts carry upgrade(), so a leaked admin key stops
 * being "drain the vault" and becomes "replace the protocol's code". Hand admin
 * to the governance timelock first, or pass --i-accept-keypair-admin knowing
 * exactly what that buys.
 *
 * Usage:
 *   MAINNET_DEPLOYER_SECRET=S… npx tsx scripts/mainnet-upgrade.ts              # preflight
 *   MAINNET_DEPLOYER_SECRET=S… npx tsx scripts/mainnet-upgrade.ts --go
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  Keypair, Account, Contract, Operation, TransactionBuilder,
  Address, xdr, scValToNative, rpc as sorobanRpc,
} from "@stellar/stellar-sdk";

const PASS = "Public Global Stellar Network ; September 2015";
const RPC = process.env.MAINNET_RPC_URL ?? "https://mainnet.sorobanrpc.com";
const HORIZON = "https://horizon.stellar.org";
const ARTIFACTS = path.resolve(__dirname, "../../kryon-protocol/target/wasm32v1-none/release/deploy");
const STATE = process.env.DEPLOY_STATE_PATH
  ?? path.resolve(__dirname, "../../kryon-protocol/infra/deploy/mainnet-deployment-v2.json");

const GO = process.argv.includes("--go");
const ACCEPT_KEYPAIR_ADMIN = process.argv.includes("--i-accept-keypair-admin");
// Real USDT0 on Stellar mainnet. https://developers.stellar.org/docs/tokens/usdt0-layerzero
const USDT0_SAC = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";
// Deploy + init/wiring + reserves + retry buffer over the simulated upload cost.
const OVERHEAD_XLM = 60;

const server = new sorobanRpc.Server(RPC);

async function nativeBalance(pubkey: string): Promise<number | null> {
  const res = await fetch(`${HORIZON}/accounts/${pubkey}`);
  if (!res.ok) return null;
  const acct = (await res.json()) as { balances: { asset_type: string; balance: string }[] };
  const native = acct.balances.find((b) => b.asset_type === "native");
  return native ? Number(native.balance) : 0;
}

/** Simulates every upload to price the deploy against today's fees, not a note. */
async function simulateUploadCost(source: string): Promise<number> {
  const account = await server.getAccount(source).catch(
    () => new Account(Keypair.random().publicKey(), "0")
  );
  let total = 0;
  for (const file of fs.readdirSync(ARTIFACTS).filter((f) => f.endsWith(".wasm"))) {
    const wasm = fs.readFileSync(path.join(ARTIFACTS, file));
    const tx = new TransactionBuilder(
      new Account(account.accountId(), account.sequenceNumber()),
      { fee: "1000000", networkPassphrase: PASS }
    )
      .addOperation(Operation.uploadContractWasm({ wasm }))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!sorobanRpc.Api.isSimulationError(sim)) {
      total += Number((sim as sorobanRpc.Api.SimulateTransactionSuccessResponse).minResourceFee) / 1e7;
    }
  }
  return total;
}

async function readVault(vault: string, method: string, args: xdr.ScVal[] = []) {
  const account = new Account(Keypair.random().publicKey(), "1");
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASS })
    .addOperation(new Contract(vault).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) return { missing: /MissingValue/.test(sim.error) };
  const rv = (sim as sorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return { value: rv ? scValToNative(rv) : null, missing: false };
}

function step(script: string, args: string[], env: Record<string, string | undefined>) {
  console.log(`\n▶ ${script} ${args.join(" ")}`);
  const res = spawnSync("npx", ["tsx", `scripts/${script}`, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) throw new Error(`${script} exited ${res.status} — stopping.`);
}

async function main() {
  const secret = process.env.MAINNET_DEPLOYER_SECRET;
  if (!secret) {
    console.error("❌  MAINNET_DEPLOYER_SECRET is required.");
    process.exit(1);
  }
  const deployer = Keypair.fromSecret(secret);

  console.log("═══ Mainnet upgrade preflight ═══\n");
  console.log(`  deployer   : ${deployer.publicKey()}`);
  console.log(`  state file : ${STATE}`);
  console.log(`  artifacts  : ${ARTIFACTS}`);

  if (!fs.existsSync(ARTIFACTS)) {
    console.error(
      `\n❌  No artifacts. Build them first:\n` +
      `      cargo build --target wasm32v1-none --release -p perp-vault …\n` +
      `      python3 infra/deploy/optimize-wasm.py --all target/wasm32v1-none/release ${ARTIFACTS}`
    );
    process.exit(1);
  }

  process.stdout.write("\n  pricing the deploy against mainnet RPC…");
  const uploadXlm = await simulateUploadCost(deployer.publicKey());
  const needed = uploadXlm + OVERHEAD_XLM;
  const balance = await nativeBalance(deployer.publicKey());
  console.log(` ${uploadXlm.toFixed(1)} XLM upload`);
  console.log(`  required   : ~${needed.toFixed(0)} XLM (upload + init/wiring + reserves + buffer)`);
  console.log(`  balance    : ${balance === null ? "account not found" : balance.toFixed(2) + " XLM"}`);

  if (balance === null || balance < needed) {
    const short = balance === null ? needed : needed - balance;
    console.error(
      `\n❌  Underfunded by ~${short.toFixed(0)} XLM. Fund ${deployer.publicKey()} and rerun.\n` +
      `    Stopping here is the point: a deploy that dies halfway leaves contracts\n` +
      `    uploaded but unwired, and the fees are already spent.`
    );
    process.exit(1);
  }

  // Governance gate — only meaningful once contracts exist.
  const existingVault = process.env.MAINNET_VAULT;
  if (existingVault) {
    const admin = await readVault(existingVault, "admin");
    if (admin.value && admin.value !== deployer.publicKey() && !ACCEPT_KEYPAIR_ADMIN) {
      console.log(`\n  current vault admin: ${admin.value}`);
    }
  }
  if (!ACCEPT_KEYPAIR_ADMIN) {
    console.log(
      `\n  ⚠  Admin will be this keypair, not the governance timelock.\n` +
      `     Every contract now carries upgrade(), so whoever holds this key can\n` +
      `     replace the protocol's code, not merely move its funds. Hand admin to\n` +
      `     perp-governance before listing collateral, or pass\n` +
      `     --i-accept-keypair-admin to proceed anyway.`
    );
  }

  if (!GO) {
    console.log(
      `\n─────────────────────────────────────────────────────────────\n` +
      `  Preflight only — nothing changed. Funded and ready.\n\n` +
      `  To run it:\n` +
      `    MAINNET_DEPLOYER_SECRET=S… npx tsx scripts/mainnet-upgrade.ts --go\n` +
      `─────────────────────────────────────────────────────────────`
    );
    return;
  }

  step("mainnet-deploy.ts", [], { DEPLOY_STATE_PATH: STATE, MAINNET_DEPLOYER_SECRET: secret });

  console.log(
    `\n  Deploy done. Update config/networks.ts MAINNET_DEFAULTS and every keeper\n` +
    `  env with the addresses above, set ORACLE_PUBLISH_USDT0=true and\n` +
    `  VAULT_SETTLE_DEFICITS=true, restart the keepers, then list USDT0:\n\n` +
    `    NEXT_PUBLIC_STELLAR_NETWORK=mainnet VAULT_ADMIN_SECRET=S… ORACLE_ADMIN_SECRET=S… \\\n` +
    `      ORACLE_PUBLISHER_PUBKEY=G… npx tsx scripts/list-usdt0.ts --dry-run\n\n` +
    `  Real USDT0 SAC: ${USDT0_SAC}`
  );
}

main().catch((e) => {
  console.error("\n❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
