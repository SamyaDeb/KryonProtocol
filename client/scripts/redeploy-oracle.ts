#!/usr/bin/env tsx
/**
 * redeploy-oracle.ts
 *
 * Deploys a fresh perp-oracle-adapter instance from the existing on-chain WASM,
 * sets the deployer as admin, registers an XLM/RedStone feed, and patches all
 * config files in the repo so everything points to the new contract.
 *
 * Usage:
 *   ORACLE_PUBLISHER_SECRET=S... npx tsx scripts/redeploy-oracle.ts
 *
 * The ORACLE_PUBLISHER_SECRET is used as both the deployer/admin and the
 * oracle publisher.  After this runs, `npm run dev:oracle` will work.
 */

import {
  Keypair,
  TransactionBuilder,
  Account,
  Address,
  nativeToScVal,
  scValToNative,
  StrKey,
  xdr,
  hash,
  Contract,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

const RPC_URL   = "https://soroban-testnet.stellar.org";
const NETWORK   = "Test SDF Network ; September 2015";
// WASM already uploaded during the original deploy
const WASM_HASH = "853fd4c9f31e223cf0a6e03f727a4812b71d3f648bf30915ef343e2cc5099e6e";
const FEE       = "1000000"; // 0.1 XLM — enough for contract deploys

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function submitAndWait(
  server: sorobanRpc.Server,
  kp: Keypair,
  account: Account,
  operations: xdr.Operation[],
  label: string
): Promise<sorobanRpc.Api.GetSuccessfulTransactionResponse> {
  let builder = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK });
  for (const op of operations) builder = builder.addOperation(op);
  const tx = builder.setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`${label} sim failed: ${sim.error?.slice(0, 300)}`);
  }

  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);

  process.stdout.write(`  Submitting ${label}...`);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") {
    throw new Error(`${label} submit error: ${JSON.stringify(send.errorResult?.toXDR("base64"))}`);
  }

  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") {
      process.stdout.write(` ✓ ${send.hash.slice(0, 12)}\n`);
      return poll as sorobanRpc.Api.GetSuccessfulTransactionResponse;
    }
    if (poll.status === "FAILED") throw new Error(`${label} tx failed on-chain`);
    process.stdout.write(".");
  }
  throw new Error(`${label} timeout — hash: ${send.hash}`);
}

// ── Compute new contract address from preimage ────────────────────────────────

