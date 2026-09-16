#!/usr/bin/env tsx
/**
 * testnet-deploy.ts — one-shot, resume-safe Kryon TESTNET deployment.
 *
 * Adapted from mainnet-deploy.ts (same WASM artifacts — Soroban bytecode is
 * network-agnostic, only the deployed address and signing passphrase differ).
 *
 * Unlike mainnet-deploy.ts's Step 1, this REUSES the three operator pubkeys
 * already funded and wired into the Railway testnet-keepers deployment
 * (ORACLE_PUBLISHER_ADDRESS / MATCHER_OPERATOR_ADDRESS / LIQUIDATOR_ADDRESS)
 * instead of minting fresh ones — so nothing downstream needs re-wiring
 * except the contract addresses themselves. Only a fresh "guardian" key is
 * generated, since nothing currently depends on a specific guardian.
 *
 * Admin stays this script's deployer keypair — no governance handover, by
 * design, so there is exactly one key to manage for this venue.
 *
 * Every step checkpoints to infra/deploy/testnet-deployment-v2.json; rerunning
 * skips completed steps, so a crash never repeats a submission.
 *
 * Usage:
 *   TESTNET_DEPLOYER_SECRET=S... \
 *   ORACLE_PUBLISHER_ADDRESS=G... MATCHER_OPERATOR_ADDRESS=G... LIQUIDATOR_ADDRESS=G... \
 *   npx tsx scripts/testnet-deploy.ts [--dry-run]
 */

import {
  Keypair,
  Address,
  Contract,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  nativeToScVal,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync } from "child_process";
import {
  contractExports,
  keySeparationViolations,
  missingLifecycleExports,
} from "../lib/deploy-preflight";

const RPC_URL = process.env.TESTNET_RPC_URL ?? "https://soroban-testnet.stellar.org";
const RPC_POOL = [RPC_URL, "https://soroban-testnet.stellar.org"];
const NETWORK = "Test SDF Network ; September 2015";
const FEE = "2000000";

// Testnet USDC (Circle SAC) — matches NEXT_PUBLIC_ASSET_USDC in
// .env.testnet.example / config/networks.ts TESTNET_DEFAULTS.
const USDC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const PROTO = path.resolve(__dirname, "../../kryon-protocol");
const ARTIFACTS = path.join(PROTO, "target/wasm32v1-none/release/deploy");
// Overridable so a fresh deployment does not resume into (and skip past) an
// earlier one's checkpoints — rerunning against a completed state file would
// silently do nothing and report success.
const STATE_PATH = process.env.DEPLOY_STATE_PATH
  ? path.resolve(process.env.DEPLOY_STATE_PATH)
  : path.join(PROTO, "infra/deploy/testnet-deployment-v2.json");
// Derived from the state file, NOT a fixed name. A hardcoded path is shared by
// every deployment that ever runs this script, so a second run overwrites the
// first deployment's guardian secret — while that deployment is still live and
// still relying on the key. Keying it to the state file gives each deployment
// its own secrets file.
const SECRETS_PATH = STATE_PATH.replace(/(-deployment)?(-v\d+)?\.json$/, "") + "-secrets.env";

// Pinned so the deploy refuses to ship WASM it does not recognise. These are
// the multi-collateral release: seize_for_deficit + settle_deficit in the
// vault, engine.set_vault, and upgrade() on every contract. Regenerate with
//   python3 infra/deploy/optimize-wasm.py --all target/wasm32v1-none/release \
//     target/wasm32v1-none/release/deploy && shasum -a 256 <dir>/*.wasm
const EXPECTED_SHA256: Record<string, string> = {
  perp_vault:          "0bce8f7fa607fc83afe59e0eba457fc4c18e18ae0d26735d6c81d41b38751832",
  perp_engine:         "c1fb50b4db768778cf43144ab3c5fa21ba647ad28c1bfc8c4721dfcc046a7da9",
  perp_order_gateway:  "7ac01e8b11061f148077c0ab2bdbc939c97e4c055131d12983e4daa3c50876d1",
  perp_risk:           "0385b606e9c9a29cd7bd0cf45c656499ef68d017282a4165070701faafdc7ebb",
  perp_oracle_adapter: "3df25f0041594813050bb841b9c21ebc8a33e06bdfc27fcd8a790f9ae7f41556",
  perp_insurance:      "134cf5ffb4367e79420d544ce990f21ce36a201f8080577b944854aeb29f5d5b",
  perp_liquidation:    "a8e496bae1540b562bf58ceeaedeecb5a2a836f630a7c304ed0ae005b1884753",
  perp_governance:     "11b7d1c04fe074a03755d6d828838d27df6da4b5db7062355aae8bedb70c6fd6",
};

