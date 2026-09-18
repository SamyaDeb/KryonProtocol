#!/usr/bin/env tsx
/**
 * Local end-to-end gate: every keeper together, on one arc-anvil, one
 * deployment and one Postgres.
 *
 *   deposit → trade → funding → liquidation → ADL → fee claim → withdraw
 *
 * Services, all real code with their own keys and a Postgres-backed TxSender:
 * two oracle publishers (quorum of two; scripted venues), the matcher, the
 * indexer, the funding keeper, the liquidation/ADL keeper, the reconciler and
 * keeper-refill. Each round runs every service's tick once, in a fixed order,
 * so the gate is deterministic enough for CI while exercising the real
 * interactions: the matcher needs fresh prices from the publishers, the
 * liquidator reads positions the indexer projected, the reconciler finalises
 * every service's jobs and rolls up their gas.
 *
 * LOCAL ONLY. Environment: KRYON_E2E_DATABASE_URL (required), KRYON_E2E_RPC_PORT,
 * KRYON_E2E_VERBOSE.
 *
 * Usage: KRYON_E2E_DATABASE_URL=postgresql://localhost:5432/kryon_keepers_test npm run test:e2e:keepers
 */

import { encodeFunctionData, type Address } from "viem";
import type { HDAccount } from "viem/accounts";

import { engineAbi, feeRouterAbi, insuranceAbi, oracleAdapterAbi, vaultAbi } from "@/lib/chain/contracts";
import { oracleId } from "@/lib/chain/networks";
import { TxSender } from "@/lib/chain/tx-sender";
import { PgTxJobStore } from "@/lib/chain/tx-store-pg";
import { FundingKeeper, viemFundingChain } from "@/lib/keepers/funding";
import { LiquidationKeeper, viemLiquidationChain } from "@/lib/keepers/liquidation";
import { USDC18, refillOnce } from "@/lib/keepers/refill";
import { GasSpendRollup, KeeperActions, Metrics, createLogger, type Logger } from "@/lib/keepers/runtime";
import { FEES, NETWORK, ROLES, account, depositUsdc, reporter, startLocalChain, type LocalChain } from "@/lib/keepers/testkit/localchain";
import { E18, startTrading } from "@/lib/keepers/testkit/trading";
import { viemOracleChain } from "@/lib/oracle/chain";
import { OraclePublisher } from "@/lib/oracle/publisher";
import type { PriceSource } from "@/lib/oracle/sources";
import { reconcileOnce } from "@/lib/reconciler";
import { neon } from "@/lib/sql";

const r = reporter();
const BTC = 2;
const usd = (v: bigint) => `$${(Number(v / 10n ** 14n) / 1e4).toFixed(2)}`;

// Every feed arc-local lists as active, so the publishers cover them all as in production.
const market: Record<string, number> = {
  BTC: 100_000,
  ETH: 3_000,
  SOL: 150,
  XRP: 0.6,
  BNB: 600,
  TRX: 0.12,
  XLM: 0.1,
  ADA: 0.4,
  USDC: 1,
};
let clockMs = 0;
const venue = (name: string): PriceSource => ({
  name,
  supports: () => true,
  fetch: async (symbols) => ({
    quotes: symbols
      .filter((s) => s in market)
      .map((s) => ({ source: name, symbol: s, price: BigInt(Math.round(market[s] * 1e6)) * 10n ** 12n, ts: clockMs })),
    errors: [],
  }),
});

function logger(service: string): Logger {
  return createLogger(service, process.env.KRYON_E2E_VERBOSE ? "debug" : "error", {}, (line) => {
    if (process.env.KRYON_E2E_VERBOSE || line.includes('"level":"error"')) process.stdout.write(`    · ${line.slice(0, 400)}\n`);
  });
}

async function read<T>(lc: LocalChain, address: Address, abi: unknown, functionName: string, args: readonly unknown[] = []) {
  return (await lc.client.readContract({ address, abi, functionName, args } as never)) as T;
}

