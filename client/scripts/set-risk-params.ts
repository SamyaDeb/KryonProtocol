#!/usr/bin/env tsx
/**
 * Set the two risk parameters the audit found unset, and report the coverage
 * they imply.
 *
 * Why this exists
 * ---------------
 * `max_reward_bps` could only be set at `initialize` and had no reader, so its
 * value could not be inspected or corrected on a running deployment without a
 * redeploy. Both gaps are fixed in the contract; this is the tool that uses
 * them.
 *
 * `set_oi_policy` bounds a market's open-interest notional against the
 * insurance fund. Liquidation closes a distressed position with no
 * counterparty, so the fund is the protocol's implicit other side; until a
 * policy is set that exposure is unbounded (audit KRY-Q4). The cap is inert
 * until configured, so a fresh deployment has no bound at all — and because the
 * cap is measured against the fund, capitalise the fund BEFORE setting a
 * policy or the cap computes to zero and refuses every new position.
 *
 * The per-market bps is NOT a flat multiple applied to every market (open
 * findings follow-up 2026-09-07, Q11). The fund is pooled globally
 * (`perp-insurance` doesn't partition by market) and each market's cap is
 * checked independently against that same undivided balance, so a flat
 * multiple lets aggregate exposure scale with the number of markets rather
 * than being bounded by the fund at all. Instead each market's cap is sized
 * off its OWN `maintenanceMarginBps` — the protocol's existing proxy for how
 * far that asset can move before a position is underwater — so a volatile,
 * thin-margin market (e.g. ADA/TRX at 10% maintenance) gets a much smaller
 * share of the fund than a deep, tight-margin one (e.g. BTC at 1%):
 *
 *   stress_gap_i  = 2 * maintenanceMarginBps_i          (bps; doubled for
 *                                                         slippage/gap risk
 *                                                         during liquidation)
 *   risk_budget_i = fund_share (equal split across active markets, i.e. the
 *                   fund is sized to survive one simultaneous stress event
 *                   across the whole book, not N independent ones)
 *   cap_i (bps of fund) = risk_budget_i / stress_gap_i * 10_000
 *
 * The engine now also tracks `total_oi_policy_bps` — the running sum of
 * every market's cap — and can enforce a ceiling on it via
 * `set_max_total_oi_policy_bps` (KRY-Q11 contract-side fix). This script sets
 * that ceiling to exactly the sum of the per-market caps it is about to
 * configure, unless `--max-total-oi-bps` overrides it: the ceiling is a
 * deliberate lock-in of today's allocation, not a separate judgment call, so
 * a later change to any one market's cap still has to be an explicit,
 * reasoned decision rather than silent creep.
 *
 * Neither entrypoint exists on the older deployments still live on testnet and
 * mainnet: those were built without an `upgrade` function and are permanently
 * immutable. This script targets a redeployment from current source.
 *
 * DRY RUN BY DEFAULT. Nothing is submitted without `--execute`.
 *
 * Usage:
 *   npx tsx scripts/set-risk-params.ts
 *   npx tsx scripts/set-risk-params.ts --execute
 *   npx tsx scripts/set-risk-params.ts --execute --reward-bps=50 --fund-coverage=1.0
 */

import {
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { ACTIVE_MARKETS, CONTRACTS, NETWORK } from "../config";
import { assertNoPublicSecretLeak, assertRequiredSecrets } from "../lib/secrets-check";

assertRequiredSecrets(["PROTOCOL_ADMIN_SECRET"]);
assertNoPublicSecretLeak();

const FEE = "20000000";
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");

function numArg(name: string, fallback: number): number {
  const raw = args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
}

/**
 * Liquidator reward, in bps of closed notional. Defaults to 50 (0.5%), which
 * matches the markets' own `liquidationFeeBps` so the reward never exceeds the
 * penalty collected. The contract caps this at 1000.
 */
const REWARD_BPS = Math.round(numArg("reward-bps", 50));

/**
 * What fraction of the insurance fund the whole book is allowed to draw on
 * in one simultaneous stress event, split evenly across the active markets.
 * 1.0 means the fund is sized to survive one full-book stress event; lower it
 * if the fund is thin relative to how many markets are listed. This is a
 * budget, not a per-market multiple — see the header comment for the formula.
 */
const FUND_COVERAGE = numArg("fund-coverage", 1.0);

/**
 * Per-market OI cap, in bps of the insurance fund, derived from that market's
 * own maintenance-margin ratio rather than one flat number for every market.
 */
function oiPolicyBpsFor(maintenanceMarginBps: number, marketCount: number): number {
  const stressGapBps = 2 * maintenanceMarginBps;
  const riskBudgetBps = (FUND_COVERAGE * 10_000) / marketCount;
  return Math.round((riskBudgetBps / stressGapBps) * 10_000);
}

/**
 * Optional explicit override for the aggregate ceiling (`set_max_total_oi_policy_bps`).
 * Defaults to the sum of the per-market caps this run is about to configure —
 * see the header comment.
 */
const MAX_TOTAL_OI_BPS_OVERRIDE = args.find((a) => a.startsWith("--max-total-oi-bps="))?.split("=")[1];

const server = new sorobanRpc.Server(NETWORK.rpcUrl);
const admin = Keypair.fromSecret(process.env.PROTOCOL_ADMIN_SECRET as string);

let simSeq = 100;

async function read(contractId: string, method: string, callArgs: xdr.ScVal[] = []) {
  const tx = new TransactionBuilder(
    new Account(Keypair.random().publicKey(), (simSeq++).toString()),
    { fee: FEE, networkPassphrase: NETWORK.passphrase }
  )
    .addOperation(new Contract(contractId).call(method, ...callArgs))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    return { error: sim.error.split("\n")[0].replace("HostError: ", "").slice(0, 60) };
  }
  const retval = (sim as sorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  try {
    return { value: retval ? scValToNative(retval) : null };
  } catch {
    return { value: null };
  }
}

async function submit(contractId: string, method: string, callArgs: xdr.ScVal[], label: string) {
  const account = await server.getAccount(admin.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(new Contract(contractId).call(method, ...callArgs))
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`${label}: ${sim.error.split("\n")[0]}`);
  }
  if (!EXECUTE) return "(dry run — not submitted)";

  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(admin);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`${label} rejected: ${sent.errorResult?.toXDR("base64")}`);
  }
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    const got = await server.getTransaction(sent.hash);
    if (got.status === "SUCCESS") return sent.hash;
    if (got.status === "FAILED") throw new Error(`${label} failed on-chain: ${sent.hash}`);
  }
  throw new Error(`${label} unconfirmed: ${sent.hash}`);
}

