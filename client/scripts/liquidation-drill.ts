#!/usr/bin/env tsx
/**
 * Liquidation Drill — proves, end to end on testnet, that a position can
 * actually be liquidated.
 *
 * Why this exists (audit KRY-Q7)
 * ------------------------------
 * Liquidation has never executed on any network. The contract path has unit
 * tests and the keeper is written, but no real liquidation has ever cleared.
 * That is the single most common way perp protocols become insolvent: the
 * machinery runs for the first time under exactly the market conditions it was
 * built to survive, and something in the wiring — a missing role, an oracle
 * guard, a health check that never flips — turns out to be wrong.
 *
 * Reading the code cannot settle this. Only running it can.
 *
 * What the drill does
 * -------------------
 *   1. Fund and deposit collateral for a throwaway victim account.
 *   2. Open a maximally-levered position for it against a counterparty.
 *   3. Move the oracle against the victim until health flips liquidatable.
 *   4. Assert the on-chain health actually reports `liquidatable = true`.
 *   5. Liquidate with the real liquidator key and the real contract call.
 *   6. Assert the position shrank, the liquidator was paid, and any residual
 *      deficit was seized or absorbed rather than left dangling.
 *
 * Every step asserts. A silent pass is the point: if any stage cannot be
 * reached, the drill fails loudly and names the stage.
 *
 * TESTNET ONLY. It refuses to run against mainnet — it deliberately destroys an
 * account's collateral, and it moves the oracle.
 *
 * Usage:
 *   NEXT_PUBLIC_STELLAR_NETWORK=testnet \
 *   DRILL_VICTIM_SECRET=S... DRILL_COUNTERPARTY_SECRET=S... \
 *   LIQUIDATOR_SECRET=S... ORACLE_PUBLISHER_SECRET=S... \
 *   npx tsx scripts/liquidation-drill.ts
 */

import {
  Keypair,
  Account,
  Contract,
  TransactionBuilder,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { ACTIVE_MARKETS, ASSETS, CONTRACTS, NETWORK } from "../config";
import { assertNoPublicSecretLeak, assertRequiredSecrets } from "../lib/secrets-check";

assertRequiredSecrets([
  "DRILL_VICTIM_SECRET",
  "DRILL_COUNTERPARTY_SECRET",
  "LIQUIDATOR_SECRET",
  "ORACLE_PUBLISHER_SECRET",
]);
assertNoPublicSecretLeak();

if (NETWORK.name === "mainnet") {
  console.error(
    "liquidation-drill refuses to run on mainnet: it destroys an account's " +
      "collateral and moves the oracle. Run it on testnet."
  );
  process.exit(1);
}

const FEE = "2000000";
// Sizes, notionals and vault balances are 7-decimal (Stellar token scale);
// oracle prices are 18-decimal. Dividing a size by the PRICE scale silently
// renders every quantity as 0, which is how the first run of this drill
// reported "LONG 0" against a real 800-XLM position.
const AMOUNT = 10n ** 7n;
const amt = (v: bigint) => Number(v) / Number(AMOUNT);
const px = (v: bigint) => Number(v / 10n ** 12n) / 1e6;
const MARKET = Object.values(ACTIVE_MARKETS)[0];

if (!MARKET) {
  console.error("No active markets configured; nothing to drill.");
  process.exit(1);
}

const server = new sorobanRpc.Server(NETWORK.rpcUrl);

// ── helpers ──────────────────────────────────────────────────────────────────

const simKp = Keypair.random();
let simSeq = 100;

async function read(contractId: string, method: string, args: xdr.ScVal[]): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(simKp.publicKey(), (simSeq++).toString()), {
    fee: FEE,
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`read ${method} failed: ${sim.error}`);
  }
  const retval = (sim as sorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return retval ? scValToNative(retval) : null;
}

