#!/usr/bin/env tsx
/**
 * redeploy-core.ts
 *
 * Deploys fresh instances of the core perp contracts (vault, engine,
 * order-gateway) using the ORACLE_PUBLISHER_SECRET key as admin, wired
 * to the already-redeployed oracle adapter (CDC342E2...).
 *
 * All WASMs are already uploaded on testnet — we just instantiate new
 * contract instances and initialize them.
 *
 * After running, lib/config.ts is patched with the new addresses so
 * the frontend, oracle-keeper, state-indexer, and matcher all work.
 *
 * Usage:
 *   npx tsx scripts/redeploy-core.ts
 */

import {
  Keypair,
  Account,
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  hash,
  StrKey,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync } from "child_process";

const RPC_URL   = "https://soroban-testnet.stellar.org";
const NETWORK   = "Test SDF Network ; September 2015";
const FEE       = "2000000"; // 0.2 XLM — higher for complex ops

// WASMs on-chain (re-uploaded 2026-07-05 with I1 nonce reclamation, I2
// position cap, TTL keepalives; cancel_order now takes expiry_ts).
// Governance WASM (real execute + guardian veto) also uploaded:
//   c96c7cd36a639ec845faadd211866b8af6eb095c7f05f2d35271893a658d3824
const WASM: Record<string, string> = {
  vault:         "4288a4cf85c149efae9e5bc9b8881e13420f2aa5b880e7c1c1ca857e7c9f2890",
  engine:        "72cd047b68d225a74fbbb51074e202c58184d4d7661e8fab517c9670a95e3c8f",
  orderGateway:  "ea625123ef3c35cfd66e7ebe2b17230a8a96313e2f9946775e2346d973634b88",

  risk:          "c0dc9f73b67588b55aa3aca4735775dc2fbfb29d7a3681f2634b8221522ef251", // unchanged
};

// Existing contracts we keep (already controlled by our key or unchanged)
const ORACLE_ADAPTER    = "CARSV4BT3II5QONUAOP4D363OUNTTSSZCXSKNNXKZCBJM7Z6UXSNZ3LP";
const USDC_CONTRACT     = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const INSURANCE_CONTRACT = process.env.NEXT_PUBLIC_CONTRACT_INSURANCE ?? "CA3VD55APWCYLVN7PYGJ7NPKSQBE3VU4MWVCSKLOYAZI5RFWWR76G2CL";

// Market constants (from original deployment config)
const PRECISION = BigInt("1000000000000000000"); // 1e18

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ── Deploy a contract from an existing WASM hash via stellar CLI ──────────────

/** Wait until the account's sequence number stops changing (all pending TXs cleared). */
async function waitForSequenceStable(server: sorobanRpc.Server, publicKey: string): Promise<void> {
  let prev = "";
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const acct = await server.getAccount(publicKey);
    // Account exposes sequence as a string via sequenceNumber() in stellar-sdk
    const seq = acct.sequenceNumber();
    if (seq === prev) return; // stable — no more pending TXs
    prev = seq;
  }
}