function computeContractId(deployerPubkey: string, salt: Buffer): string {
  const networkId = hash(Buffer.from(NETWORK));
  const deployerScAddr = new Address(deployerPubkey).toScAddress();

  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: deployerScAddr,
          salt,
        })
      ),
    })
  );

  const contractIdBytes = hash(preimage.toXDR());
  return StrKey.encodeContract(contractIdBytes);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const secret = process.env.ORACLE_PUBLISHER_SECRET;
  if (!secret) {
    console.error("❌  ORACLE_PUBLISHER_SECRET is not set in .env.local");
    process.exit(1);
  }

  const kp     = Keypair.fromSecret(secret);
  const pubkey = kp.publicKey();
  const server = new sorobanRpc.Server(RPC_URL);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  Kryon Oracle Redeployment");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Admin / Publisher : ${pubkey}`);
  console.log(`  WASM hash         : ${WASM_HASH}`);
  console.log(`  Network           : Stellar Testnet`);
  console.log("");

  // ── Ensure account is funded on testnet ──────────────────────────────────
  let accountData: Account;
  try {
    accountData = await server.getAccount(pubkey);
    console.log(`  Account found (seq ${accountData.sequenceNumber()})`);
  } catch {
    console.log("  Account not found — funding via Friendbot...");
    const fb = await fetch(`https://friendbot.stellar.org?addr=${pubkey}`);
    if (!fb.ok) throw new Error("Friendbot failed: " + await fb.text());
    await sleep(3000);
    accountData = await server.getAccount(pubkey);
    console.log(`  ✓ Funded (seq ${accountData.sequenceNumber()})`);
  }

  console.log("");

  // ── Step 1: Deploy new oracle-adapter instance ────────────────────────────
  console.log("Step 1 — Deploy new oracle-adapter instance");

  const salt = crypto.randomBytes(32);
  const newContractId = computeContractId(pubkey, salt);
  console.log(`  New contract addr : ${newContractId}`);

  const deployerScAddr = new Address(pubkey).toScAddress();
  const createContractArgs = new xdr.CreateContractArgs({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: deployerScAddr,
        salt,
      })
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(
      Buffer.from(WASM_HASH, "hex")
    ),
  });

  const deployOp = xdr.Operation.fromXDR(
    new xdr.Operation({
      sourceAccount: null,
      body: xdr.OperationBody.invokeHostFunction(
        new xdr.InvokeHostFunctionOp({
          hostFunction: xdr.HostFunction.hostFunctionTypeCreateContract(createContractArgs),
          auth: [],
        })
      ),
    }).toXDR()
  );

  await submitAndWait(server, kp, accountData, [deployOp], "deploy");
  // Refresh sequence
  accountData = await server.getAccount(pubkey);

  // ── Step 2: Initialize — set admin ────────────────────────────────────────
  console.log("Step 2 — Initialize oracle (set admin)");
  const newContract = new Contract(newContractId);

  await submitAndWait(
    server, kp, accountData,
    [newContract.call("initialize", nativeToScVal(pubkey, { type: "address" }))],
    "initialize"
  );
  accountData = await server.getAccount(pubkey);

  // ── Step 3: set_feed for XLM ──────────────────────────────────────────────
  console.log("Step 3 — Register XLM feed");

  // OracleSource::RedStone (first variant, no data) → scvVec([scvSymbol("RedStone")])
  const sourceArg = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("RedStone")]);

  // OracleGuard { max_age_secs: 120, max_confidence_bps: 1000 }
  const guardArg = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("max_age_secs"),
      val: nativeToScVal(120, { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("max_confidence_bps"),
      val: nativeToScVal(1000, { type: "u32" }),
    }),
  ]);

  await submitAndWait(
    server, kp, accountData,
    [newContract.call(
      "set_feed",
      nativeToScVal("XLM",    { type: "symbol" }),    // asset
      nativeToScVal(pubkey,   { type: "address" }),   // publisher
      sourceArg,                                       // source
      guardArg,                                        // guard
      nativeToScVal(true,     { type: "bool" }),      // active
    )],
    "set_feed"
  );

  // ── Step 4: Patch config files ────────────────────────────────────────────
  console.log("Step 4 — Patching config files");

  const configPath = path.resolve(__dirname, "../lib/config.ts");
  let configSrc = fs.readFileSync(configPath, "utf8");
  const oracleRegex = /oracleAdapter:\s*["'][^"']+["']/;
  if (oracleRegex.test(configSrc)) {
    configSrc = configSrc.replace(oracleRegex, `oracleAdapter: "${newContractId}"`);
    fs.writeFileSync(configPath, configSrc);
    console.log(`  ✓ lib/config.ts  → oracleAdapter = ${newContractId}`);
  } else {
    console.log(`  ⚠  Could not auto-patch lib/config.ts — update oracleAdapter manually`);
    console.log(`     Set oracleAdapter to: ${newContractId}`);
  }

  // Patch oracle-keeper.ts
  const keeperPath = path.resolve(__dirname, "oracle-keeper.ts");
  let keeperSrc = fs.readFileSync(keeperPath, "utf8");
  keeperSrc = keeperSrc.replace(
    /const ORACLE_ADAPTER = "[^"]+"/,
    `const ORACLE_ADAPTER = "${newContractId}"`
  );
  fs.writeFileSync(keeperPath, keeperSrc);
  console.log(`  ✓ scripts/oracle-keeper.ts  → ORACLE_ADAPTER`);

  // Patch state-indexer.ts
  const indexerPath = path.resolve(__dirname, "state-indexer.ts");
  let indexerSrc = fs.readFileSync(indexerPath, "utf8");
  indexerSrc = indexerSrc.replace(
    /oracle:\s*["'][^"']+["']/,
    `oracle:       "${newContractId}"`
  );
  fs.writeFileSync(indexerPath, indexerSrc);
  console.log(`  ✓ scripts/state-indexer.ts  → CONTRACTS.oracle`);

  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  ✓ Oracle redeployment complete");
  console.log(`  New address : ${newContractId}`);
  console.log("");
  console.log("  Next steps:");
  console.log("    npm run dev:oracle    ← start writing live XLM prices");
  console.log("    npm run dev:indexer   ← sync contract state to DB");
  console.log("    npm run dev           ← start Next.js frontend");
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((e) => { console.error("❌ ", e.message); process.exit(1); });
