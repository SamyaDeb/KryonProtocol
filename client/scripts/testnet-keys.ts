#!/usr/bin/env tsx
/**
 * testnet-keys — generate the arc-testnet key set and record the role
 * addresses where the deploy script reads them.
 *
 *   npx tsx scripts/testnet-keys.ts [--out DIR] [--passphrase-file FILE] [--write-toml]
 *
 * Creates one encrypted JSON v3 keystore per key (scrypt, as geth writes
 * them), all under one passphrase:
 *
 *   service roles (lib/chain/signer.ts): MATCHER_OPERATOR, ORACLE_PUBLISHER
 *   ×2 (one per publisher host), FUNDING_KEEPER, LIQUIDATOR, REFILL_FUNDER,
 *   FEE_TIER_BOT, BACKSTOP_SIGNER
 *   testnet admin wallets: DEPLOYER (single use; renounces at handover),
 *   GOVERNANCE (timelock proposer and executor), GUARDIAN, TREASURY
 *
 * Mainnet never uses this: its governance, guardian and treasury are Safes
 * and its service keys live in KMS (infra/signers/README.md).
 *
 * Nothing leaves this machine. Every file is created exclusively (never
 * overwriting an existing key or passphrase), readable by you only, and no
 * private key is printed. Without
 * --passphrase-file it generates a random passphrase into DIR/passphrase.
 *
 * Output: addresses, the env lines each service needs (keystore mode), and
 * which addresses need testnet USDC from https://faucet.circle.com. With
 * --write-toml it also fills the role lines of
 * kryon-protocol/infra/deploy/environments/arc-testnet.toml.
 */

import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

import { encryptKeystore } from "@/lib/chain/signer-keystore";
import { applyTestnetRoles } from "@/lib/ops/testnet-roles";

interface KeySpec {
  file: string;
  /** Signer role for services; null for admin wallets. */
  role: string | null;
  /** Needs gas (testnet USDC) before it can act. */
  gas: "deploy" | "operate" | "little" | "none";
  what: string;
}

const KEYS: KeySpec[] = [
  { file: "deployer", role: null, gas: "deploy", what: "runs DeployAll once, then holds nothing" },
  { file: "governance", role: null, gas: "little", what: "timelock proposer + executor (testnet stand-in for the governance Safe)" },
  { file: "guardian", role: null, gas: "little", what: "PAUSER_ROLE (testnet stand-in for the guardian Safe)" },
  { file: "treasury", role: null, gas: "none", what: "receives treasury fees (testnet stand-in for the treasury Safe)" },
  { file: "matcher-operator", role: "MATCHER_OPERATOR", gas: "operate", what: "OPERATOR_ROLE: settles batches" },
  { file: "oracle-publisher-1", role: "ORACLE_PUBLISHER", gas: "operate", what: "publisher on host 1" },
  { file: "oracle-publisher-2", role: "ORACLE_PUBLISHER", gas: "operate", what: "publisher on host 2 (ORACLE_START_OFFSET_MS=500)" },
  { file: "funding-keeper", role: "FUNDING_KEEPER", gas: "operate", what: "KEEPER_ROLE: hourly funding" },
  { file: "liquidator", role: "LIQUIDATOR", gas: "operate", what: "liquidations and ADL (no role)" },
  { file: "refill-funder", role: "REFILL_FUNDER", gas: "operate", what: "tops up the other service keys' gas" },
  { file: "fee-tier-bot", role: "FEE_TIER_BOT", gas: "little", what: "FEE_TIER_ROLE (idle until tiers are on)" },
  { file: "backstop-signer", role: "BACKSTOP_SIGNER", gas: "none", what: "signs Insurance unwind orders (role granted later, via timelock)" },
];

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const OUT = resolve(value("--out") ?? join(homedir(), ".kryon", "arc-testnet"));
const TOML = resolve(import.meta.dirname, "../../kryon-protocol/infra/deploy/environments/arc-testnet.toml");