/** i128::MAX, which `insurance_coverage_bps` returns for a market with no OI. */
const UNBOUNDED = (1n << 127n) - 1n;

function describeCoverage(result: { value?: unknown; error?: string }): string {
  // #5 is InvalidConfig, which here means `load_market` found nothing — the
  // policy was still set, the market just is not registered on this deployment
  // yet. Reporting the raw error read as a failure of the write above it.
  if (result.error?.includes("#5")) return "policy set (market not registered yet)";
  if (result.error) return result.error;
  if (result.value === null || result.value === undefined) return "unavailable";
  const bps = BigInt(result.value as string | number | bigint);
  if (bps >= UNBOUNDED) return "idle (no open interest)";
  return `${Number(bps) / 100}% of open interest`;
}

async function main(): Promise<void> {
  console.log(`Risk parameters — ${NETWORK.name}`);
  console.log(`  admin  ${admin.publicKey()}`);
  console.log(`  mode   ${EXECUTE ? "⚠ EXECUTE — transactions WILL be submitted" : "dry run"}\n`);

  console.log("── liquidator reward ──────────────────────────────────");
  const before = await read(CONTRACTS.liquidation, "max_reward_bps");
  if (before.error) {
    throw new Error(
      `cannot read max_reward_bps: ${before.error}\n` +
        `   This deployment predates the entrypoint. The contracts live on testnet\n` +
        `   and mainnet have no upgrade() either, so they cannot be given it —\n` +
        `   redeploy from current source first.`
    );
  }
  console.log(`   before  ${JSON.stringify(before.value)}`);
  const rewardHash = await submit(
    CONTRACTS.liquidation,
    "set_max_reward_bps",
    [nativeToScVal(REWARD_BPS, { type: "u32" })],
    "set_max_reward_bps"
  );
  console.log(`   set to  ${REWARD_BPS} bps (${REWARD_BPS / 100}% of closed notional)  ${rewardHash}`);

  console.log("\n── open-interest policy ───────────────────────────────");
  const markets = Object.values(ACTIVE_MARKETS);
  console.log(
    `   fund coverage: ${FUND_COVERAGE}x one simultaneous stress event, split across ${markets.length} markets`
  );
  console.log(`   cap per market: sized from its own maintenanceMarginBps, not a flat multiple\n`);

  const perMarketBps = markets.map((market) => ({
    market,
    oiBps: oiPolicyBpsFor(market.maintenanceMarginBps, markets.length),
  }));
  const maxTotalBps = MAX_TOTAL_OI_BPS_OVERRIDE
    ? Math.round(Number(MAX_TOTAL_OI_BPS_OVERRIDE))
    : perMarketBps.reduce((sum, { oiBps }) => sum + oiBps, 0);

  // Clear any existing ceiling before updating individual markets. Each
  // set_oi_policy call is checked against the LIVE running total, which
  // during a mid-migration loop still includes markets this run hasn't
  // reached yet — enforcing a ceiling while that stale total is inflated
  // (e.g. tightening every market's cap, as this run typically does) would
  // spuriously reject an update whose final state is perfectly within
  // budget. The real ceiling is set once, after every market reflects its
  // new value.
  await submit(
    CONTRACTS.engine,
    "set_max_total_oi_policy_bps",
    [nativeToScVal(0, { type: "u32" })],
    "clear_max_total_oi_policy_bps"
  );

  for (const { market, oiBps } of perMarketBps) {
    const hash = await submit(
      CONTRACTS.engine,
      "set_oi_policy",
      [
        nativeToScVal(market.marketId, { type: "u32" }),
        nativeToScVal(oiBps, { type: "u32" }),
      ],
      `set_oi_policy(${market.marketId})`
    );
    const coverage = describeCoverage(
      await read(CONTRACTS.engine, "insurance_coverage_bps", [
        nativeToScVal(market.marketId, { type: "u32" }),
      ])
    );
    const multiple = (oiBps / 10_000).toFixed(2);
    console.log(
      `   ${market.symbol.padEnd(10)} cap ${multiple.padStart(7)}x fund   ${coverage.padEnd(28)} ${hash}`
    );
  }

  const ceilingHash = await submit(
    CONTRACTS.engine,
    "set_max_total_oi_policy_bps",
    [nativeToScVal(maxTotalBps, { type: "u32" })],
    "set_max_total_oi_policy_bps"
  );
  console.log(
    `\n   aggregate ceiling  ${(maxTotalBps / 10_000).toFixed(2)}x fund, summed across markets  ${ceilingHash}`
  );

  const totalHash = await read(CONTRACTS.engine, "total_oi_policy_bps");
  console.log(`   total committed    ${JSON.stringify(totalHash.value)} bps of the fund`);

  if (!EXECUTE) {
    console.log("\n  Dry run only. Re-run with --execute to submit.");
  }
}

main().catch((e) => {
  console.error(`\n❌ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
