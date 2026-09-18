#!/usr/bin/env tsx
/**
 * Funding keeper drill: the real keeper against the real Engine on a local
 * arc-anvil, across several hours of chain time.
 *
 * A trade at +0.5% over the index sets the mark, so every funding period has a
 * known premium and the rate clamps at the market's max (0.05%/h). Each update
 * is then checked exactly against the contract's formula:
 *
 *     delta = rate * min(elapsed, 3600) / 3600,  longIndex += delta, shortIndex -= delta
 *
 * Scenarios: the first update starts the clock (ETH; BTC's first trade starts its own); a due update; not-due; equal
 * timestamps (skipped, not sent); a missed hour (charged one hour, shortfall
 * logged); several consecutive hours; a stale oracle (reported, not sent, then
 * recovered). Longs pay and shorts receive while mark > index.
 *
 * LOCAL ONLY. Environment: KRYON_E2E_DATABASE_URL (required), KRYON_E2E_RPC_PORT.
 */

import { engineAbi } from "@/lib/chain/contracts";
import { TxSender } from "@/lib/chain/tx-sender";
import { MemoryTxJobStore } from "@/lib/chain/tx-store";
import { FundingKeeper, viemFundingChain, type FundingTickResult } from "@/lib/keepers/funding";
import { KeeperActions, Metrics, createLogger } from "@/lib/keepers/runtime";
import { NETWORK, ROLES, account, depositUsdc, reporter, startLocalChain, type LocalChain } from "@/lib/keepers/testkit/localchain";
import { E18, startTrading } from "@/lib/keepers/testkit/trading";
import { neon } from "@/lib/sql";

const r = reporter();
const BTC = 2;
const ETH = 3;
const INDEX = 100_000n * E18;
const MARK = 100_500n * E18;
const MAX_RATE = 500_000_000_000_000n; // arc-local funding_max_rate_per_hour

async function state(lc: LocalChain, marketId = BTC) {
  return (await lc.client.readContract({
    address: lc.contracts.engine,
    abi: engineAbi,
    functionName: "fundingState",
    args: [marketId],
  })) as { longIndex: bigint; shortIndex: bigint; ratePerHour: bigint; lastUpdate: bigint };
}

async function equity(lc: LocalChain, who: `0x${string}`) {
  const h = (await lc.client.readContract({
    address: lc.contracts.engine,
    abi: engineAbi,
    functionName: "accountHealth",
    args: [who],
  })) as { equity: bigint };
  return h.equity;
}