async function main() {
  const dbUrl = process.env.KRYON_E2E_DATABASE_URL;
  if (!dbUrl) throw new Error("KRYON_E2E_DATABASE_URL is required (a migrated, disposable Postgres)");
  const sql = neon(dbUrl);
  const store = new PgTxJobStore(sql);
  const actions = new KeeperActions(sql, NETWORK.id);

  r.step("boot: arc-anvil, deploy, two publishers, service keys");
  const lc = await startLocalChain({ log: r.note });
  const trading = await startTrading(lc, dbUrl, [BTC], store);
  const { engine, liquidation, insurance, vault, feeRouter, oracleAdapter } = lc.contracts;
  try {
    const pub2 = account(11);
    const liquidatorKey = account(25);
    const funderKey = account(26);
    const whale = account(20);
    const victims = [account(21), account(22), account(23)];
    const alice = account(27);
    const bob = account(28);
    for (const a of [pub2, liquidatorKey, whale, ...victims, alice, bob]) await lc.setBalance(a.address, 20_000n * E18);
    await lc.setBalance(funderKey.address, 1_000n * E18);

    // Quorum of two, as on mainnet.
    const timelock = await lc.timelock();
    const admin = (functionName: string, args: readonly unknown[]) =>
      lc.asAddress(timelock, { to: oracleAdapter, data: encodeFunctionData({ abi: oracleAdapterAbi, functionName, args } as never) });
    await admin("setPublishers", [[ROLES.publisher.address, pub2.address]]);
    for (const sym of ["BTC", "ETH"]) {
      const cfg = await read<Record<string, unknown>>(lc, oracleAdapter, oracleAdapterAbi, "feed", [oracleId(sym)]);
      await admin("setFeed", [oracleId(sym), { ...cfg, minPublishers: 2 }]);
    }

    const sender = (who: HDAccount, service: string) =>
      new TxSender({ network: NETWORK, service, chain: lc.client, signer: who, store, pollMs: 100 });

    const publishers = [ROLES.publisher, pub2].map(
      (who, i) =>
        new OraclePublisher({
          chain: viemOracleChain({ client: lc.client, oracle: oracleAdapter, self: who.address }),
          sender: sender(who, `oracle-publisher-${i + 1}`),
          oracle: oracleAdapter,
          sources: [venue("v1"), venue("v2")],
          log: logger(`oracle-${i + 1}`),
          metrics: new Metrics(),
          actions,
          aggregate: { minSources: 2, maxSourceDeviationBps: 50n },
          policy: { deviationBps: 5n, heartbeatSecs: 1, inclusionMarginSecs: 3, maxRefDivergenceBps: 0 },
          maxQuoteAgeMs: 5_000,
          usdcDepegHaltBps: 100n,
          depegFailClosed: true,
          backdateSecs: 1,
          alertAfterSecs: 30,
          now: () => clockMs,
        })
    );
    const funding = new FundingKeeper({
      chain: viemFundingChain({ client: lc.client, engine, riskParams: lc.contracts.riskParams, self: ROLES.fundingKeeper.address }),
      sender: sender(ROLES.fundingKeeper, "funding-keeper"),
      engine,
      log: logger("funding"),
      metrics: new Metrics(),
      actions,
      dueAfterSecs: 3_300,
      maxPerTick: 10,
    });
    const liquidator = new LiquidationKeeper({
      chain: viemLiquidationChain({ client: lc.client, engine, liquidation, insurance, vault }),
      sender: sender(liquidatorKey, "liquidator"),
      sql,
      network: NETWORK.id,
      contracts: { engine, liquidation, insurance },
      log: logger("liquidator"),
      metrics: new Metrics(),
      actions,
      maxAccountsPerTick: 25,
      maxStepsPerAccount: 10,
      indexerGraceMs: 0,
      adlMinShortfall: E18,
    });
    const refillSender = sender(funderKey, "keeper-refill");
    const refillTargets = [
      { name: "oracle-1", address: ROLES.publisher.address },
      { name: "oracle-2", address: pub2.address },
      { name: "funding", address: ROLES.fundingKeeper.address },
      { name: "liquidator", address: liquidatorKey.address },
    ];
    const reconcilerLog = logger("reconciler");
    const reconcilerMetrics = new Metrics();

    /** One round of every service. */
    async function round(label?: string) {
      await lc.warp(2);
      clockMs = (await lc.now()) * 1000;
      for (const p of publishers) await p.tick();
      await trading.index();
      await funding.tick();
      await liquidator.tick();
      await trading.index();
      await reconcileOnce({
        chain: lc.client,
        sql,
        network: NETWORK.id,
        log: reconcilerLog,
        metrics: reconcilerMetrics,
        gas: new GasSpendRollup(sql, NETWORK.id),
        actions,
        fillMinAgeMs: 0,
      });
      await refillOnce({
        client: lc.client,
        sender: refillSender,
        sql,
        network: NETWORK.id,
        targets: refillTargets,
        policy: { floor: 5n * USDC18, target: 25n * USDC18, maxPerRun: 100n * USDC18, maxPerTargetPerDay: 50n * USDC18, funderAlert: 10n * USDC18 },
        execute: true,
        log: logger("refill"),
        metrics: new Metrics(),
        actions,
      });
      if (label && process.env.KRYON_E2E_VERBOSE) r.note(`round: ${label}`);
    }

    await round("boot");
    const snap = await read<{ price: bigint; sourceCount: number }>(lc, oracleAdapter, oracleAdapterAbi, "getPrice", [oracleId("BTC"), 0, 0]);
    r.check("two publishers hold a quorum price", snap.sourceCount === 2 && snap.price === 100_000n * E18, `${snap.sourceCount} ${snap.price}`);

    // ── deposit ──
    r.step("deposit");
    await depositUsdc(lc, whale, 9_000_000_000n);
    for (const v of victims) await depositUsdc(lc, v, 200_000_000n);
    await depositUsdc(lc, alice, 2_000_000_000n);
    await depositUsdc(lc, bob, 2_000_000_000n);
    await round();
    const aliceLedger0 = await read<bigint>(lc, vault, vaultAbi, "balanceOf", [alice.address]);
    r.check("vault credits deposits (Alice $2,000)", aliceLedger0 === 2_000n * E18, usd(aliceLedger0));

    // ── trade ──
    r.step("trade: three 40x longs vs a short, and Alice/Bob at +0.5%");
    const SIZE = 8n * 10n ** 16n;
    for (const v of victims) {
      await round();
      await trading.trade({ marketId: BTC, long: v, short: whale, size: SIZE, price: 100_000n * E18 });
    }
    await round();
    await trading.trade({ marketId: BTC, long: alice, short: bob, size: 10n ** 16n, price: 100_500n * E18 });
    await round();
    const settled = (await sql.query(`SELECT count(*)::int AS n FROM "Fill" WHERE "status" = 'SETTLED'`)) as { n: number }[];
    r.check("four fills settled and indexed", settled[0].n === 4, String(settled[0].n));

    // ── funding ──
    r.step("funding: 55 minutes later");
    const f0 = await read<{ longIndex: bigint; lastUpdate: bigint }>(lc, engine, engineAbi, "fundingState", [BTC]);
    await lc.warp(3_300);
    await round("funding");
    const f1 = await read<{ longIndex: bigint; lastUpdate: bigint }>(lc, engine, engineAbi, "fundingState", [BTC]);
    r.check("funding keeper advanced BTC's indexes (mark above index: longs pay)", f1.lastUpdate > f0.lastUpdate && f1.longIndex > f0.longIndex);
    const fu = (await sql.query(`SELECT count(*)::int AS n FROM "FundingUpdate" WHERE "marketId" = $1`, [BTC])) as { n: number }[];
    r.check("indexer recorded the FundingUpdate", fu[0].n >= 1);

    // ── liquidation ──
    r.step("liquidation: the venues drop 3%");
    market.BTC = 97_000;
    await round("drop");
    for (const v of victims) r.check(`${v.address.slice(0, 8)} closed out`, (await trading.position(v.address, BTC)).size === 0n);
    const liqRows = (await sql.query(`SELECT count(*)::int AS n FROM "LiquidationEvent"`)) as { n: number }[];
    r.check("liquidations indexed", liqRows[0].n >= 3, String(liqRows[0].n));
    const badDebt = await read<bigint>(lc, insurance, insuranceAbi, "badDebt");
    r.check(`bad debt recorded (${usd(badDebt)})`, badDebt > 0n);

    // ── ADL ──
    r.step("ADL: a further drop puts the backstop under; ADL clears the shortfall");
    market.BTC = 95_000;
    for (let i = 0; i < 8; i++) {
      await round("adl");
      if ((await read<bigint>(lc, insurance, insuranceAbi, "unfundedShortfall")) < E18) break;
    }
    const sf = await read<bigint>(lc, insurance, insuranceAbi, "unfundedShortfall");
    r.check(`unfunded shortfall below $1 (${sf} wei)`, sf < E18);
    const adlRows = (await sql.query(`SELECT count(*)::int AS n FROM "DeleverageEvent"`)) as { n: number }[];
    r.check("ADL indexed", adlRows[0].n >= 1, String(adlRows[0].n));

    // ── fee claim ──
    r.step("fee claim: treasury");
    const [treasury] = await read<[Address, Address]>(lc, feeRouter, feeRouterAbi, "recipients");
    const accrued = await read<bigint>(lc, feeRouter, feeRouterAbi, "treasuryAccrued");
    const usdcBal = (who: Address) =>
      lc.client.readContract({
        address: NETWORK.usdc,
        abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const,
        functionName: "balanceOf",
        args: [who],
      });
    const t0 = await usdcBal(treasury);
    const ch = await lc.wallet(bob).writeContract({ address: feeRouter, abi: feeRouterAbi, functionName: "claimTreasury", chain: lc.chain, account: bob, ...FEES });
    await lc.client.waitForTransactionReceipt({ hash: ch });
    const t1 = await usdcBal(treasury);
    r.check(`treasury accrued ${usd(accrued)} and received it`, accrued > 0n && t1 > t0, `${t0} -> ${t1}`);
    await round();
    const fc = (await sql.query(`SELECT count(*)::int AS n FROM "FeeClaim"`)) as { n: number }[];
    r.check("indexer recorded the FeeClaim", fc[0].n >= 1);

    // ── withdraw ──
    r.step("withdraw: Alice takes $500 out");
    const w0 = await usdcBal(alice.address);
    const wh = await lc.wallet(alice).writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [500_000_000n], chain: lc.chain, account: alice, ...FEES });
    const wr = await lc.client.waitForTransactionReceipt({ hash: wh });
    const w1 = await usdcBal(alice.address);
    r.check("withdrawal succeeded against fresh prices", wr.status === "success" && w1 > w0);
    await round();

    // ── keeper-refill ──
    r.step("keeper-refill: the liquidator's gas runs low");
    await lc.setBalance(liquidatorKey.address, 2n * USDC18);
    await round("refill");
    const lb = await lc.client.getBalance({ address: liquidatorKey.address });
    r.check(`liquidator topped back up (${usd(lb)})`, lb >= 24n * USDC18);

    // ── invariants ──
    r.step("invariants");
    await round("final"); // the reconciler rolls up gas from the previous round's sends
    const [assets, liabilities] = await read<[bigint, bigint]>(lc, vault, vaultAbi, "solvency");
    r.check(`Vault.solvency(): assets ${usd(assets)} >= liabilities ${usd(liabilities)}`, assets >= liabilities);
    const openJobs = (await sql.query(`SELECT count(*)::int AS n FROM "TxJob" WHERE "status"::text IN ('PENDING','SUBMITTED')`)) as { n: number }[];
    r.check("reconciler: every TxJob terminal", openJobs[0].n === 0, String(openJobs[0].n));
    const openActions = (await sql.query(`SELECT count(*)::int AS n FROM "KeeperAction" WHERE "status"::text IN ('PLANNED','SUBMITTED')`)) as { n: number }[];
    r.check("every KeeperAction terminal", openActions[0].n === 0, String(openActions[0].n));
    const unacc = (await sql.query(`SELECT count(*)::int AS n FROM "Fill" WHERE "status" = 'PENDING'`)) as { n: number }[];
    r.check("no unaccounted fills", unacc[0].n === 0);
    const gas = (await sql.query(
      `SELECT "service", sum("txCount")::int AS n FROM "GasSpend" GROUP BY 1 ORDER BY 1`
    )) as { service: string; n: number }[];
    const services = new Set(gas.map((g) => g.service));
    for (const s of ["oracle-publisher-1", "oracle-publisher-2", "matcher", "funding-keeper", "liquidator", "keeper-refill"]) {
      r.check(`GasSpend rolled up for ${s}`, services.has(s));
    }
    r.note(`gas: ${gas.map((g) => `${g.service}=${g.n}`).join(", ")}`);
  } finally {
    await trading.end();
    lc.stop();
    await sql.end();
  }
  process.stdout.write(`\n${r.failures === 0 ? "✓ keepers end-to-end gate passed" : `✗ keepers end-to-end gate: ${r.failures} check(s) failed`}\n`);
  process.exit(r.failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
