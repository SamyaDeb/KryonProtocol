#!/usr/bin/env tsx
/**
 * list-usdt0.ts — list USDT0 as vault collateral on mainnet, in the only order
 * that is safe.
 *
 * ── Why the order is the whole point ─────────────────────────────────────────
 * `vault.account_health` prices EVERY asset the account holds. The moment
 * USDT0 is listed and someone deposits it, every health check on that account
 * calls `oracle.get_price("USDT0")`. If that feed does not exist, or is stale,
 * `get_price` errors and the account can no longer trade, withdraw, OR be
 * liquidated — the position is frozen with real money in it.
 *
 * That is not hypothetical here: testnet ran with zero settled trades for weeks
 * because the USDC feed was missing and every settlement simulation failed. The
 * same failure with a collateral asset already deposited is strictly worse,
 * because funds are inside when it happens.
 *
 * So this script refuses to list the asset until it has read a live, guard-
 * passing price back off the chain. Feed first, verify, then list.
 *
 * ── Risk parameters ──────────────────────────────────────────────────────────
 * USDT0_HAIRCUT_BPS (default 500 = 5%) prices what can go wrong with the asset:
 * Tether issuer risk, plus LayerZero OFT bridge risk, plus a thin Stellar-side
 * book. It is deliberately wider than USDC's 0.
 *
 * USDT0_DEPOSIT_CAP (default 50_000) is the more important control. It is not a
 * TVL target — it is the most USDT0 you believe you could actually unwind into
 * USDC on-chain in a bad hour. Stellar-side USDT0 supply was ~$2.6M with 89
 * funded trustlines when this was written. Start small, raise it with observed
 * depth.
 *
 * ── If admin is the governance timelock ──────────────────────────────────────
 * As it must be before mainnet: these calls cannot be signed directly. The
 * script detects that and stops, printing what to queue instead.
 *
 * ── Testnet ─────────────────────────────────────────────────────────────────
 * Works the same against testnet, where USDT0 is the mock issued by
 * scripts/deploy-testnet-usdt0.ts. Rehearse the whole sequence there first: a
 * first collateral listing has real money inside it when it goes wrong.
 *
 * Usage:
 *   VAULT_ADMIN_SECRET=S… ORACLE_ADMIN_SECRET=S… npx tsx scripts/list-usdt0.ts --dry-run
 */

import {
  Keypair, Account, Contract, TransactionBuilder,
  nativeToScVal, scValToNative, xdr, rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK, COLLATERAL } from "@/config";

const FEE = "1000000";
const DRY_RUN = process.argv.includes("--dry-run");

const HAIRCUT_BPS = Number(process.env.USDT0_HAIRCUT_BPS ?? "500");
// Testnet caps exist to exercise the cap path, not to bound risk, so they are
// generous. The mainnet default is deliberately small — see the note above.
const DEFAULT_CAP = NETWORK.name === "testnet" ? "1000000" : "50000";
const DEPOSIT_CAP_HUMAN = Number(process.env.USDT0_DEPOSIT_CAP ?? DEFAULT_CAP);
const MAX_AGE_SECS = BigInt(process.env.USDT0_MAX_AGE_SECS ?? "600");
const MAX_CONFIDENCE_BPS = Number(process.env.USDT0_MAX_CONFIDENCE_BPS ?? "500");

const PRICE_PRECISION = BigInt("1000000000000000000"); // 1e18, contract scale
const AMOUNT_PRECISION = BigInt("10000000"); // 1e7, Stellar decimals
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const usdt0 = COLLATERAL.find((c) => c.code === "USDT0");

async function simulate(
  server: sorobanRpc.Server,
  from: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<xdr.ScVal | null> {
  const account = await server.getAccount(from);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) return null;
  return sim.result?.retval ?? null;
}

