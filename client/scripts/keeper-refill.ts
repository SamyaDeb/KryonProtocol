#!/usr/bin/env tsx
/**
 * Keeper refill — converts protocol USDC revenue into XLM and tops up the
 * keeper wallets that pay Kryon's on-chain fees.
 *
 * Why this exists: the protocol earns fees in USDC but spends XLM. Nothing
 * connects the two, so the oracle keeper, matcher, liquidator and TTL keeper
 * drain monotonically no matter how much volume the venue does. Left alone they
 * eventually stop, and a stopped oracle halts settlement. This closes that loop.
 *
 * What it does, per run:
 *   1. Reads the XLM balance of every configured keeper.
 *   2. Tops any wallet below KEEPER_XLM_FLOOR back up to KEEPER_XLM_TARGET.
 *   3. If the funding account lacks the XLM, buys exactly the shortfall on the
 *      Stellar DEX with USDC (path payment strict receive, slippage-bounded).
 *
 * Refuses to move anything unless --execute is passed. Default is a dry run
 * that prints the exact plan.
 *
 * Env:
 *   REFILL_SOURCE_SECRET   funding account (falls back to MAINNET_DEPLOYER_SECRET)
 *   ORACLE_PUBLISHER_SECRET / MATCHER_OPERATOR_SECRET
 *   LIQUIDATOR_SECRET / TTL_KEEPER_SECRET
 *   KEEPER_XLM_FLOOR       top up below this (default 25)
 *   KEEPER_XLM_TARGET      top up to this (default 100)
 *   REFILL_MAX_USDC        hard cap on USDC spent per run (default 50)
 *   REFILL_SLIPPAGE_BPS    max slippage on the USDC->XLM swap (default 100)
 *
 * Usage:
 *   npx tsx scripts/keeper-refill.ts             # dry run
 *   npx tsx scripts/keeper-refill.ts --execute   # actually move funds
 */

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { ASSETS, NETWORK } from "../config";

const EXECUTE = process.argv.includes("--execute");

const KEEPER_XLM_FLOOR = Number(process.env.KEEPER_XLM_FLOOR ?? "25");
const KEEPER_XLM_TARGET = Number(process.env.KEEPER_XLM_TARGET ?? "100");
const REFILL_MAX_USDC = Number(process.env.REFILL_MAX_USDC ?? "50");
const REFILL_SLIPPAGE_BPS = Number(process.env.REFILL_SLIPPAGE_BPS ?? "100");

// Stellar's base reserve (1 XLM) plus one subentry for the USDC trustline, plus
// headroom for fees. The funding account must never be drained below this or it
// becomes unusable and cannot refill anything.
const SOURCE_XLM_RESERVE = 3;

type Keeper = { name: string; address: string };

function keeperAddress(secretEnv: string, pubkeyEnv?: string): string | null {
  const pub = pubkeyEnv ? process.env[pubkeyEnv] : undefined;
  if (pub) return pub;
  const secret = process.env[secretEnv];
  if (!secret) return null;
  try {
    return Keypair.fromSecret(secret).publicKey();
  } catch {
    return null;
  }
}

function keepers(): Keeper[] {
  const candidates = [
    { name: "oracle", address: keeperAddress("ORACLE_PUBLISHER_SECRET") },
    { name: "matcher", address: keeperAddress("MATCHER_OPERATOR_SECRET", "MATCHER_OPERATOR_PUBKEY") },
    { name: "liquidator", address: keeperAddress("LIQUIDATOR_SECRET") },
    { name: "ttl-keeper", address: keeperAddress("TTL_KEEPER_SECRET") },
  ];
  return candidates.filter((k): k is Keeper => k.address !== null);
}

function fmt(n: number): string {
  return n.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
}

async function nativeBalance(server: Horizon.Server, address: string): Promise<number | null> {
  try {
    const acct = await server.loadAccount(address);
    return Number(acct.balances.find((b) => b.asset_type === "native")?.balance ?? "0");
  } catch (e) {
    // `Horizon.NetworkError` is not exported by this SDK version, so the old
    // `e instanceof Horizon.NetworkError` threw a TypeError ("right-hand side
    // of instanceof is not callable") every time this catch ran — turning a
    // missing account, the one case this is meant to handle, into a confusing
    // crash. Match on the response shape instead.
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 404) return null;
    throw e;
  }
}