async function deployContract(
  server: sorobanRpc.Server,
  kp: Keypair,
  account: Account,
  wasmHash: string,
  label: string
): Promise<{ contractId: string; account: Account }> {
  // Wait for any previously submitted transactions to settle so the CLI
  // sees a stable sequence and doesn't get TxBadSeq.
  await waitForSequenceStable(server, kp.publicKey());

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt === 1) {
      process.stdout.write(`  [${label}] deploying via CLI...`);
    } else {
      process.stdout.write(`  [${label}] retry ${attempt}/${MAX_ATTEMPTS}...`);
      // Re-stabilise between retries (a timed-out TX may have landed)
      await waitForSequenceStable(server, kp.publicKey());
    }

    const result = spawnSync("stellar", [
      "contract", "deploy",
      "--wasm-hash", wasmHash,
      "--source-account", kp.secret(),
      "--network", "testnet",
      "--fee", "2000000",
      "--no-cache",
    ], { encoding: "utf8", timeout: 180_000 });

    const contractId = result.stdout.trim();
    if (result.status === 0 && contractId) {
      process.stdout.write(` ✓ ${contractId.slice(0, 10)}...\n`);
      const newAccount = await server.getAccount(kp.publicKey());
      return { contractId, account: newAccount };
    }

    const stderr = result.stderr ?? "";
    const isTimeout = stderr.includes("timeout") || result.status === null;
    const isBadSeq = stderr.includes("TxBadSeq");
    process.stdout.write(isTimeout ? ` timeout, will retry\n` : isBadSeq ? ` TxBadSeq, will retry\n` : ` failed\n`);

    if ((!isTimeout && !isBadSeq) || attempt === MAX_ATTEMPTS) {
      throw new Error(`Deploy ${label} failed after ${attempt} attempt(s):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }
  }
  // unreachable
  throw new Error(`Deploy ${label}: exhausted retries`);
}

// ── Call a contract function and wait for confirmation ────────────────────────

async function callContract(
  server: sorobanRpc.Server,
  kp: Keypair,
  account: Account,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  label: string
): Promise<Account> {
  const contract = new Contract(contractId);

  const buildAndSend = async (acct: Account) => {
    const tx = new TransactionBuilder(acct, { fee: FEE, networkPassphrase: NETWORK })
      .addOperation(contract.call(method, ...args))
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`${label} sim failed: ${(sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error?.slice(0, 200)}`);
    }

    const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
    prepared.sign(kp);

    const send = await server.sendTransaction(prepared);
    if (send.status === "ERROR") throw new Error(`${label} submit failed`);
    return send.hash;
  };

  process.stdout.write(`  [${label}]...`);

  let confirmed = false;
  for (let attempt = 0; attempt < 2 && !confirmed; attempt++) {
    if (attempt > 0) {
      process.stdout.write(` retrying...`);
      account = await server.getAccount(kp.publicKey());
    }

    const txHash = await buildAndSend(account);

    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const poll = await server.getTransaction(txHash);
      if (poll.status === "SUCCESS") { process.stdout.write(` ✓\n`); confirmed = true; break; }
      if (poll.status === "FAILED") throw new Error(`${label} tx failed on-chain`);
      process.stdout.write(".");
    }
  }

  if (!confirmed) throw new Error(`${label} timed out after 2 attempts`);

  return server.getAccount(kp.publicKey());
}

function addr(a: string): xdr.ScVal { return new Address(a).toScVal(); }
function u32(n: number):  xdr.ScVal { return nativeToScVal(n, { type: "u32" }); }
function u64(n: bigint):  xdr.ScVal { return nativeToScVal(n, { type: "u64" }); }
function i128(n: bigint): xdr.ScVal { return nativeToScVal(n, { type: "i128" }); }
function bool_(b: boolean): xdr.ScVal { return xdr.ScVal.scvBool(b); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const secret = process.env.ORACLE_PUBLISHER_SECRET;
  if (!secret) { console.error("❌  ORACLE_PUBLISHER_SECRET not set"); process.exit(1); }

  const kp     = Keypair.fromSecret(secret);
  const admin  = kp.publicKey();
  const server = new sorobanRpc.Server(RPC_URL);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  Kryon Core Contract Redeployment");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Admin    : ${admin}`);
  console.log(`  Oracle   : ${ORACLE_ADAPTER} (existing)`);
  console.log(`  USDC     : ${USDC_CONTRACT} (existing)`);
  console.log("");

  let account = await server.getAccount(admin);

  // ── Deploy contracts ─────────────────────────────────────────────────────

  console.log("Step 1 — Deploy contracts");
  let vaultId: string, engineId: string, gatewayId: string, riskId: string;

  ({ contractId: vaultId,   account } = await deployContract(server, kp, account, WASM.vault,        "vault"));
  ({ contractId: riskId,    account } = await deployContract(server, kp, account, WASM.risk,         "risk"));
  ({ contractId: engineId,  account } = await deployContract(server, kp, account, WASM.engine,       "engine"));
  ({ contractId: gatewayId, account } = await deployContract(server, kp, account, WASM.orderGateway, "order-gateway"));

  console.log("");
  console.log(`  vault        : ${vaultId}`);
  console.log(`  risk         : ${riskId}`);
  console.log(`  engine       : ${engineId}`);
  console.log(`  order-gateway: ${gatewayId}`);
  console.log("");

  // ── Initialize contracts ─────────────────────────────────────────────────
  // Signatures (from contracts source):
  //   vault.initialize(admin, oracle, engine)  — store engine for auth checks
  //   risk.initialize(admin)
  //   engine.initialize(admin, oracle, vault, settlement_asset)
  //   gateway.initialize(admin, engine)
  //
  // Circular dep: vault needs engine addr, engine needs vault addr.
  // Resolve: init vault with admin as placeholder, deploy engine, then vault.set_engine().

  console.log("Step 2 — Initialize contracts");

  // vault.initialize(admin, oracle, placeholder=admin)
  account = await callContract(server, kp, account, vaultId, "initialize",
    [addr(admin), addr(ORACLE_ADAPTER), addr(admin)], "vault.initialize");

  // risk.initialize(admin)
  account = await callContract(server, kp, account, riskId, "initialize",
    [addr(admin)], "risk.initialize");

  // engine.initialize(admin, oracle, vault, settlement_asset)
  account = await callContract(server, kp, account, engineId, "initialize",
    [addr(admin), addr(ORACLE_ADAPTER), addr(vaultId), addr(USDC_CONTRACT)], "engine.initialize");

  // gateway.initialize(admin, engine)
  account = await callContract(server, kp, account, gatewayId, "initialize",
    [addr(admin), addr(engineId)], "gateway.initialize");

  console.log("");

  // ── Wire up cross-references ─────────────────────────────────────────────

  console.log("Step 3 — Wire cross-references");

  // vault.set_engine(engine)  — replace placeholder with real engine
  account = await callContract(server, kp, account, vaultId, "set_engine",
    [addr(engineId)], "vault.set_engine");

  // engine.set_order_gateway(gateway)
  account = await callContract(server, kp, account, engineId, "set_order_gateway",
    [addr(gatewayId)], "engine.set_order_gateway");

  // C2: gateway.set_operator(matcher) — the operator account that submits
  // settle_fill_signed (must match MATCHER_OPERATOR_SECRET's fee-payer key).
  const OPERATOR_PUBKEY = process.env.MATCHER_OPERATOR_PUBKEY
    ?? (process.env.MATCHER_OPERATOR_SECRET ? Keypair.fromSecret(process.env.MATCHER_OPERATOR_SECRET).publicKey() : admin);
  account = await callContract(server, kp, account, gatewayId, "set_operator",
    [addr(OPERATOR_PUBKEY)], "gateway.set_operator");

  // C2: gateway.set_domain(passphrase bytes) — bound into the canonical order
  // message so settle_fill_signed verifies the wallet signatures (and blocks
  // cross-network replay). MUST equal the passphrase the client signs with.
  const domainBytes = Buffer.from(NETWORK, "utf8");
  account = await callContract(server, kp, account, gatewayId, "set_domain",
    [xdr.ScVal.scvBytes(domainBytes)], "gateway.set_domain");

  // vault.set_collateral(usdc, "USDC", haircut_bps=0, active=true)
  account = await callContract(server, kp, account, vaultId, "set_collateral",
    [addr(USDC_CONTRACT), xdr.ScVal.scvSymbol("USDC"), u32(0), xdr.ScVal.scvBool(true)], "vault.set_collateral(USDC)");

  // M1: wire insurance address on engine so update_funding can route surplus/deficit
  account = await callContract(server, kp, account, engineId, "set_insurance",
    [addr(INSURANCE_CONTRACT)], "engine.set_insurance");

  console.log("");

  // ── Configure XLM-PERP market ────────────────────────────────────────────

  console.log("Step 4 — Configure XLM-PERP market");

  // MarketConfig (protocol-core, alphabetical field order):
  //   active, base_asset, initial_margin_bps, liquidation_fee_bps, maintenance_margin_bps,
  //   market_id, max_leverage_bps, max_open_interest, max_oracle_age_secs,
  //   max_oracle_confidence_bps, settlement_asset
  const coreMarketConfig = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("active"),                   val: xdr.ScVal.scvBool(true) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("base_asset"),               val: xdr.ScVal.scvSymbol("XLM") }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("initial_margin_bps"),       val: u32(1000) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("liquidation_fee_bps"),      val: u32(50) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("maintenance_margin_bps"),   val: u32(500) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("market_id"),                val: u32(1) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_leverage_bps"),         val: u32(100000) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_open_interest"),        val: i128(PRECISION * 1_000_000n) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_oracle_age_secs"),      val: u64(120n) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_oracle_confidence_bps"), val: u32(1000) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("settlement_asset"),         val: addr(USDC_CONTRACT) }),
  ]);

  // EngineMarketConfig: { market: MarketConfig, max_execution_deviation_bps: u32 }
  // 1000 bps (10%) on testnet: 500 caused PriceOutsideBand when the oracle
  // drifted while a limit order rested. Tighten for mainnet after stress tests.
  const engineMarketConfig = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("market"),                       val: coreMarketConfig }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_execution_deviation_bps"),  val: u32(1000) }),
  ]);

  account = await callContract(server, kp, account, engineId, "set_market",
    [engineMarketConfig], "engine.set_market(XLM-PERP)");

  // vault also takes plain MarketConfig
  account = await callContract(server, kp, account, vaultId, "set_market_config",
    [coreMarketConfig], "vault.set_market_config(XLM-PERP)");

  console.log("");

  // ── Patch config files ────────────────────────────────────────────────────

  console.log("Step 5 — Patching config files");

  const configPath = path.resolve(__dirname, "../config/index.ts");
  let configSrc = fs.readFileSync(configPath, "utf8");

  // Config may use plain string OR envOrDefault("ENV_VAR", "fallback") — handle both.
  const patches: [RegExp, string][] = [
    // envOrDefault form:  vault: envOrDefault("...", "OLD_ADDR"),
    [/(\bvault:\s*envOrDefault\([^,]+,\s*")[^"]+(")/,         `$1${vaultId}$2`],
    [/(\bengine:\s*envOrDefault\([^,]+,\s*")[^"]+(")/,        `$1${engineId}$2`],
    [/(\borderGateway:\s*envOrDefault\([^,]+,\s*")[^"]+(")/,  `$1${gatewayId}$2`],
    // plain-string form: vault: "OLD_ADDR"
    [/(\bvault:\s*")[^"]+(")/,        `$1${vaultId}$2`],
    [/(\bengine:\s*")[^"]+(")/,       `$1${engineId}$2`],
    [/(\borderGateway:\s*")[^"]+(")/,  `$1${gatewayId}$2`],
  ];

  for (const [regex, replacement] of patches) {
    if (regex.test(configSrc)) {
      configSrc = configSrc.replace(regex, replacement);
    }
  }
  fs.writeFileSync(configPath, configSrc);
  console.log("  ✓ lib/config.ts patched");

  // Patch state-indexer CONTRACTS
  const indexerPath = path.resolve(__dirname, "state-indexer.ts");
  let indexerSrc = fs.readFileSync(indexerPath, "utf8");
  indexerSrc = indexerSrc.replace(/engine:\s*["'][^"']+["']/, `engine:       "${engineId}"`);
  indexerSrc = indexerSrc.replace(/vault:\s*["'][^"']+["']/, `vault:        "${vaultId}"`);
  fs.writeFileSync(indexerPath, indexerSrc);
  console.log("  ✓ scripts/state-indexer.ts patched");

  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  ✓ Core redeployment complete");
  console.log("");
  console.log(`  vault        : ${vaultId}`);
  console.log(`  engine       : ${engineId}`);
  console.log(`  order-gateway: ${gatewayId}`);
  console.log(`  risk         : ${riskId}`);
  console.log(`  oracle       : ${ORACLE_ADAPTER} (unchanged)`);
  console.log("");
  console.log("  NOTE: Users must deposit USDC into the NEW vault address.");
  console.log("        Restart: npm run dev && npm run dev:indexer && npm run dev:oracle && npm run dev:matcher");
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((e) => { console.error("❌ ", e.message); process.exit(1); });