async function submit(
  server: sorobanRpc.Server,
  kp: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  label: string
): Promise<void> {
  const account: Account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(90)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`${label} simulation failed: ${sim.error}`);
  }
  if (DRY_RUN) {
    console.log(`  [dry-run] ${label} simulated OK — not submitted`);
    return;
  }

  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  process.stdout.write(`  ${label}…`);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") {
    throw new Error(`${label} submit rejected: ${JSON.stringify(send.errorResult)}`);
  }
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") { process.stdout.write(` ✓  ${send.hash}\n`); return; }
    if (poll.status === "FAILED") throw new Error(`${label} failed on-chain — hash ${send.hash}`);
    if (i % 5 === 0) process.stdout.write(".");
  }
  throw new Error(`${label} confirmation timed out — hash ${send.hash}`);
}

/** Refuses to continue unless `signer` is the contract's current admin. */
async function assertAdmin(
  server: sorobanRpc.Server,
  contractId: string,
  contractLabel: string,
  signer: string
): Promise<void> {
  const val = await simulate(server, signer, contractId, "admin", []);
  const admin = val ? (scValToNative(val) as string | null) : null;
  if (!admin) {
    console.warn(`  ⚠  Could not read ${contractLabel} admin — continuing, the call will fail if the signer is wrong.`);
    return;
  }
  if (admin !== signer) {
    console.error(
      `\n❌  ${contractLabel} admin is ${admin}, not the signer ${signer}.\n\n` +
      `    If that address is the governance timelock, this change cannot be\n` +
      `    signed directly — queue it as a proposal instead, and let the 48h\n` +
      `    delay run. That is the intended path for listing a collateral asset.\n`
    );
    process.exit(1);
  }
}