async function main() {
  const sourceSecret = process.env.REFILL_SOURCE_SECRET ?? process.env.MAINNET_DEPLOYER_SECRET;
  if (!sourceSecret) throw new Error("REFILL_SOURCE_SECRET (or MAINNET_DEPLOYER_SECRET) is not set");
  const sourceKp = Keypair.fromSecret(sourceSecret);

  const server = new Horizon.Server(NETWORK.horizonUrl);
  const usdc = new Asset("USDC", ASSETS.usdcIssuer);

  console.log(`Kryon keeper refill — ${EXECUTE ? "\x1b[31mEXECUTE\x1b[0m" : "dry run"}`);
  console.log(`  Network : ${NETWORK.name}`);
  console.log(`  Source  : ${sourceKp.publicKey()}`);
  console.log(`  Policy  : top up below ${KEEPER_XLM_FLOOR} XLM, up to ${KEEPER_XLM_TARGET} XLM\n`);

  const targets = keepers();
  if (!targets.length) throw new Error("no keeper secrets configured — nothing to refill");

  // ── 1. Work out who needs what ──────────────────────────────────────────────
  const deficits: { keeper: Keeper; have: number; need: number }[] = [];
  for (const keeper of targets) {
    const have = await nativeBalance(server, keeper.address);
    if (have === null) {
      console.log(`  ⚠ ${keeper.name.padEnd(11)} account does not exist — skipping (needs manual creation)`);
      continue;
    }
    if (have >= KEEPER_XLM_FLOOR) {
      console.log(`  ✓ ${keeper.name.padEnd(11)} ${fmt(have)} XLM`);
      continue;
    }
    const need = KEEPER_XLM_TARGET - have;
    deficits.push({ keeper, have, need });
    console.log(`  ↑ ${keeper.name.padEnd(11)} ${fmt(have)} XLM — needs ${fmt(need)}`);
  }

  if (!deficits.length) {
    console.log("\nAll keepers above floor. Nothing to do.");
    return;
  }

  const totalNeed = deficits.reduce((sum, d) => sum + d.need, 0);
  console.log(`\n  Total XLM to distribute: ${fmt(totalNeed)}`);

  // ── 2. Buy the shortfall with USDC if the source cannot cover it ────────────
  const sourceXlm = await nativeBalance(server, sourceKp.publicKey());
  if (sourceXlm === null) throw new Error("funding source account does not exist");

  const spendableXlm = Math.max(0, sourceXlm - SOURCE_XLM_RESERVE);
  const shortfall = Math.max(0, totalNeed - spendableXlm);

  console.log(`  Source has ${fmt(sourceXlm)} XLM (${fmt(spendableXlm)} spendable after reserve)`);

  let swapPlan: { buyXlm: number; maxUsdc: number } | null = null;
  if (shortfall > 0) {
    // Price the swap off the live order book, then bound it by slippage. If the
    // book cannot fill it at an acceptable price we stop rather than sell USDC
    // into a thin book at whatever it takes.
    const paths = await server
      .strictReceivePaths([usdc], Asset.native(), fmt(shortfall))
      .call();
    const best = paths.records[0];
    if (!best) throw new Error(`no USDC->XLM path found for ${fmt(shortfall)} XLM`);

    const quoted = Number(best.source_amount);
    const maxUsdc = quoted * (1 + REFILL_SLIPPAGE_BPS / 10_000);

    if (maxUsdc > REFILL_MAX_USDC) {
      throw new Error(
        `swap would cost up to ${fmt(maxUsdc)} USDC, over the ${REFILL_MAX_USDC} cap — ` +
          `raise REFILL_MAX_USDC or lower KEEPER_XLM_TARGET`
      );
    }

    swapPlan = { buyXlm: shortfall, maxUsdc };
    console.log(
      `  Swap: buy ${fmt(shortfall)} XLM for ~${fmt(quoted)} USDC (max ${fmt(maxUsdc)} at ${REFILL_SLIPPAGE_BPS}bps)`
    );
  }

  if (!EXECUTE) {
    console.log("\nDry run — nothing was sent. Re-run with --execute to apply.");
    return;
  }

  // ── 3. Execute: swap first (if needed), then distribute ─────────────────────
  if (swapPlan) {
    const acct = await server.loadAccount(sourceKp.publicKey());
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK.passphrase })
      .addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: usdc,
          sendMax: fmt(swapPlan.maxUsdc),
          destination: sourceKp.publicKey(),
          destAsset: Asset.native(),
          destAmount: fmt(swapPlan.buyXlm),
        })
      )
      .setTimeout(60)
      .build();
    tx.sign(sourceKp);
    const res = await server.submitTransaction(tx);
    console.log(`\n  ✓ swapped USDC -> ${fmt(swapPlan.buyXlm)} XLM  tx=${res.hash.slice(0, 12)}`);
  }

  // One payment per keeper rather than one batched transaction: a single bad
  // destination should not block the others from being funded.
  for (const { keeper, need } of deficits) {
    const acct = await server.loadAccount(sourceKp.publicKey());
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK.passphrase })
      .addOperation(
        Operation.payment({ destination: keeper.address, asset: Asset.native(), amount: fmt(need) })
      )
      .setTimeout(60)
      .build();
    tx.sign(sourceKp);
    try {
      const res = await server.submitTransaction(tx);
      console.log(`  ✓ ${keeper.name.padEnd(11)} +${fmt(need)} XLM  tx=${res.hash.slice(0, 12)}`);
    } catch (e) {
      console.error(`  ✗ ${keeper.name.padEnd(11)} refill failed: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