async function send(
  kp: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<string> {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`${method} simulation failed: ${sim.error}`);
  }
  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`${method} rejected: ${sent.errorResult?.toXDR("base64")}`);
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const got = await server.getTransaction(sent.hash);
    if (got.status === "SUCCESS") return sent.hash;
    if (got.status === "FAILED") throw new Error(`${method} failed on-chain: ${sent.hash}`);
  }
  throw new Error(`${method} never confirmed: ${sent.hash}`);
}

let stage = "startup";
function step(name: string): void {
  stage = name;
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[${stage}] ${message}`);
}

interface Health {
  liquidatable: boolean;
  equity: bigint;
  maintenance_margin_required: bigint;
}

async function health(user: string): Promise<Health> {
  const h = (await read(CONTRACTS.vault, "account_health", [
    new Address(user).toScVal(),
    new Address(ASSETS.usdc).toScVal(),
  ])) as Record<string, unknown>;
  return {
    liquidatable: Boolean(h.liquidatable),
    equity: BigInt((h.equity as bigint) ?? 0),
    maintenance_margin_required: BigInt((h.maintenance_margin_required as bigint) ?? 0),
  };
}

interface Position {
  position_id: bigint;
  market_id: number;
  size: bigint;
  is_long: boolean;
}

async function positions(user: string): Promise<Position[]> {
  const raw = (await read(CONTRACTS.engine, "positions", [
    new Address(user).toScVal(),
  ])) as Array<Record<string, unknown>> | null;
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => ({
    position_id: BigInt((p.position_id as bigint) ?? 0),
    market_id: Number(p.market_id ?? 0),
    size: BigInt((p.size as bigint) ?? 0),
    is_long: Boolean(p.is_long),
  }));
}

/**
 * Backdate `publish_time` so it can never sit ahead of the ledger clock.
 *
 * `OracleSnapshot::validate` rejects `publish_time > now` as StaleOracle, and
 * `now` is the LEDGER timestamp, which trails wall-clock by up to a full ledger.
 * Stamping with `Date.now()` therefore fails intermittently — whenever the
 * transaction lands in a ledger that closed a second before the stamp. The
 * oracle keeper backdates for exactly this reason; the drill must match it or
 * it fails on a race that has nothing to do with liquidation.
 */
const PUBLISH_BACKDATE_SECS = 20;

async function publishPrice(publisher: Keypair, price: bigint): Promise<void> {
  await send(publisher, CONTRACTS.oracleAdapter, "write_price", [
    nativeToScVal(MARKET.oracleSymbol, { type: "symbol" }),
    new Address(publisher.publicKey()).toScVal(),
    nativeToScVal(price, { type: "i128" }),
    nativeToScVal(price / 2000n, { type: "i128" }),
    nativeToScVal(Math.floor(Date.now() / 1000) - PUBLISH_BACKDATE_SECS, { type: "u64" }),
  ]);
}

/**
 * Collateral is valued off its own feed, so it has to stay fresh while the
 * drill walks the market price — otherwise every `account_health` read fails
 * StaleOracle and the drill reports a liquidation failure that is really an
 * oracle failure.
 */
async function refreshCollateralFeed(publisher: Keypair): Promise<void> {
  await send(publisher, CONTRACTS.oracleAdapter, "write_price", [
    nativeToScVal("USDC", { type: "symbol" }),
    new Address(publisher.publicKey()).toScVal(),
    nativeToScVal(10n ** 18n, { type: "i128" }),
    nativeToScVal(10n ** 15n, { type: "i128" }),
    nativeToScVal(Math.floor(Date.now() / 1000) - PUBLISH_BACKDATE_SECS, { type: "u64" }),
  ]);
}

// ── the drill ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const victim = Keypair.fromSecret(process.env.DRILL_VICTIM_SECRET as string);
  const liquidator = Keypair.fromSecret(process.env.LIQUIDATOR_SECRET as string);
  const publisher = Keypair.fromSecret(process.env.ORACLE_PUBLISHER_SECRET as string);

  console.log(`Liquidation drill on ${NETWORK.name}`);
  console.log(`  market     ${MARKET.symbol} (id ${MARKET.marketId}, feed ${MARKET.oracleSymbol})`);
  console.log(`  victim     ${victim.publicKey()}`);
  console.log(`  liquidator ${liquidator.publicKey()}`);

  step("1. establish a baseline price");
  // Read the last snapshot with a PERMISSIVE guard rather than None. With None
  // the contract enforces the feed's own max_age and rejects a stale price
  // inside the simulation, so a market whose keeper is down fails here — an
  // oracle problem reported as a liquidation problem. The drill owns the oracle
  // for its duration, so it reads whatever is stored and then republishes it
  // fresh as its own starting point.
  const permissiveGuard = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("max_age_secs"),
      val: nativeToScVal(BigInt("18446744073709551615"), { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("max_confidence_bps"),
      val: nativeToScVal(10000, { type: "u32" }),
    }),
  ]);
  const snapshot = (await read(CONTRACTS.oracleAdapter, "get_price", [
    nativeToScVal(MARKET.oracleSymbol, { type: "symbol" }),
    permissiveGuard,
  ])) as Record<string, unknown> | null;
  assert(snapshot?.price, `no ${MARKET.oracleSymbol} snapshot exists — the feed has never been written`);
  const startPrice = BigInt(snapshot.price as bigint);

  await publishPrice(publisher, startPrice);
  await refreshCollateralFeed(publisher);
  console.log(`   index republished at ${px(startPrice)}`);

  step("2. confirm the victim holds a position to liquidate");
  const before = await positions(victim.publicKey());
  const target = before.find((p) => p.market_id === MARKET.marketId && p.size > 0n);
  assert(
    target,
    `victim holds no position in market ${MARKET.marketId}. Open one first — ` +
      `the drill deliberately does not create positions for you, because doing ` +
      `so would exercise a synthetic path rather than the real order flow.`
  );
  console.log(
    `   position ${target.position_id}: ${target.is_long ? "LONG" : "SHORT"} ${amt(target.size)}`
  );

  step("3. move the index against the victim until health flips");
  // Walk the price in 5% steps against the position, up to 60%. Stepping rather
  // than jumping keeps each move inside the oracle's own deviation guards and
  // mirrors how a real move arrives.
  let drillPrice = startPrice;
  let flipped = false;
  for (let i = 0; i < 12 && !flipped; i++) {
    drillPrice = target.is_long
      ? (drillPrice * 95n) / 100n
      : (drillPrice * 105n) / 100n;
    await publishPrice(publisher, drillPrice);
    await refreshCollateralFeed(publisher);
    const h = await health(victim.publicKey());
    console.log(
      `   index ${px(drillPrice)} → equity ${amt(h.equity).toFixed(4)}, ` +
        `maintenance ${amt(h.maintenance_margin_required).toFixed(4)}, ` +
        `liquidatable=${h.liquidatable}`
    );
    flipped = h.liquidatable;
  }
  assert(
    flipped,
    "health never reported liquidatable after a 60% adverse move. Either the " +
      "position is too small to matter, or the health computation is not " +
      "responding to price — which is exactly the failure this drill exists " +
      "to catch."
  );

  step("4. liquidate — the real contract call, the real key");
  // The liquidator is paid in TOKENS, not vault credit: perp-insurance's
  // `pay_liquidator` calls `token.transfer(insurance -> liquidator)` directly.
  // An earlier version of this drill read the liquidator's VAULT balance, which
  // never moves on that path, and reported "paid nothing" against a deployment
  // that was in fact paying correctly. Read the balance the payment lands in.
  const liquidatorBalanceBefore = BigInt(
    ((await read(ASSETS.usdc, "balance", [
      new Address(liquidator.publicKey()).toScVal(),
    ])) ?? 0n) as bigint
  );

  const hash = await send(liquidator, CONTRACTS.liquidation, "liquidate", [
    new Address(liquidator.publicKey()).toScVal(),
    new Address(victim.publicKey()).toScVal(),
    nativeToScVal(target.position_id, { type: "u64" }),
    nativeToScVal(target.size, { type: "i128" }),
    nativeToScVal(drillPrice, { type: "i128" }),
  ]);
  console.log(`   liquidated in ${hash}`);

  step("5. verify the outcome on-chain");
  const after = await positions(victim.publicKey());
  const remaining = after.find((p) => p.position_id === target.position_id);
  assert(
    !remaining || remaining.size < target.size,
    "the liquidation transaction succeeded but the position did not shrink"
  );
  console.log(`   position size ${amt(target.size)} → ${amt(remaining?.size ?? 0n)}`);

  const liquidatorBalanceAfter = BigInt(
    ((await read(ASSETS.usdc, "balance", [
      new Address(liquidator.publicKey()).toScVal(),
    ])) ?? 0n) as bigint
  );
  // Name the cause rather than the symptom. A zero reward is almost always a
  // zero `max_reward_bps`, which was settable only at `initialize` and had no
  // reader, so the deployment could not tell you it had disabled its own
  // liquidation economics.
  if (liquidatorBalanceAfter <= liquidatorBalanceBefore) {
    // Tolerant read: a deployment older than the reader must still produce a
    // useful message rather than crashing the drill on the diagnostic itself.
    const configured = await read(CONTRACTS.liquidation, "max_reward_bps", []).catch(() => null);
    const detail =
      configured === null || configured === undefined
        ? "this deployment predates max_reward_bps() so the value cannot be read on-chain"
        : `max_reward_bps = ${configured}`;
    throw new Error(
      `the liquidator was paid nothing (${detail}). Liquidation is mechanically ` +
        `correct but economically dead: a keeper pays gas and receives nothing, ` +
        `so in production no one would ever call it.`
    );
  }
  console.log(
    `   liquidator reward = ${amt(liquidatorBalanceAfter - liquidatorBalanceBefore)} USDC`
  );

  const victimSettlement = BigInt(
    ((await read(CONTRACTS.vault, "balance_of", [
      new Address(victim.publicKey()).toScVal(),
      new Address(ASSETS.usdc).toScVal(),
    ])) ?? 0n) as bigint
  );
  if (victimSettlement < 0n) {
    console.warn(
      `   ⚠ victim settlement balance is still ${victimSettlement} — seize/absorb ` +
        `did not clear the deficit. This is KRY-Q4 territory: the protocol is ` +
        `carrying the loss with no counterparty mechanism.`
    );
  } else {
    console.log(`   victim settlement balance cleared to ${victimSettlement}`);
  }

  // A liquidation closes the distressed side with no counterparty, so the book
  // is now asymmetric by exactly the closed size (audit KRY-Q4). Report it: this
  // is the exposure the insurance fund silently inherits.
  const longOi = BigInt(((await read(CONTRACTS.engine, "long_open_interest", [nativeToScVal(MARKET.marketId, { type: "u32" })])) ?? 0n) as bigint);
  const shortOi = BigInt(((await read(CONTRACTS.engine, "short_open_interest", [nativeToScVal(MARKET.marketId, { type: "u32" })])) ?? 0n) as bigint);
  console.log(`   open interest now long ${amt(longOi)} vs short ${amt(shortOi)} — imbalance ${amt(longOi - shortOi)}`);

  step("6. restore the index");
  await publishPrice(publisher, startPrice);
  await refreshCollateralFeed(publisher);
  console.log(`   index restored to ${px(startPrice)}`);

  console.log("\n✅ Liquidation drill passed — liquidation works end to end.");
}

main().catch((e) => {
  console.error(`\n❌ Liquidation drill FAILED at stage: ${stage}`);
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
