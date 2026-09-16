#!/usr/bin/env tsx
/**
 * setup-usdc-feed.ts — register the USDC collateral price feed on the oracle
 * adapter, and (optionally) seed a first price.
 *
 * ── Why this matters far more than "one missing feed" ────────────────────────
 * USDC is the settlement/collateral asset. Every settlement values the trader's
 * collateral before it can accept the fill:
 *
 *   gateway.settle_fill_signed
 *     → engine.open_position → sync_and_require_initial_margin
 *       → vault.account_health → oracle.get_price("USDC")
 *
 * `get_price` returns InvalidConfig (CoreError #5) for an asset with no feed
 * config, so with USDC unregistered EVERY settlement simulation fails, the
 * matcher's `if (!settled) rollbackFill` deletes the fill it just wrote, and the
 * venue records no trades at all — on every market, indefinitely. It presents as
 * "trading is broken for no visible reason": the book quotes, the matcher logs
 * fills, and the database stays empty.
 *
 * That was the live state of testnet: markets 1-8 all had feeds and priced fine,
 * USDC had none, and `testnet-deploy.ts` Step 6 only ever registered XLM. The
 * deploy script now registers USDC too, so a fresh deployment cannot repeat it;
 * this script is the remediation for an environment already in that state.
 *
 * ── Keys: two different ones, which the previous version got wrong ───────────
 * `set_feed` is admin-gated (`require_admin`), while `write_price` requires the
 * auth of the address REGISTERED as that feed's publisher and rejects any other
 * signer with Unauthorized. The earlier version signed both with
 * ORACLE_PUBLISHER_SECRET and registered that same key as admin-and-publisher,
 * so against a deployment whose adapter admin is the deployer it fails outright
 * on the first call.
 *
 *   ORACLE_ADMIN_SECRET      — adapter admin; signs set_feed.            REQUIRED
 *   ORACLE_PUBLISHER_SECRET  — the keeper's publisher; signs write_price. optional
 *   ORACLE_PUBLISHER_PUBKEY  — publisher address, when its secret is not
 *                              available here (set_feed only needs the address).
 *
 * Seeding a price is optional because the oracle keeper already publishes USDC
 * on a heartbeat (see oracle-keeper.ts `publishUsdc`); it starts succeeding the
 * moment the feed exists. Seeding just closes the gap until its next tick.
 *
 * ── Staleness guard ──────────────────────────────────────────────────────────
 * USDC_MAX_AGE_SECS defaults to 600s. The keeper publishes USDC at most 90s
 * apart, so 600s is ample headroom, while keeping the depeg fail-stop
 * meaningful: the keeper deliberately STOPS publishing USDC on a depeg beyond
 * USDC_DEPEG_HALT_BPS so that settlement fails closed on staleness rather than
 * valuing depegged collateral at par. A very long max age (the previous 86400s)
 * would leave a full day in which that protection does nothing.
 *
 * Usage:
 *   ORACLE_ADMIN_SECRET=S… npx tsx scripts/setup-usdc-feed.ts --dry-run
 *   ORACLE_ADMIN_SECRET=S… ORACLE_PUBLISHER_SECRET=S… npx tsx scripts/setup-usdc-feed.ts
 */

import {
  Keypair, Account, Contract, TransactionBuilder,
  nativeToScVal, scValToNative, xdr, rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK } from "@/config";

const FEE = "1000000";
const DRY_RUN = process.argv.includes("--dry-run");
const MAX_AGE_SECS = BigInt(process.env.USDC_MAX_AGE_SECS ?? "600");
const MAX_CONFIDENCE_BPS = Number(process.env.USDC_MAX_CONFIDENCE_BPS ?? "500");
const PRICE_1 = BigInt("1000000000000000000"); // $1.00 at 1e18

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function submit(
  server: sorobanRpc.Server,
  kp: Keypair,
  method: string,
  args: xdr.ScVal[],
  label: string
): Promise<void> {
  const account: Account = await server.getAccount(kp.publicKey());
  const contract = new Contract(CONTRACTS.oracleAdapter);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(90)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    // Surface the contract error verbatim — "#11" (Unauthorized) here almost
    // always means the signer is not the adapter admin.
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
  if (send.status === "ERROR") throw new Error(`${label} submit rejected: ${JSON.stringify(send.errorResult)}`);

  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") { process.stdout.write(` ✓  ${send.hash}\n`); return; }
    if (poll.status === "FAILED") throw new Error(`${label} failed on-chain — hash ${send.hash}`);
    if (i % 5 === 0) process.stdout.write(".");
  }
  throw new Error(`${label} confirmation timed out — hash ${send.hash}`);
}

/**
 * The adapter's `Admin` lives in INSTANCE storage, which `stellar contract read`
 * cannot reach (persistent/temporary only) — so fetch the contract instance
 * entry over RPC and decode its storage map.
 */