const PRECISION = BigInt("1000000000000000000");
const DEPOSIT_CAP_USDC = 1_000_000_0000000n; // 1,000,000 USDC (7dp) — testnet, no real funds
const GOV_MIN_DELAY_SECS = 172_800n; // 48h — deployed for parity, admin stays the deployer key

type State = {
  ops?: Record<string, { pub: string }>;
  wasm?: Record<string, string>;
  contracts?: Record<string, string>;
  steps?: Record<string, boolean>;
};

const DRY = process.argv.includes("--dry-run");

function loadState(): State {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}
function saveState(s: State) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function addr(a: string): xdr.ScVal { return new Address(a).toScVal(); }
function u32(n: number): xdr.ScVal { return nativeToScVal(n, { type: "u32" }); }
function u64(n: bigint): xdr.ScVal { return nativeToScVal(n, { type: "u64" }); }
function i128(n: bigint): xdr.ScVal { return nativeToScVal(n, { type: "i128" }); }
function sym(s: string): xdr.ScVal { return xdr.ScVal.scvSymbol(s); }
function boolv(b: boolean): xdr.ScVal { return xdr.ScVal.scvBool(b); }

async function waitForSequenceStable(server: sorobanRpc.Server, publicKey: string) {
  let prev = "";
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const seq = (await server.getAccount(publicKey)).sequenceNumber();
    if (seq === prev) return;
    prev = seq;
  }
}

function cli(args: string[], label: string, timeoutMs = 300_000): string {
  if (DRY) {
    const redacted = args.map((a) => (/^S[A-Z2-7]{55}$/.test(a) ? "S…REDACTED" : a));
    console.log(`  [dry] stellar ${redacted.join(" ")}`);
    return "DRY";
  }
  const res = spawnSync("stellar", args, { encoding: "utf8", timeout: timeoutMs });
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error(`${label} failed:\n${res.stderr}`);
  }
  return res.stdout.trim().split("\n").pop()!.trim();
}

async function call(
  server: sorobanRpc.Server,
  kp: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  label: string,
  allowFailCodes: number[] = []
): Promise<void> {
  process.stdout.write(`  [${label}]...`);
  if (DRY) { console.log(" (dry)"); return; }
  const contract = new Contract(contractId);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) { process.stdout.write(` retry ${attempt + 1}...`); await waitForSequenceStable(server, kp.publicKey()); }
    const account = await server.getAccount(kp.publicKey());
    const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
      .addOperation(contract.call(method, ...args))
      .setTimeout(120)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(sim)) {
      const err = (sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error ?? "";
      const already = allowFailCodes.some((c) => err.includes(`Error(Contract, #${c})`));
      if (already) { console.log(` skipped (already done: contract error tolerated)`); return; }
      throw new Error(`${label} sim failed: ${err.slice(0, 300)}`);
    }
    const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
    prepared.sign(kp);
    const send = await server.sendTransaction(prepared);
    if (send.status === "ERROR") {
      process.stdout.write(" submit ERROR");
      continue;
    }
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const poll = await server.getTransaction(send.hash);
      if (poll.status === "SUCCESS") { console.log(" ✓"); return; }
      if (poll.status === "FAILED") throw new Error(`${label} FAILED on-chain: ${send.hash}`);
    }
  }
  throw new Error(`${label}: exhausted retries`);
}


/**
 * Writes generated keys, refusing to destroy a secrets file that already exists.
 *
 * These files are the ONLY copy of the keys they hold — they are gitignored, so
 * there is no history to recover from. Overwriting one silently strands the
 * deployment that is still using those keys. Losing a guardian secret costs the
 * emergency-pause path; losing an operator secret can cost far more.
 */
