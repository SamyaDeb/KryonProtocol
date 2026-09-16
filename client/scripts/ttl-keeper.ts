#!/usr/bin/env tsx
/**
 * TTL Keeper — extends the archival TTL on every contract INSTANCE and
 * WASM CODE ledger entry so none of them can be archived out from under
 * the protocol. Soroban archives (evicts) any ledger entry whose TTL hits
 * zero; a contract instance without a live footprint cannot be invoked
 * until it is manually restored, so this must never lapse.
 *
 * Only the 4 contracts with an on-chain extend_instance_ttl() method
 * (vault, engine, order-gateway, oracle-adapter) get *instance* keepalive
 * from within the protocol (liquidation-keeper.ts calls it opportunistically).
 * risk / liquidation / insurance / governance have no such method, and NONE
 * of the 8 contracts' WASM CODE entries are extended by anything today —
 * this script covers all of it, uniformly, via the permissionless
 * ExtendFootprintTTL operation (works on any ledger key, no contract
 * cooperation required).
 *
 * Policy: threshold 14d / extend-to 30d, matching the on-chain constants
 * (INSTANCE_TTL_THRESHOLD=241_920 ledgers, INSTANCE_TTL_EXTEND_TO=518_400
 * ledgers @ ~5s/ledger). An entry already beyond the extend-to point costs
 * ~0 to "extend" (Soroban only charges rent for the actual TTL increase),
 * so running this daily is safe and cheap in the steady state.
 *
 * ALWAYS simulates before submitting and refuses to submit above
 * --fee-ceiling (default 20 XLM total per run) — a naive blind extension
 * once quoted ~764 XLM for a 180-day bump; this keeper's job is to make
 * that impossible by only ever asking for 30 days once every ~16 days.
 *
 * Usage:
 *   TTL_KEEPER_SECRET=S... npx tsx scripts/ttl-keeper.ts [--dry-run] [--fee-ceiling=20]
 *   (or reuse LIQUIDATOR_SECRET — the operation is permissionless, any
 *   funded key can pay to extend anyone's TTL)
 *
 * Recommended cron (VM, once daily, no persistent process needed):
 *   0 6 * * * cd ~/kryon/client && DATABASE_URL= TTL_KEEPER_SECRET=$(grep LIQUIDATOR_SECRET .env.local | cut -d= -f2) npx tsx scripts/ttl-keeper.ts >> ~/kryon/ttl-keeper.log 2>&1
 */

import fs from "fs";
import path from "path";
import {
  Keypair,
  Contract,
  Address,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK } from "../config";
import { assertNoPublicSecretLeak } from "../lib/secrets-check";

assertNoPublicSecretLeak();

const LEDGER_SECS = 5;
const DAY_LEDGERS = Math.round((24 * 60 * 60) / LEDGER_SECS); // 17,280
const THRESHOLD_LEDGERS = 14 * DAY_LEDGERS; // 241,920 (~14d) — matches on-chain constants
const EXTEND_TO_LEDGERS = 30 * DAY_LEDGERS; // 518,400 (~30d)

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const feeArg = args.find((a) => a.startsWith("--fee-ceiling="));
const FEE_CEILING_XLM = feeArg ? Number(feeArg.split("=")[1]) : 20;
const FEE_CEILING_STROOPS = BigInt(Math.round(FEE_CEILING_XLM * 10_000_000));

const FEE = "3000000"; // mainnet gotcha: default 100 stroops -> TxInsufficientFee

interface Target {
  label: string;
  key: xdr.LedgerKey;
}

function instanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
}

function codeKey(wasmHashHex: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({
      hash: Buffer.from(wasmHashHex, "hex"),
    })
  );
}

function loadWasmHashes(): Record<string, string> {
  // Only mainnet has a checkpointed hash manifest today; testnet runs are
  // rehearsal-only so a missing file there just means "skip code entries".
  const jsonPath = path.join(
    __dirname,
    "../../kryon-protocol/infra/deploy/mainnet-deployment.json"
  );
  if (NETWORK.name !== "mainnet" || !fs.existsSync(jsonPath)) return {};
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  return data.wasm ?? {};
}