async function readAdmin(server: sorobanRpc.Server): Promise<string | null> {
  try {
    const res = await server.getLedgerEntries(new Contract(CONTRACTS.oracleAdapter).getFootprint());
    for (const entry of res.entries) {
      const instance = (entry.val.contractData() as any).val().instance();
      for (const slot of instance.storage() ?? []) {
        const key = scValToNative(slot.key());
        if (Array.isArray(key) ? key[0] === "Admin" : key === "Admin") return scValToNative(slot.val());
      }
    }
  } catch { /* fall through — the guard is advisory, not a hard dependency */ }
  return null;
}

async function main() {
  const adminSecret = process.env.ORACLE_ADMIN_SECRET;
  if (!adminSecret) {
    console.error(
      "❌  ORACLE_ADMIN_SECRET is required — set_feed is admin-gated.\n" +
        "    This is the oracle adapter's admin key, NOT the oracle publisher."
    );
    process.exit(1);
  }
  const adminKp = Keypair.fromSecret(adminSecret);

  const publisherSecret = process.env.ORACLE_PUBLISHER_SECRET;
  const publisherKp = publisherSecret ? Keypair.fromSecret(publisherSecret) : null;
  const publisher = publisherKp?.publicKey() ?? process.env.ORACLE_PUBLISHER_PUBKEY;
  if (!publisher) {
    console.error(
      "❌  Need the publisher address: set ORACLE_PUBLISHER_SECRET, or " +
        "ORACLE_PUBLISHER_PUBKEY if its secret is not available here.\n" +
        "    It must be the SAME key the oracle keeper publishes with, or every " +
        "write_price is rejected with Unauthorized."
    );
    process.exit(1);
  }

  const server = new sorobanRpc.Server(NETWORK.rpcUrl);

  // Which adapter this hits comes from `@/config`, i.e. from whichever
  // NEXT_PUBLIC_STELLAR_NETWORK the shell happens to have loaded — run it with
  // .env.production.local sourced and it would aim at MAINNET while you hold a
  // testnet admin key. Read the adapter's own Admin and refuse on a mismatch,
  // so the wrong network or the wrong key fails here instead of as an opaque
  // Unauthorized (#11) mid-submit.
  const onChainAdmin = await readAdmin(server);
  console.log(`Adapter admin  : ${onChainAdmin ?? "<unreadable>"}`);
  if (onChainAdmin && onChainAdmin !== adminKp.publicKey()) {
    console.error(
      `\n❌  ORACLE_ADMIN_SECRET is ${adminKp.publicKey()}, but ${CONTRACTS.oracleAdapter}\n` +
        `    on ${NETWORK.passphrase} is admin'd by ${onChainAdmin}.\n` +
        `    Either the key is wrong, or NEXT_PUBLIC_STELLAR_NETWORK is pointing this\n` +
        `    at the wrong deployment. Nothing was submitted.`
    );
    process.exit(1);
  }

  console.log(`Network        : ${NETWORK.name}`);
  console.log(`Oracle adapter : ${CONTRACTS.oracleAdapter}`);
  console.log(`Admin (signer) : ${adminKp.publicKey()}`);
  console.log(`Publisher      : ${publisher}${publisherKp ? "" : "  (address only — will not seed a price)"}`);
  console.log(`Guard          : max_age=${MAX_AGE_SECS}s max_confidence=${MAX_CONFIDENCE_BPS}bps`);
  console.log(DRY_RUN ? "Mode           : DRY RUN\n" : "");

  const guard = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_age_secs"), val: nativeToScVal(MAX_AGE_SECS, { type: "u64" }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_confidence_bps"), val: nativeToScVal(MAX_CONFIDENCE_BPS, { type: "u32" }) }),
  ]);

  // Single-source under a RedStone label, matching every existing feed on this
  // adapter. The cross-check against Reflector is enforced OFF-chain by the
  // keeper, so there is no quorum feed here.
  await submit(server, adminKp, "set_feed", [
    xdr.ScVal.scvSymbol("USDC"),
    nativeToScVal(publisher, { type: "address" }),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("RedStone")]),
    guard,
    xdr.ScVal.scvBool(true),
  ], "set_feed(USDC)");

  if (publisherKp) {
    // Seed $1.00 so collateral is priceable immediately rather than at the
    // keeper's next heartbeat. The keeper sources USDC for real and takes over
    // from here; this is a bridge, not a hardcoded peg.
    await submit(server, publisherKp, "write_price", [
      xdr.ScVal.scvSymbol("USDC"),
      nativeToScVal(publisher, { type: "address" }),
      nativeToScVal(PRICE_1, { type: "i128" }),
      nativeToScVal(PRICE_1 / 200n, { type: "i128" }), // 0.5% confidence
      nativeToScVal(BigInt(Math.floor(Date.now() / 1000)), { type: "u64" }),
    ], "write_price(USDC, $1.00)");
  } else {
    console.log("  ⓘ  No publisher secret — skipping the seed price.");
    console.log("     The oracle keeper's publishUsdc() will populate it on its next tick.");
  }

  console.log(
    DRY_RUN
      ? "\n✓ Dry run clean — rerun without --dry-run to apply."
      : "\n✓ USDC feed registered. Settlements can now price collateral; the matcher should stop rolling fills back."
  );
}

main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