function writeSecretsOrRefuse(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // "wx" creates-or-fails in one syscall, so no other process can slip a
  // secrets file in between the check and the write.
  try {
    const fd = fs.openSync(target, "wx", 0o600);
    try { fs.writeFileSync(fd, contents); } finally { fs.closeSync(fd); }
    return;
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
  }

  // The file already exists. Inspect and overwrite through a single descriptor
  // so the emptiness check applies to the very bytes we are about to replace.
  const fd = fs.openSync(target, "r+");
  try {
    if (fs.readFileSync(fd, "utf8").trim().length > 0) {
      throw new Error(
        `refusing to overwrite existing secrets at ${target}\n` +
        `    It holds the only copy of keys some deployment is still using.\n` +
        `    Point DEPLOY_STATE_PATH at a new state file, or move that file aside first.`
      );
    }
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, contents, 0, "utf8");
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const secret = process.env.TESTNET_DEPLOYER_SECRET;
  if (!secret) { console.error("TESTNET_DEPLOYER_SECRET not set"); process.exit(1); }
  const kp = Keypair.fromSecret(secret);
  const admin = kp.publicKey();
  const server = new sorobanRpc.Server(RPC_URL);
  const state = loadState();
  state.ops ??= {}; state.wasm ??= {}; state.contracts ??= {}; state.steps ??= {};
  const done = (k: string) => !!state.steps![k];
  const mark = (k: string) => { state.steps![k] = true; saveState(state); };

  console.log("════════════════════════════════════════════════");
  console.log("  KRYON TESTNET DEPLOYMENT (fresh, v2)");
  console.log(`  deployer: ${admin}`);
  console.log(`  dry-run : ${DRY}`);
  console.log("════════════════════════════════════════════════\n");

  // ── Step 0: preflight ──────────────────────────────────────────────────────
  console.log("Step 0 — Preflight");
  for (const [name, want] of Object.entries(EXPECTED_SHA256)) {
    const wasm = fs.readFileSync(path.join(ARTIFACTS, `${name}.wasm`));
    const got = crypto.createHash("sha256").update(wasm).digest("hex");
    if (got !== want) throw new Error(`artifact hash mismatch for ${name}: ${got}`);

    // The hash answers "is this the build we rehearsed?" — it cannot answer
    // "can this build ever be fixed?". Both live deployments shipped from a
    // build with no `upgrade` entrypoint, which froze every contract on
    // testnet and mainnet permanently: no audit finding can be patched there,
    // and the only remedy is a full redeploy and state migration. The hash was
    // correct the whole time. Check the interface, not just the bytes.
    const missing = missingLifecycleExports(contractExports(wasm));
    if (missing.length) {
      throw new Error(
        `${name} is missing ${missing.join(", ")} — refusing to deploy a contract ` +
        `that cannot be upgraded or handed over. This is exactly how the current testnet ` +
        `deployment became permanently immutable.`
      );
    }
  }
  console.log("  ✓ all 8 artifacts match the rehearsed hashes and expose upgrade/nominate_admin/accept_admin");

  if (!DRY) await server.getAccount(admin); // throws if unfunded/nonexistent

  // ── Step 1: ops accounts (reuse existing publisher/matcher/liquidator) ────
  console.log("\nStep 1 — Ops accounts");
  const ORACLE_PUB = process.env.ORACLE_PUBLISHER_ADDRESS;
  const MATCHER_PUB = process.env.MATCHER_OPERATOR_ADDRESS;
  const LIQUIDATOR_PUB = process.env.LIQUIDATOR_ADDRESS;
  // Key separation. The admin can replace every contract's code; the operator
  // roles sign continuously from keeper hosts and are the most exposed keys in
  // the system. A key that is both is one keeper compromise away from total
  // takeover — and that is not hypothetical: the deployment currently live on
  // testnet has the ORACLE PUBLISHER as protocol admin, confirmed on-chain.
  // The settlement route already states the rule ("one key must never serve two
  // roles"); nothing enforced it at the point where roles are assigned.
  const separationProblems = keySeparationViolations({
    admin,
    oracle: ORACLE_PUB,
    matcher: MATCHER_PUB,
    liquidator: LIQUIDATOR_PUB,
  });
  if (separationProblems.length) {
    throw new Error(
      "key separation violated — refusing to deploy:\n  - " + separationProblems.join("\n  - ")
    );
  }

  if (!ORACLE_PUB || !MATCHER_PUB || !LIQUIDATOR_PUB) {
    console.error("ORACLE_PUBLISHER_ADDRESS / MATCHER_OPERATOR_ADDRESS / LIQUIDATOR_ADDRESS must all be set");
    process.exit(1);
  }
  if (!done("ops_accounts")) {
    let guardianKp: Keypair;
    if (state.ops!["guardian"]) {
      guardianKp = Keypair.fromPublicKey(state.ops!["guardian"].pub);
    } else {
      guardianKp = Keypair.random();
      const account = await server.getAccount(admin);
      const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: NETWORK })
        .addOperation(Operation.createAccount({ destination: guardianKp.publicKey(), startingBalance: "2" }))
        .setTimeout(120)
        .build();
      if (!DRY) {
        tx.sign(kp);
        const send = await server.sendTransaction(tx);
        for (let i = 0; i < 30; i++) {
          await sleep(2000);
          const poll = await server.getTransaction(send.hash);
          if (poll.status === "SUCCESS") break;
          if (poll.status === "FAILED") throw new Error("guardian account creation failed");
        }
        writeSecretsOrRefuse(SECRETS_PATH, `# guardian\nGUARDIAN_PUBLIC=${guardianKp.publicKey()}\nGUARDIAN_SECRET=${guardianKp.secret()}\n`);
      }
    }
    state.ops!["oracle-publisher"] = { pub: ORACLE_PUB };
    state.ops!["matcher-operator"] = { pub: MATCHER_PUB };
    state.ops!["liquidator"] = { pub: LIQUIDATOR_PUB };
    state.ops!["guardian"] = { pub: guardianKp.publicKey() };
    mark("ops_accounts");
    console.log(`  ✓ reusing oracle=${ORACLE_PUB.slice(0, 8)}… matcher=${MATCHER_PUB.slice(0, 8)}… liquidator=${LIQUIDATOR_PUB.slice(0, 8)}…`);
    console.log(`  ✓ fresh guardian=${guardianKp.publicKey().slice(0, 8)}… secrets → ${SECRETS_PATH}`);
  } else {
    console.log("  ✓ already done");
  }
  const OPS = state.ops!;

  // ── Step 2: upload WASMs ───────────────────────────────────────────────────
  console.log("\nStep 2 — Upload WASMs");
  async function wasmOnChain(hashHex: string): Promise<boolean> {
    const key = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: Buffer.from(hashHex, "hex") })
    );
    for (const rpcUrl of RPC_POOL) {
      try {
        const s = new sorobanRpc.Server(rpcUrl);
        const res = await s.getLedgerEntries(key);
        return res.entries.length > 0;
      } catch { /* try next rpc */ }
    }
    throw new Error("all RPCs failed for getLedgerEntries");
  }

  for (const name of Object.keys(EXPECTED_SHA256)) {
    const want = EXPECTED_SHA256[name];
    if (state.wasm![name]) { console.log(`  ✓ ${name} already uploaded: ${state.wasm![name]}`); continue; }
    if (!DRY && (await wasmOnChain(want))) {
      console.log(`  ✓ ${name} already on-chain (prior attempt landed): ${want}`);
      state.wasm![name] = want; saveState(state);
      continue;
    }
    let uploaded = false;
    for (let attempt = 1; attempt <= 3 && !uploaded; attempt++) {
      const rpcUrl = RPC_POOL[(attempt - 1) % RPC_POOL.length];
      process.stdout.write(`  uploading ${name} (attempt ${attempt}, ${new URL(rpcUrl).host})...`);
      try {
        const h = cli([
          "contract", "upload",
          "--wasm", path.join(ARTIFACTS, `${name}.wasm`),
          "--source-account", secret,
          "--rpc-url", rpcUrl,
          "--network-passphrase", NETWORK,
          "--fee", "800000000",
          "--no-cache",
        ], `upload ${name}`, 480_000);
        console.log(` ✓ ${h}`);
        if (!DRY) {
          if (h !== want) throw new Error(`on-chain hash ${h} != expected for ${name}`);
          state.wasm![name] = h; saveState(state);
        }
        uploaded = true;
      } catch (e: any) {
        console.log(` ✗ ${String(e.message).split("\n").pop()}`);
        if (!DRY && (await wasmOnChain(want))) {
          console.log(`  ✓ ${name} landed despite the error`);
          state.wasm![name] = want; saveState(state);
          uploaded = true;
        } else if (attempt === 3) {
          throw new Error(`upload ${name}: exhausted retries`);
        }
      }
    }
  }

  // ── Step 3: deploy instances ───────────────────────────────────────────────
  console.log("\nStep 3 — Deploy instances");
  const order = ["perp_oracle_adapter", "perp_vault", "perp_risk", "perp_engine",
                 "perp_order_gateway", "perp_insurance", "perp_liquidation", "perp_governance"];

  const saltFor = (name: string) => crypto.createHash("sha256").update(`kryon-testnet-v2:${name}`).digest();
  const predictedId = (name: string) => {
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({
        networkId: hash(Buffer.from(NETWORK, "utf8")),
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({
            address: new Address(admin).toScAddress(),
            salt: saltFor(name),
          })
        ),
      })
    );
    return StrKey.encodeContract(hash(preimage.toXDR()));
  };
  async function instanceOnChain(cid: string): Promise<boolean> {
    const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
      contract: new Address(cid).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }));
    for (const rpcUrl of RPC_POOL) {
      try {
        const res = await new sorobanRpc.Server(rpcUrl).getLedgerEntries(key);
        return res.entries.length > 0;
      } catch { /* next rpc */ }
    }
    throw new Error("all RPCs failed for instance check");
  }

  for (const name of order) {
    if (state.contracts![name]) { console.log(`  ✓ ${name}: ${state.contracts![name]}`); continue; }
    const expectId = predictedId(name);
    if (!DRY && (await instanceOnChain(expectId))) {
      console.log(`  ✓ ${name} already deployed (prior attempt landed): ${expectId}`);
      state.contracts![name] = expectId; saveState(state);
      continue;
    }
    let deployed = false;
    for (let attempt = 1; attempt <= 3 && !deployed; attempt++) {
      const rpcUrl = RPC_POOL[(attempt - 1) % RPC_POOL.length];
      process.stdout.write(`  deploying ${name} (attempt ${attempt}, ${new URL(rpcUrl).host})...`);
      try {
        const id = cli([
          "contract", "deploy",
          "--wasm-hash", EXPECTED_SHA256[name],
          "--salt", saltFor(name).toString("hex"),
          "--source-account", secret,
          "--rpc-url", rpcUrl,
          "--network-passphrase", NETWORK,
          "--fee", "50000000",
          "--no-cache",
        ], `deploy ${name}`, 480_000);
        console.log(` ✓ ${id}`);
        if (!DRY) {
          if (id !== expectId) throw new Error(`deployed id ${id} != predicted ${expectId}`);
          state.contracts![name] = id; saveState(state);
        }
        deployed = true;
      } catch (e: any) {
        console.log(` ✗ ${String(e.message).split("\n").pop()}`);
        if (!DRY && (await instanceOnChain(expectId))) {
          console.log(`  ✓ ${name} landed despite the error: ${expectId}`);
          state.contracts![name] = expectId; saveState(state);
          deployed = true;
        } else if (attempt === 3) {
          throw new Error(`deploy ${name}: exhausted retries`);
        }
      }
    }
  }
  const C = state.contracts!;
  const [ORCL, VAULT, RISK, ENGINE, GW, INS, LIQ, GOV] = order.map((n) => C[n] ?? "DRY");

  // ── Step 4: initialize ─────────────────────────────────────────────────────
  console.log("\nStep 4 — Initialize");
  const initSteps: [string, string, string, xdr.ScVal[]][] = [
    ["init_oracle",   ORCL,  "initialize", [addr(admin)]],
    ["init_vault",    VAULT, "initialize", [addr(admin), addr(ORCL), addr(admin)]],
    ["init_risk",     RISK,  "initialize", [addr(admin)]],
    ["init_engine",   ENGINE,"initialize", [addr(admin), addr(ORCL), addr(VAULT), addr(USDC_CONTRACT)]],
    ["init_gateway",  GW,    "initialize", [addr(admin), addr(ENGINE)]],
    ["init_insurance",INS,   "initialize", [addr(admin), addr(LIQ)]],
    ["init_liquidation", LIQ,"initialize", [addr(admin), addr(ENGINE), addr(VAULT), addr(INS), addr(USDC_CONTRACT), u32(50)]],
    ["init_governance",GOV,  "initialize", [addr(admin), addr(OPS["guardian"].pub), u64(GOV_MIN_DELAY_SECS)]],
  ];
  for (const [key, id, method, args] of initSteps) {
    if (done(key)) { console.log(`  ✓ ${key} already done`); continue; }
    await call(server, kp, id, method, args, key, [3]);
    mark(key);
  }

  // ── Step 5: wire cross-references ─────────────────────────────────────────
  console.log("\nStep 5 — Wire");
  const wire: [string, string, string, xdr.ScVal[]][] = [
    ["wire_vault_engine",    VAULT,  "set_engine",        [addr(ENGINE)]],
    ["wire_engine_gateway",  ENGINE, "set_order_gateway", [addr(GW)]],
    ["wire_gw_operator",     GW,     "set_operator",      [addr(OPS["matcher-operator"].pub)]],
    ["wire_gw_domain",       GW,     "set_domain",        [xdr.ScVal.scvBytes(Buffer.from(NETWORK, "utf8"))]],
    ["wire_vault_collateral",VAULT,  "set_collateral",    [addr(USDC_CONTRACT), sym("USDC"), u32(0), boolv(true)]],
    ["wire_engine_insurance",ENGINE, "set_insurance",     [addr(INS)]],
    ["wire_engine_liq",      ENGINE, "set_liquidation",   [addr(LIQ)]],
    ["wire_vault_insurance", VAULT,  "set_insurance",     [addr(INS)]],
    ["wire_vault_liq",       VAULT,  "set_liquidation",   [addr(LIQ)]],
    ["wire_ins_vault",       INS,    "set_vault",         [addr(VAULT)]],
    // Vault operator for settle_deficit. Losses debit the settlement asset on
    // every fill, so an account margined in another collateral carries a
    // negative settlement balance while perfectly healthy; the liquidator
    // keeper already watches accounts, so it clears them.
    ["wire_vault_operator",  VAULT,  "set_operator",      [addr(OPS["liquidator"].pub)]],
  ];
  for (const [key, id, method, args] of wire) {
    if (done(key)) { console.log(`  ✓ ${key} already done`); continue; }
    await call(server, kp, id, method, args, key);
    mark(key);
  }

  // ── Step 6: oracle feeds — XLM (base asset) AND USDC (collateral) ──────────
  //
  // USDC is not optional here. It is the settlement/collateral asset, and every
  // settlement prices collateral through it:
  //   gateway.settle_fill_signed → engine.open_position
  //     → sync_and_require_initial_margin → vault.account_health
  //       → oracle.get_price("USDC")
  // `get_price` returns InvalidConfig (#5) for an unregistered asset, so a
  // deployment with no USDC feed cannot settle a single trade on ANY market —
  // the matcher writes each fill, settlement simulation fails, and
  // `rollbackFill` deletes it again. This step previously registered XLM only,
  // which is exactly how the v2 testnet deployment ended up unable to trade
  // while looking healthy. See scripts/setup-usdc-feed.ts to remediate an
  // environment already deployed without it.
  console.log("\nStep 6 — Oracle feeds (XLM + USDC)");
  if (!done("oracle_feed")) {
    const guard = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("max_age_secs"),       val: u64(120n) }),
      new xdr.ScMapEntry({ key: sym("max_confidence_bps"), val: u32(1000) }),
    ]);
    await call(server, kp, ORCL, "set_feed", [
      sym("XLM"),
      addr(OPS["oracle-publisher"].pub),
      xdr.ScVal.scvVec([sym("RedStone")]),
      guard,
      boolv(true),
    ], "oracle.set_feed(XLM)");

    // Wider staleness window than a traded asset: the keeper deliberately halts
    // USDC publication on a depeg so settlement fails closed, and 600s keeps
    // that fail-stop meaningful while leaving room above its ≤90s heartbeat.
    const usdcGuard = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("max_age_secs"),       val: u64(600n) }),
      new xdr.ScMapEntry({ key: sym("max_confidence_bps"), val: u32(500) }),
    ]);
    await call(server, kp, ORCL, "set_feed", [
      sym("USDC"),
      addr(OPS["oracle-publisher"].pub),
      xdr.ScVal.scvVec([sym("RedStone")]),
      usdcGuard,
      boolv(true),
    ], "oracle.set_feed(USDC)");
    mark("oracle_feed");
  } else console.log("  ✓ already done");

  // ── Step 7: XLM-PERP market ─────────────────────────────────────────────────
  console.log("\nStep 7 — XLM-PERP market");
  const coreMarketConfig = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym("active"),                    val: boolv(true) }),
    new xdr.ScMapEntry({ key: sym("base_asset"),                val: sym("XLM") }),
    new xdr.ScMapEntry({ key: sym("initial_margin_bps"),        val: u32(1000) }),
    new xdr.ScMapEntry({ key: sym("liquidation_fee_bps"),       val: u32(50) }),
    new xdr.ScMapEntry({ key: sym("maintenance_margin_bps"),    val: u32(500) }),
    new xdr.ScMapEntry({ key: sym("market_id"),                 val: u32(1) }),
    new xdr.ScMapEntry({ key: sym("max_leverage_bps"),          val: u32(100000) }),
    new xdr.ScMapEntry({ key: sym("max_open_interest"),         val: i128(PRECISION * 100_000n) }),
    new xdr.ScMapEntry({ key: sym("max_oracle_age_secs"),       val: u64(120n) }),
    new xdr.ScMapEntry({ key: sym("max_oracle_confidence_bps"), val: u32(1000) }),
    new xdr.ScMapEntry({ key: sym("settlement_asset"),          val: addr(USDC_CONTRACT) }),
  ]);
  if (!done("market_engine")) {
    const engineMarketConfig = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("market"),                      val: coreMarketConfig }),
      new xdr.ScMapEntry({ key: sym("max_execution_deviation_bps"), val: u32(1000) }),
    ]);
    await call(server, kp, ENGINE, "set_market", [engineMarketConfig], "engine.set_market");
    mark("market_engine");
  } else console.log("  ✓ engine market already set");

  // ── Step 8: guardian + deposit cap ─────────────────────────────────────────
  console.log("\nStep 8 — Guardian + deposit cap");
  const guardianPub = OPS["guardian"].pub;
  const g: [string, string, string, xdr.ScVal[]][] = [
    ["guardian_vault", VAULT, "set_guardian",    [addr(guardianPub)]],
    ["guardian_gw",    GW,    "set_guardian",    [addr(guardianPub)]],
    ["cap_usdc",       VAULT, "set_deposit_cap", [addr(USDC_CONTRACT), i128(DEPOSIT_CAP_USDC)]],
  ];
  for (const [key, id, method, args] of g) {
    if (done(key)) { console.log(`  ✓ ${key} already done`); continue; }
    await call(server, kp, id, method, args, key);
    mark(key);
  }

  // ── Step 9: instance TTL keepalive ─────────────────────────────────────────
  console.log("\nStep 9 — Extend instance TTLs");
  const ttlTargets: [string, string][] = [
    ["ttl_oracle", ORCL], ["ttl_vault", VAULT], ["ttl_engine", ENGINE], ["ttl_gw", GW],
  ];
  for (const [key, id] of ttlTargets) {
    if (done(key)) { console.log(`  ✓ ${key} already done`); continue; }
    await call(server, kp, id, "extend_instance_ttl", [], key);
    mark(key);
  }

  // ── Manifest ───────────────────────────────────────────────────────────────
  console.log("\n════════════════ DEPLOYED ════════════════");
  for (const name of order) console.log(`  ${name.padEnd(20)} ${C[name]}`);
  console.log(`  usdc (SAC)          ${USDC_CONTRACT}`);
  console.log(`\nState: ${STATE_PATH}\nSecrets (guardian): ${SECRETS_PATH}`);
  console.log("\nNext: register the other 7 markets —");
  console.log(`  MARKET_ADMIN_SECRET=<deployer> ORACLE_PUBLISHER_ADDRESS=${OPS["oracle-publisher"].pub} \\`);
  console.log("    npx tsx scripts/add-market.ts --all");
  console.log("Then update config/networks.ts TESTNET_DEFAULTS and the Railway env vars with the addresses above.");
}

main().catch((e) => { console.error("\n❌ ", e.message ?? e); process.exit(1); });