/**
 * Create `path` with `contents`, failing if it already exists.
 *
 * Exclusive create (O_CREAT|O_EXCL) rather than "check, then write": the
 * check-then-write pair can be raced, and overwriting a key that already
 * holds testnet funds — or a passphrase that unlocks one — destroys it.
 */
function writeNew(path: string, contents: string, what: string): void {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`refusing to overwrite ${what}: ${path}`);
    }
    throw e;
  }
  try {
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

function main() {
  mkdirSync(OUT, { recursive: true, mode: 0o700 });

  let passFile = value("--passphrase-file");
  if (!passFile) {
    passFile = join(OUT, "passphrase");
    writeNew(passFile, randomBytes(32).toString("base64url"), "the passphrase file");
  }
  passFile = resolve(passFile);
  const passphrase = readFileSync(passFile, "utf8").trim();
  if (passphrase.length < 16) throw new Error("the passphrase must be at least 16 characters");

  const made: (KeySpec & { address: Address; path: string })[] = [];
  for (const k of KEYS) {
    const pk = generatePrivateKey();
    const path = join(OUT, `${k.file}.json`);
    writeNew(path, JSON.stringify(encryptKeystore(pk, passphrase)), `the ${k.file} keystore`);
    made.push({ ...k, address: privateKeyToAccount(pk).address, path });
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  const addr = (file: string) => made.find((m) => m.file === file)!.address;
  const roles = {
    governance: addr("governance"),
    guardian: addr("guardian"),
    treasury: addr("treasury"),
    operators: [addr("matcher-operator")],
    publishers: [addr("oracle-publisher-1"), addr("oracle-publisher-2")],
    fundingKeepers: [addr("funding-keeper")],
    feeTierBots: [addr("fee-tier-bot")],
  };

  const say = (s = "") => process.stdout.write(`${s}\n`);
  say(`\nKeystores in ${OUT} (mode 0600), passphrase file ${passFile}\n`);
  for (const m of made) say(`  ${m.file.padEnd(20)} ${m.address}  ${m.what}`);

  if (flag("--write-toml")) {
    writeFileSync(TOML, applyTestnetRoles(readFileSync(TOML, "utf8"), roles));
    say(`\nWrote the role addresses into ${TOML}.`);
  } else {
    say(`\nRe-run with --write-toml to record the role addresses in arc-testnet.toml.`);
  }

  say(`\nService env (keystore mode). One process per key; the second publisher host uses its own file:`);
  for (const m of made.filter((x) => x.role && x.file !== "oracle-publisher-2")) {
    say(`  KRYON_SIGNER_${m.role}=keystore`);
    say(`  KRYON_KEYSTORE_${m.role}=${m.path}`);
    say(`  KRYON_KEYSTORE_${m.role}_PASSPHRASE_FILE=${passFile}`);
  }
  say(`  REFILL_TARGETS=${["matcher-operator", "oracle-publisher-1", "oracle-publisher-2", "funding-keeper", "liquidator"].map((f) => `${f}:${addr(f)}`).join(",")}`);

  say(`\nFund from https://faucet.circle.com (Arc testnet USDC, which is also gas):`);
  for (const m of made.filter((x) => x.gas !== "none")) {
    const how = m.gas === "deploy" ? "enough for DeployAll" : m.gas === "operate" ? "a working float" : "a little";
    say(`  ${m.address}  ${m.file} (${how})`);
  }
  say(`\nDeploy (from kryon-protocol/evm): KRYON_NETWORK=arc-testnet DEPLOYER_ADDRESS=${addr("deployer")} arc-forge script script/DeployAll.s.sol --broadcast \\`);
  say(`          --keystore ${join(OUT, "deployer.json")} --password-file ${passFile} --sender ${addr("deployer")} --rpc-url <ARC_TESTNET_RPC>`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`testnet-keys: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