async function main() {
  const dbUrl = process.env.KRYON_E2E_DATABASE_URL;
  if (!dbUrl) throw new Error("KRYON_E2E_DATABASE_URL is required (a migrated, disposable Postgres)");
  const sql = neon(dbUrl);

  r.step("boot arc-anvil, deploy, open a position at +0.5%");
  const lc = await startLocalChain({ log: r.note });
  const trading = await startTrading(lc, dbUrl, [BTC]);
  try {
    const alice = account(8);
    const bob = account(9);
    await depositUsdc(lc, alice, 5_000_000_000n);
    await depositUsdc(lc, bob, 5_000_000_000n);
    await trading.pushIndex({ BTC: INDEX, ETH: 3_000n * E18 });
    await trading.trade({ marketId: BTC, long: alice, short: bob, size: 10n ** 16n, price: MARK });
    r.check("Alice long, Bob short 0.01 BTC at $100,500 (index $100,000)", true);

    const logs: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
    const log = createLogger("funding-keeper", "debug", {}, (line) => {
      const { level, msg, ...fields } = JSON.parse(line);
      logs.push({ level, msg, fields });
      if (process.env.KRYON_E2E_VERBOSE) process.stdout.write(`    · ${level} ${msg} ${JSON.stringify(fields)}\n`);
    });
    const who = ROLES.fundingKeeper;
    const keeper = new FundingKeeper({
      chain: viemFundingChain({ client: lc.client, engine: lc.contracts.engine, riskParams: lc.contracts.riskParams, self: who.address }),
      sender: new TxSender({ network: NETWORK, service: "funding", chain: lc.client, signer: who, store: new MemoryTxJobStore(), pollMs: 100 }),
      engine: lc.contracts.engine,
      log,
      metrics: new Metrics(),
      actions: new KeeperActions(sql, NETWORK.id),
      dueAfterSecs: 3_300,
      maxPerTick: 10,
    });
    const nonce = () => lc.client.getTransactionCount({ address: who.address });
    /** BTC funding intents by status. ETH updates in the same ticks, so nonces alone cannot tell. */
    const btcActions = async () => {
      const rows = (await sql.query(
        `SELECT "status"::text AS s, count(*)::int AS n FROM "KeeperAction"
         WHERE "kind" = 'funding.update' AND "marketId" = $1 GROUP BY 1`,
        [BTC]
      )) as { s: string; n: number }[];
      return Object.fromEntries(rows.map((x) => [x.s, x.n])) as Record<string, number>;
    };

    /** Advance, keep the index fresh, tick, and check the index move against the formula. */
    async function period(label: string, warpSecs: number, opts: { pushIndex?: boolean } = {}): Promise<FundingTickResult> {
      await lc.warp(warpSecs);
      if (opts.pushIndex !== false) await trading.pushIndex({ BTC: INDEX, ETH: 3_000n * E18 });
      const before = await state(lc);
      const res = await keeper.tick();
      const after = await state(lc);
      if (res.results.get(BTC)?.outcome === "confirmed") {
        const elapsed = after.lastUpdate - before.lastUpdate;
        const charged = elapsed > 3600n ? 3600n : elapsed;
        const expected = (MAX_RATE * charged) / 3600n;
        const moved = after.longIndex - before.longIndex;
        r.check(`${label}: longIndex += rate * ${charged}s / 3600s`, moved === expected, `moved ${moved}, expected ${expected} over ${elapsed}s`);
        r.check(`${label}: shortIndex moves by exactly the opposite`, after.shortIndex - before.shortIndex === -expected);
        r.check(`${label}: rate clamped at the market max`, after.ratePerHour === MAX_RATE, String(after.ratePerHour));
      }
      return res;
    }

    // ── first update ──
    // The first settled trade starts a market's funding clock, so BTC is
    // already running. ETH has no trades: its first update is the keeper's.
    r.step("1. the first update starts the clock");
    const eth0 = await state(lc, ETH);
    r.check("ETH has never been updated (lastUpdate 0)", eth0.lastUpdate === 0n);
    r.check("BTC's clock was started by its first trade", (await state(lc)).lastUpdate > 0n);
    const first = await keeper.tick();
    r.check("keeper sends ETH's first update", first.results.get(ETH)?.outcome === "confirmed");
    const eth1 = await state(lc, ETH);
    r.check("ETH clock started, indexes still zero", eth1.lastUpdate > 0n && eth1.longIndex === 0n);
    r.check("BTC not due yet, so not sent", !first.results.has(BTC));

    // ── equal timestamps ──
    r.step("2. equal timestamps: skipped, not sent");
    const n0 = await nonce();
    const eq = await keeper.tick();
    r.check("plan says same-timestamp", eq.plans.find((p) => p.marketId === BTC)?.action === "skip" &&
      (eq.plans.find((p) => p.marketId === BTC) as { reason: string }).reason === "same-timestamp");
    r.check("no transaction sent", (await nonce()) === n0);

    // ── due ──
    r.step("3. a due update (55 minutes)");
    await period("55m", 3_300);

    // ── not due ──
    r.step("4. ten minutes later: not due");
    const n1 = await nonce();
    const nd = await period("10m", 600);
    r.check("idle, nothing sent", nd.status === "idle" && (await nonce()) === n1);

    // ── missed hour ──
    r.step("5. a missed hour: 2.5h gap is charged one hour, not caught up");
    const eqA0 = await equity(lc, alice.address);
    const eqB0 = await equity(lc, bob.address);
    const a2 = await btcActions();
    const missed = await period("2.5h gap", 9_000);
    r.check("exactly one BTC update sent", (await btcActions()).CONFIRMED === (a2.CONFIRMED ?? 0) + 1);
    r.check("shortfall logged", logs.some((l) => l.msg.startsWith("funding shortfall") && Number(l.fields.lostSecs) > 5_000));
    const again = await keeper.tick();
    r.check("no catch-up on the next tick", !again.results.has(BTC));
    r.check("the gap update itself confirmed", missed.results.get(BTC)?.outcome === "confirmed");

    // ── several hours ──
    r.step("6. four consecutive periods");
    for (let i = 1; i <= 4; i++) await period(`period ${i}`, 3_300);
    const eqA1 = await equity(lc, alice.address);
    const eqB1 = await equity(lc, bob.address);
    r.check("mark > index: the long paid", eqA1 < eqA0, `${eqA0} -> ${eqA1}`);
    r.check("mark > index: the short received", eqB1 > eqB0, `${eqB0} -> ${eqB1}`);

    // ── stale oracle ──
    r.step("7. stale oracle: reported, nothing sent, recovered");
    const a3 = await btcActions();
    const stale = await period("stale", 3_300, { pushIndex: false });
    r.check("pre-flight classified as oracle", (stale.results.get(BTC)?.detail as { cls?: string })?.cls === "oracle");
    const a4 = await btcActions();
    r.check("no BTC transaction: the intent failed in pre-flight", a4.CONFIRMED === a3.CONFIRMED && (a4.FAILED ?? 0) === (a3.FAILED ?? 0) + 1);
    r.check("ETH, with no mark, needs no index and still updated", stale.results.get(ETH)?.outcome === "confirmed");
    await trading.pushIndex({ BTC: INDEX, ETH: 3_000n * E18 });
    const rec = await keeper.tick();
    r.check("index fresh again: the update goes through", rec.results.get(BTC)?.outcome === "confirmed");

    const rows = (await sql.query(
      `SELECT "status"::text AS s, count(*)::int AS n FROM "KeeperAction" WHERE "kind" = 'funding.update' GROUP BY 1 ORDER BY 1`
    )) as { s: string; n: number }[];
    r.note(`KeeperAction funding.update: ${rows.map((x) => `${x.s}=${x.n}`).join(", ")}`);
    r.check("every intent reached a terminal state", rows.every((x) => x.s === "CONFIRMED" || x.s === "FAILED"));
  } finally {
    await trading.end();
    lc.stop();
    await sql.end();
  }
  process.stdout.write(`\n${r.failures === 0 ? "✓ funding drill passed" : `✗ funding drill: ${r.failures} check(s) failed`}\n`);
  process.exit(r.failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
