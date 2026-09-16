#!/usr/bin/env tsx
/**
 * Funding Keeper — pokes `perp-engine.update_funding(market_id)` on every
 * active market on a fixed cadence.
 *
 * Why this service has to exist
 * -----------------------------
 * A perpetual future has no expiry, so the only thing tethering its price to
 * spot is the funding payment: when the perp trades above the index, longs pay
 * shorts, which makes being long expensive and pulls the mark back down. If
 * funding never accrues, the mark can drift arbitrarily far from the index and
 * nothing pushes it back — the contract stops being a perp and becomes an
 * isolated betting market whose price means nothing.
 *
 * `update_funding` is the on-chain half of that mechanism, and it is
 * permissionless precisely so that anyone can keep it alive. But permissionless
 * is not the same as automatic: until this keeper ran, nothing in the repo ever
 * called it, so `long_index`/`short_index` sat at zero for the life of the
 * protocol and no position ever paid or received funding (audit KRY-Q2).
 *
 * What a tick does
 * ----------------
 * For each active market, simulate then submit `update_funding(market_id)`. The
 * contract computes the rate from the mark-vs-index premium, clamps it to the
 * market's `max_rate_per_hour`, and charges at most
 * `MAX_FUNDING_ELAPSED_SECS` (1h) of accrual per call. That cap is why cadence
 * matters: ticking more often than hourly is free and harmless, but a gap
 * longer than an hour silently under-charges funding for the excess.
 *
 * The contract fails closed on a stale or low-confidence oracle. That is
 * correct — accruing funding against a price the market itself would refuse to
 * trade on is worse than accruing none — so a `StaleOracle` error here is a
 * signal about the oracle keeper, not about this one.
 *
 * Usage:
 *   FUNDING_KEEPER_SECRET=S... npx tsx scripts/funding-keeper.ts
 */

import {
  Keypair,
  Contract,
  TransactionBuilder,
  Account,
  nativeToScVal,
  scValToNative,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { ACTIVE_MARKETS, CONTRACTS, NETWORK } from "../config";
import { assertNoPublicSecretLeak, assertRequiredSecrets } from "../lib/secrets-check";

assertRequiredSecrets(["FUNDING_KEEPER_SECRET"]);
assertNoPublicSecretLeak();

const FEE = "1000000";
// Well inside the contract's 1h accrual cap, so a missed tick or two still
// leaves the next one charging the full elapsed window rather than truncating.
const TICK_INTERVAL_MS = Number(process.env.FUNDING_INTERVAL_MS ?? String(15 * 60 * 1000));
// Spacing between markets: each update is its own transaction on one account,
// so consecutive submissions must not race the sequence number.
const STAGGER_MS = Number(process.env.FUNDING_STAGGER_MS ?? "800");

const MARKETS = Object.values(ACTIVE_MARKETS).map((m) => ({
  id: m.marketId,
  symbol: m.oracleSymbol,
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A read-only account for simulate-only calls; sequence is irrelevant since
// these never submit.
const READ_KP = Keypair.random();

/** Read `funding_state(market_id).last_update`, or null if unreadable. */
async function readLastUpdate(server: sorobanRpc.Server, marketId: number): Promise<number | null> {
  const tx = new TransactionBuilder(new Account(READ_KP.publicKey(), "0"), {
    fee: "100",
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(
      new Contract(CONTRACTS.engine).call("funding_state", nativeToScVal(marketId, { type: "u32" }))
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) return null;
  const retval = (sim as sorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) return null;
  try {
    const state = scValToNative(retval) as Record<string, unknown>;
    return Number(state["last_update"] ?? 0);
  } catch {
    return null;
  }
}

/**
 * Submit one `update_funding` and confirm it actually changed on-chain state.
 * Returns the tx hash on confirmed success, or null when the market declined
 * the update for an expected reason (stale oracle, unconfigured funding, or
 * a confirmation that never materialised) — those are logged, not thrown, so
 * one bad market cannot stop the other seven from funding.
 *
 * Two things share one keeper account, so both matter here:
 *
 * 1. Waiting for confirmation (rather than just staggering submissions)
 *    before moving to the next market: `getAccount` returns the on-chain
 *    sequence, so submitting the next market's tx before this one has landed
 *    hands it a stale sequence number that collides with (and can silently
 *    evict, per Stellar's tx-queue replacement rule) whichever tx is still
 *    in flight.
 * 2. `getTransaction` reporting SUCCESS is not sufficient proof by itself —
 *    observed in production against the public testnet RPC: it reported
 *    SUCCESS for hashes that Horizon has never seen and that never changed
 *    `funding_state.last_update`. So the real confirmation is the contract
 *    state itself: read `last_update` before submitting, and after a
 *    reported SUCCESS, re-read it and require it to have actually advanced.
 */
async function updateFunding(
  server: sorobanRpc.Server,
  kp: Keypair,
  marketId: number
): Promise<string | null> {
  const before = await readLastUpdate(server, marketId);

  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: FEE,
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(
      new Contract(CONTRACTS.engine).call(
        "update_funding",
        nativeToScVal(marketId, { type: "u32" })
      )
    )
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    const err = (sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error ?? "";
    console.warn(`[funding] market ${marketId}: simulation declined — ${err}`);
    return null;
  }

  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") {
    throw new Error(
      `market ${marketId}: ${send.errorResult?.toXDR("base64") ?? "submit error"}`
    );
  }

  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "FAILED") {
      throw new Error(`market ${marketId}: tx ${send.hash} failed on-chain`);
    }
    if (poll.status === "SUCCESS") {
      const after = await readLastUpdate(server, marketId);
      if (after !== null && after !== before) return send.hash;
      console.warn(
        `[funding] market ${marketId}: tx ${send.hash} reported SUCCESS but last_update didn't move (${before} -> ${after}) — treating as unconfirmed`
      );
      return null;
    }
  }
  console.warn(`[funding] market ${marketId}: confirmation timeout on ${send.hash} — ambiguous, retrying next tick`);
  return null;
}

async function tick(server: sorobanRpc.Server, kp: Keypair): Promise<void> {
  for (const market of MARKETS) {
    try {
      const hash = await updateFunding(server, kp, market.id);
      if (hash) {
        console.log(`[funding] ${market.symbol} (market ${market.id}) updated — ${hash}`);
      }
    } catch (e) {
      console.error(`[funding] ${market.symbol}:`, e instanceof Error ? e.message : e);
    }
    await sleep(STAGGER_MS);
  }
}

async function main(): Promise<void> {
  const kp = Keypair.fromSecret(process.env.FUNDING_KEEPER_SECRET as string);
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);

  console.log(
    `[funding] keeper up on ${NETWORK.name} as ${kp.publicKey()} — ` +
      `${MARKETS.length} market(s), every ${TICK_INTERVAL_MS / 1000}s`
  );

  for (;;) {
    const started = Date.now();
    await tick(server, kp).catch((e) => console.error("[funding] tick failed:", e));
    await sleep(Math.max(0, TICK_INTERVAL_MS - (Date.now() - started)));
  }
}

main().catch((e) => {
  console.error("[funding] fatal:", e);
  process.exit(1);
});