async function main() {
  if (!usdt0) {
    console.error("❌  USDT0 is not in this network's collateral registry.");
    if (NETWORK.name === "testnet") {
      console.error(
        "\n    Testnet has no USDT0 issuance of its own. Issue a mock first:\n" +
        "      npx tsx scripts/deploy-testnet-usdt0.ts\n" +
        "    then set NEXT_PUBLIC_ASSET_USDT0 and NEXT_PUBLIC_USDT0_ISSUER from its output."
      );
    } else {
      console.error("    Expected it in config/networks.ts for mainnet.");
    }
    process.exit(1);
  }

  const vaultSecret = process.env.VAULT_ADMIN_SECRET;
  const oracleSecret = process.env.ORACLE_ADMIN_SECRET;
  if (!vaultSecret || !oracleSecret) {
    console.error(
      "❌  Need VAULT_ADMIN_SECRET (set_collateral, set_deposit_cap) and\n" +
      "    ORACLE_ADMIN_SECRET (set_feed). They may be the same key."
    );
    process.exit(1);
  }
  const vaultKp = Keypair.fromSecret(vaultSecret);
  const oracleKp = Keypair.fromSecret(oracleSecret);
  const publisher = process.env.ORACLE_PUBLISHER_PUBKEY;
  if (!publisher) {
    console.error(
      "❌  ORACLE_PUBLISHER_PUBKEY is required — it must be the SAME key the\n" +
      "    oracle keeper publishes with, or every write_price is Unauthorized."
    );
    process.exit(1);
  }

  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const cap = BigInt(Math.round(DEPOSIT_CAP_HUMAN)) * AMOUNT_PRECISION;

  console.log(`Network     : ${NETWORK.name}`);
  console.log(`Vault       : ${CONTRACTS.vault}`);
  console.log(`Oracle      : ${CONTRACTS.oracleAdapter}`);
  console.log(`USDT0 SAC   : ${usdt0.contract}`);
  console.log(`Haircut     : ${HAIRCUT_BPS}bps (${(HAIRCUT_BPS / 100).toFixed(2)}%)`);
  console.log(`Deposit cap : ${DEPOSIT_CAP_HUMAN.toLocaleString()} USDT0`);
  console.log(DRY_RUN ? "Mode        : DRY RUN\n" : "");

  await assertAdmin(server, CONTRACTS.oracleAdapter, "Oracle adapter", oracleKp.publicKey());
  await assertAdmin(server, CONTRACTS.vault, "Vault", vaultKp.publicKey());

  // ── 0a. Does this vault carry the seizure fix? ────────────────────────────
  // A vault without seize_for_deficit cannot make non-settlement collateral pay
  // for losses: a USDT0-margined trader's losses debit USDC they never held,
  // liquidation drains the insurance fund, and their USDT0 is never touched.
  // Listing is still possible — set_collateral predates the fix — so this warns
  // rather than blocks, but it must be a deliberate choice.
  const seizeProbe = await simulate(server, vaultKp.publicKey(), CONTRACTS.vault, "operator", []);
  const hasSeizure = !(seizeProbe === null);
  if (!hasSeizure) {
    console.warn(
      `\n  ⚠  WARNING — this vault predates multi-collateral support.\n` +
      `     It has no seize_for_deficit, so a USDT0-margined trader's losses will\n` +
      `     drain the INSURANCE FUND while their USDT0 sits untouched. Their\n` +
      `     settlement balance will also go negative and stay there.\n` +
      `     Acceptable on testnet to exercise the flow. Never on mainnet.\n`
    );
  }

  // ── 0. Confirm the SAC is the token we think it is ────────────────────────
  const decimalsVal = await simulate(server, vaultKp.publicKey(), usdt0.contract, "decimals", []);
  const decimals = decimalsVal ? Number(scValToNative(decimalsVal)) : null;
  if (decimals !== 7) {
    console.error(`❌  USDT0 SAC reported decimals=${decimals}, expected 7. Wrong contract id?`);
    process.exit(1);
  }
  console.log(`  ✓ SAC reachable, decimals=7\n`);

  // ── 1. Feed FIRST ─────────────────────────────────────────────────────────
  const guard = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_age_secs"), val: nativeToScVal(MAX_AGE_SECS, { type: "u64" }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_confidence_bps"), val: nativeToScVal(MAX_CONFIDENCE_BPS, { type: "u32" }) }),
  ]);
  await submit(server, oracleKp, CONTRACTS.oracleAdapter, "set_feed", [
    xdr.ScVal.scvSymbol("USDT0"),
    nativeToScVal(publisher, { type: "address" }),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("RedStone")]),
    guard,
    xdr.ScVal.scvBool(true),
  ], "set_feed(USDT0)");

  // Seed a first price so the gate below can pass before the keeper has been
  // reconfigured. This mirrors setup-usdc-feed.ts: a bridge, NOT a standing peg.
  // The keeper sources USDT/USD for real and takes over from here — if it never
  // does, this price goes stale and every account holding USDT0 freezes, which
  // is why the reminder below is not optional.
  const publisherSecret = process.env.ORACLE_PUBLISHER_SECRET;
  if (publisherSecret) {
    const publisherKp = Keypair.fromSecret(publisherSecret);
    if (publisherKp.publicKey() !== publisher) {
      console.error(
        `\n❌  ORACLE_PUBLISHER_SECRET is ${publisherKp.publicKey()} but the feed was\n` +
        `    registered to ${publisher}. write_price would be rejected.`
      );
      process.exit(1);
    }
    await submit(server, publisherKp, CONTRACTS.oracleAdapter, "write_price", [
      xdr.ScVal.scvSymbol("USDT0"),
      nativeToScVal(publisher, { type: "address" }),
      nativeToScVal(PRICE_PRECISION, { type: "i128" }),
      nativeToScVal(PRICE_PRECISION / 200n, { type: "i128" }),
      nativeToScVal(BigInt(Math.floor(Date.now() / 1000)), { type: "u64" }),
    ], "write_price(USDT0, $1.00 seed)");
  }

  console.log(
    "\n  ⚠  The keeper MUST take over this feed: set ORACLE_PUBLISH_USDT0=true in\n" +
    "     the oracle-keeper env and restart it. A stale collateral feed reverts\n" +
    "     every account_health call, which freezes trading, withdrawals AND\n" +
    "     liquidations for anyone holding USDT0.\n"
  );

  // ── 2. Do NOT list until a price reads back cleanly ───────────────────────
  if (DRY_RUN) {
    console.log("  [dry-run] skipping the price gate and the listing calls.\n");
    console.log("✓ Dry run clean — rerun without --dry-run to apply.");
    return;
  }

  process.stdout.write("  Waiting for a guard-passing USDT0 price");
  let priced = false;
  for (let i = 0; i < 60; i++) {
    const val = await simulate(server, vaultKp.publicKey(), CONTRACTS.oracleAdapter, "get_price", [
      xdr.ScVal.scvSymbol("USDT0"),
      xdr.ScVal.scvVoid(),
    ]);
    if (val) {
      const snap = scValToNative(val) as Record<string, unknown>;
      const price = BigInt(String(snap["price"] ?? "0"));
      if (price > 0n) {
        console.log(`\n  ✓ USDT0 priced at $${(Number(price) / Number(PRICE_PRECISION)).toFixed(4)}\n`);
        priced = true;
        break;
      }
    }
    process.stdout.write(".");
    await sleep(5000);
  }
  if (!priced) {
    console.error(
      "\n\n❌  No guard-passing USDT0 price after 5 minutes. NOT listing the asset.\n" +
      "    Listing it now would freeze any account that deposits it: every\n" +
      "    account_health call would revert, blocking trades, withdrawals and\n" +
      "    liquidations alike.\n\n" +
      "    Check that the keeper is running with ORACLE_PUBLISH_USDT0=true and\n" +
      "    that its publisher key matches ORACLE_PUBLISHER_PUBKEY."
    );
    process.exit(1);
  }

  // ── 3. Cap before listing, so the cap is live the instant deposits open ────
  await submit(server, vaultKp, CONTRACTS.vault, "set_deposit_cap", [
    nativeToScVal(usdt0.contract, { type: "address" }),
    nativeToScVal(cap, { type: "i128" }),
  ], `set_deposit_cap(USDT0, ${DEPOSIT_CAP_HUMAN})`);

  await submit(server, vaultKp, CONTRACTS.vault, "set_collateral", [
    nativeToScVal(usdt0.contract, { type: "address" }),
    xdr.ScVal.scvSymbol("USDT0"),
    nativeToScVal(HAIRCUT_BPS, { type: "u32" }),
    xdr.ScVal.scvBool(true),
  ], `set_collateral(USDT0, ${HAIRCUT_BPS}bps, active)`);

  // ── 4. Read back what the chain actually thinks ───────────────────────────
  const configVal = await simulate(server, vaultKp.publicKey(), CONTRACTS.vault, "collateral", [
    nativeToScVal(usdt0.contract, { type: "address" }),
  ]);
  const config = configVal ? (scValToNative(configVal) as Record<string, unknown> | null) : null;
  if (!config && hasSeizure) {
    console.error("❌  Listing did not take — vault.collateral(USDT0) is absent or inactive.");
    process.exit(1);
  }
  if (!config) {
    // Old vault: no `collateral` view to read back. The set_collateral call
    // above succeeded on-chain, and deposit_cap reads back, which is as much
    // confirmation as this contract can give.
    const capVal = await simulate(server, vaultKp.publicKey(), CONTRACTS.vault, "deposit_cap", [
      nativeToScVal(usdt0.contract, { type: "address" }),
    ]);
    console.log(
      `\n✓ USDT0 listed at ${HAIRCUT_BPS}bps, cap ${DEPOSIT_CAP_HUMAN.toLocaleString()}.\n` +
      `  (cap reads back as ${capVal ? String(scValToNative(capVal)) : "unreadable"}; this vault has\n` +
      `   no collateral view, so that is the only read-back available.)\n`
    );
    return;
  }
  if (!config["active"]) {
    console.error("❌  Listing did not take — vault.collateral(USDT0) is inactive.");
    process.exit(1);
  }

  console.log(
    `\n✓ USDT0 listed: haircut ${config["haircut_bps"]}bps, oracle symbol ` +
    `${String(config["oracle_asset"])}, cap ${DEPOSIT_CAP_HUMAN.toLocaleString()}.\n\n` +
    "  Still to do, and none of it is optional:\n" +
    "    • Alert on the USDT0 feed's age and on any price outside ±50bps.\n" +
    "    • Alert on CollateralSeized events with a non-zero uncovered_value.\n" +
    "    • Point the keeper's settle_deficit operator at the vault (set_operator).\n" +
    "    • Do NOT flip active=false to respond to a depeg — it erases the asset\n" +
    "      from equity and traps withdrawals. Raise the haircut or lower the cap.\n"
  );
}

main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