async function run() {
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const kp = Keypair.fromSecret(process.env.TTL_KEEPER_SECRET ?? process.env.LIQUIDATOR_SECRET!);

  console.log(`✓ TTL keeper starting${DRY_RUN ? " (--dry-run, read-only)" : ""}`);
  console.log(`  Network      : ${NETWORK.name}`);
  console.log(`  Keeper key   : ${kp.publicKey()}`);
  console.log(`  Threshold    : ${THRESHOLD_LEDGERS} ledgers (~14d)`);
  console.log(`  Extend to    : ${EXTEND_TO_LEDGERS} ledgers (~30d)`);
  console.log(`  Fee ceiling  : ${FEE_CEILING_XLM} XLM/run\n`);

  const wasmHashes = loadWasmHashes();

  const targets: Target[] = [];
  for (const [name, id] of Object.entries(CONTRACTS)) {
    targets.push({ label: `instance:${name}`, key: instanceKey(id) });
  }
  for (const [name, hash] of Object.entries(wasmHashes)) {
    targets.push({ label: `code:${name}`, key: codeKey(hash) });
  }
  if (Object.keys(wasmHashes).length === 0) {
    console.log("  (no wasm hash manifest found — skipping WASM code entries)\n");
  }

  const latest = await server.getLatestLedger();
  const currentLedger = latest.sequence;

  const entries = await server.getLedgerEntries(...targets.map((t) => t.key));
  const byXdr = new Map(entries.entries.map((e) => [e.key.toXDR("base64"), e]));

  const needsExtension: Target[] = [];
  console.log("  Entry                        remaining(d)   action");
  console.log("  ----------------------------------------------------");
  for (const t of targets) {
    const found = byXdr.get(t.key.toXDR("base64"));
    if (!found) {
      console.log(`  ${t.label.padEnd(28)} MISSING        ⚠ entry not found (already archived?)`);
      continue;
    }
    const remainingLedgers = found.liveUntilLedgerSeq! - currentLedger;
    const remainingDays = (remainingLedgers / DAY_LEDGERS).toFixed(1);
    const needsIt = remainingLedgers < THRESHOLD_LEDGERS;
    console.log(
      `  ${t.label.padEnd(28)} ${remainingDays.padStart(10)}   ${needsIt ? "extend" : "skip (healthy)"}`
    );
    if (needsIt) needsExtension.push(t);
  }
  console.log();

  if (needsExtension.length === 0) {
    console.log("✓ All entries healthy — nothing to extend.");
    return;
  }

  console.log(`  ${needsExtension.length} entr${needsExtension.length === 1 ? "y" : "ies"} below threshold, simulating extension...\n`);

  const account = await server.getAccount(kp.publicKey());
  const sorobanData = new SorobanDataBuilder().setReadOnly(needsExtension.map((t) => t.key)).build();
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .setSorobanData(sorobanData)
    .addOperation(Operation.extendFootprintTtl({ extendTo: EXTEND_TO_LEDGERS }))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    console.error(`✗ simulation failed: ${sim.error}`);
    process.exitCode = 1;
    return;
  }

  const resourceFee = BigInt(sim.minResourceFee ?? "0");
  const resourceFeeXlm = (Number(resourceFee) / 10_000_000).toFixed(4);
  console.log(`  Simulated resource fee: ${resourceFeeXlm} XLM`);

  if (resourceFee > FEE_CEILING_STROOPS) {
    console.error(
      `✗ REFUSING to submit: simulated fee ${resourceFeeXlm} XLM exceeds --fee-ceiling=${FEE_CEILING_XLM} XLM.`
    );
    console.error(`  This usually means an entry's TTL dropped much further than expected — investigate before retrying.`);
    process.exitCode = 1;
    return;
  }

  if (DRY_RUN) {
    console.log("  --dry-run set: not submitting. Re-run without --dry-run to extend.");
    return;
  }

  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") {
    console.error(`✗ submit failed: ${send.errorResult?.toXDR("base64")?.slice(0, 100)}`);
    process.exitCode = 1;
    return;
  }

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") {
      console.log(`✓ extended ${needsExtension.length} entries — tx ${send.hash.slice(0, 12)}... (cost ${resourceFeeXlm} XLM)`);
      return;
    }
    if (poll.status === "FAILED") {
      console.error(`✗ tx failed: ${send.hash}`);
      process.exitCode = 1;
      return;
    }
  }
  console.error(`? timeout waiting for confirmation: ${send.hash} (check stellar.expert)`);
  process.exitCode = 1;
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exitCode = 1;
});
