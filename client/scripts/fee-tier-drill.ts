#!/usr/bin/env tsx
/**
 * Fee-tier drill: the real fee-tier bot against the real FeeRouter on a local
 * arc-anvil, with 30-day volume computed by the real stats aggregator from
 * trades the real matcher settled and the real indexer projected.
 *
 *   1. Two traders trade $20k each; the aggregator computes their 30-day volume.
 *   2. Dry run (the default): the bot proposes tier 2 for both, sends nothing.
 *   3. Enabled, but the schedule's tiers are not defined: idle (tier-undefined).
 *      Governance (the timelock) defines them. Enabled without FEE_TIER_ROLE:
 *      idle (lacks-role). The timelock grants it.
 *   4. The bot tiers both accounts up; FeeRouter.quote now charges tier 2; the
 *      indexer projects the FeeTierSet events; a restarted bot changes nothing.
 *   5. 31 days later the trades have left the window: the aggregator (run with
 *      a clock 31 days ahead) drops their volume to zero and the bot tiers them
 *      back down to the market schedule.
 *   6. Every intent is terminal; Vault.solvency() holds.
 *
 * LOCAL ONLY. Environment: KRYON_E2E_DATABASE_URL (required), KRYON_E2E_RPC_PORT,
 * KRYON_E2E_VERBOSE.
 */

import { encodeFunctionData, type Address } from "viem";

import { feeRouterAbi, vaultAbi } from "@/lib/chain/contracts";
import { TxSender } from "@/lib/chain/tx-sender";
import { MemoryTxJobStore } from "@/lib/chain/tx-store";
import { FEE_TIER_ROLE, FeeTierBot, parseSchedule, pgFeeTierData, viemFeeTierChain, type FeeTierTickResult } from "@/lib/keepers/fee-tier";
import { KeeperActions, Metrics, createLogger, systemClock, type Clock } from "@/lib/keepers/runtime";
import { NETWORK, account, depositUsdc, reporter, startLocalChain, type LocalChain } from "@/lib/keepers/testkit/localchain";
import { E18, startTrading } from "@/lib/keepers/testkit/trading";
import { neon } from "@/lib/sql";
import { StatsAggregator } from "@/lib/stats/aggregator";

const r = reporter();
const BTC = 2;
const DAY_MS = 86_400_000;

async function read<T>(lc: LocalChain, address: Address, abi: unknown, functionName: string, args: readonly unknown[] = []) {
  return (await lc.client.readContract({ address, abi, functionName, args } as never)) as T;
}

function quietLog(name: string) {
  return createLogger(name, "debug", {}, (line) => {
    if (process.env.KRYON_E2E_VERBOSE) process.stdout.write(`    · ${line.slice(0, 300)}\n`);
  });
}

async function main() {
  const dbUrl = process.env.KRYON_E2E_DATABASE_URL;
  if (!dbUrl) throw new Error("KRYON_E2E_DATABASE_URL is required (a migrated, disposable Postgres)");
  const sql = neon(dbUrl);

  r.step("boot arc-anvil, deploy, open the book");
  const lc = await startLocalChain({ log: r.note });
  const trading = await startTrading(lc, dbUrl, [BTC]);
  const { feeRouter, vault } = lc.contracts;
  try {
    const alice = account(20);
    const bob = account(21);
    const botKey = account(29);
    for (const a of [alice, bob, botKey]) await lc.setBalance(a.address, 20_000n * E18);
    // arc-local caps a deposit at $10,000 per account.
    await depositUsdc(lc, alice, 5_000_000_000n);
    await depositUsdc(lc, bob, 5_000_000_000n);

    const aggregate = async (clock: Clock) => {
      const agg = new StatsAggregator({ db: trading.db, network: NETWORK.id, log: quietLog("stats"), metrics: new Metrics(), clock });
      await agg.tick();
    };
    const volume = async (who: Address) => {
      const rows = (await sql.query(
        `SELECT "volume30d"::text AS v FROM "AccountAnalytics" WHERE "network" = $1 AND "address" = $2`,
        [NETWORK.id, who.toLowerCase()]
      )) as { v: string }[];
      return rows[0] ? BigInt(rows[0].v) : 0n;
    };
    const tierOf = (who: Address) => read<number>(lc, feeRouter, feeRouterAbi, "accountTier", [who]);

    // ── 1. volume ──
    r.step("1. two traders trade $20,000 each; the aggregator computes 30-day volume");
    await trading.pushIndex({ BTC: 100_000n * E18, ETH: 3_000n * E18 });
    await trading.trade({ marketId: BTC, long: alice, short: bob, size: 10n * 10n ** 16n, price: 100_000n * E18 });
    await trading.pushIndex({ BTC: 100_000n * E18, ETH: 3_000n * E18 });
    await trading.trade({ marketId: BTC, long: alice, short: bob, size: 10n * 10n ** 16n, price: 100_000n * E18 });
    await aggregate(systemClock);
    const va = await volume(alice.address);
    const vb = await volume(bob.address);
    r.check(`alice 30-day volume $${Number(va) / 1e6}`, va === 20_000_000_000n, String(va));
    r.check(`bob 30-day volume $${Number(vb) / 1e6}`, vb === 20_000_000_000n, String(vb));

    // Tier 1 from $8k, tier 2 from $16k.
    const schedule = parseSchedule("1:8000,2:16000");
    const metrics = new Metrics();
    const actions = new KeeperActions(sql, NETWORK.id);
    const sender = new TxSender({ network: NETWORK, service: "fee-tier-bot", chain: lc.client, signer: botKey, store: new MemoryTxJobStore(), pollMs: 100 });
    const makeBot = (enabled: boolean, s = schedule) =>
      new FeeTierBot({
        chain: viemFeeTierChain({ client: lc.client, feeRouter }),
        data: pgFeeTierData(sql, NETWORK.id),
        sender,
        feeRouter,
        schedule: s,
        enabled,
        log: quietLog("fee-tier"),
        metrics,
        actions,
      });
    const nonce = () => lc.client.getTransactionCount({ address: botKey.address });
    const changesOf = (t: FeeTierTickResult) =>
      t.status === "ran" ? t.changes.map((c) => `${c.account.slice(0, 6)}:${c.from}->${c.to}`).sort().join(",") : `idle:${t.reason}`;

    const timelock = await lc.timelock();
    const asTimelock = (data: `0x${string}`) => lc.asAddress(timelock, { to: feeRouter, data });

    // ── 2/3. dry run, then governance ──
    r.step("2. tiers not yet defined: idle, even in a dry run");
    const undefinedTick = await makeBot(false).tick();
    r.check("idle (tier-undefined)", undefinedTick.status === "idle" && undefinedTick.reason === "tier-undefined", changesOf(undefinedTick));

    r.step("3. governance defines the tiers; dry run proposes, sends nothing");
    await asTimelock(encodeFunctionData({ abi: feeRouterAbi, functionName: "defineTier", args: [1, 100, 450] }));
    await asTimelock(encodeFunctionData({ abi: feeRouterAbi, functionName: "defineTier", args: [2, 100, 400] }));
    const n0 = await nonce();
    const dry = await makeBot(false).tick();
    r.check("dry run proposes tier 2 for both", dry.status === "ran" && dry.dryRun && dry.changes.length === 2 && dry.changes.every((c) => c.to === 2), changesOf(dry));
    r.check("…and sends nothing", (await nonce()) === n0 && (await tierOf(alice.address)) === 0);

    const noRole = await makeBot(true).tick();
    r.check("enabled without FEE_TIER_ROLE: idle (lacks-role)", noRole.status === "idle" && noRole.reason === "lacks-role", changesOf(noRole));
    await asTimelock(encodeFunctionData({ abi: feeRouterAbi, functionName: "grantRole", args: [FEE_TIER_ROLE, botKey.address] }));

    // ── 4. tier up ──
    r.step("4. enabled: both accounts tier up");
    const up = await makeBot(true).tick();
    r.check(
      "two setAccountTier calls confirmed",
      up.status === "ran" && up.applied.length === 2 && up.applied.every((a) => a.outcome === "confirmed"),
      JSON.stringify(up.status === "ran" ? up.applied.map((a) => a.outcome) : up)
    );
    r.check("alice and bob are tier 2 on chain", (await tierOf(alice.address)) === 2 && (await tierOf(bob.address)) === 2);
    const [, , makerTier, takerTier] = await read<[bigint, bigint, number, number]>(lc, feeRouter, feeRouterAbi, "quote", [BTC, alice.address, bob.address, 10_000n * E18]);
    r.check("FeeRouter.quote now charges both at tier 2", makerTier === 2 && takerTier === 2, `${makerTier}/${takerTier}`);
    await trading.index();
    const projected = (await sql.query(`SELECT count(*)::int AS n FROM "Account" WHERE "network" = $1 AND "feeTier" = 2`, [NETWORK.id])) as { n: number }[];
    r.check("the indexer projected both FeeTierSet events (Account.feeTier)", projected[0].n === 2, String(projected[0].n));
    const n1 = await nonce();
    const restart = await makeBot(true).tick();
    r.check("a restarted bot finds nothing to change and sends nothing", restart.status === "ran" && restart.changes.length === 0 && (await nonce()) === n1, changesOf(restart));

    // ── 5. tier down ──
    r.step("5. 31 days on, the trades have left the window: both tier back down");
    const later: Clock = { now: () => Date.now() + 31 * DAY_MS, sleep: systemClock.sleep };
    await aggregate(later);
    r.check("aggregator: 30-day volume back to zero", (await volume(alice.address)) === 0n && (await volume(bob.address)) === 0n);
    const down = await makeBot(true).tick();
    r.check("both set back to tier 0 (market schedule)", down.status === "ran" && down.applied.length === 2 && down.applied.every((a) => a.change.to === 0 && a.outcome === "confirmed"), changesOf(down));
    r.check("on chain: tier 0", (await tierOf(alice.address)) === 0 && (await tierOf(bob.address)) === 0);
    await trading.index();

    // ── 6. end state ──
    r.step("6. end state");
    const open = (await sql.query(
      `SELECT count(*)::int AS n FROM "KeeperAction" WHERE "kind" = 'fee_tier.set' AND "status"::text IN ('PLANNED','SUBMITTED')`
    )) as { n: number }[];
    r.check("every fee-tier intent is terminal", open[0].n === 0, String(open[0].n));
    const confirmed = (await sql.query(`SELECT count(*)::int AS n FROM "KeeperAction" WHERE "kind" = 'fee_tier.set' AND "status" = 'CONFIRMED'`)) as { n: number }[];
    r.check("4 intents confirmed (2 up, 2 down)", confirmed[0].n === 4, String(confirmed[0].n));
    const [assets, liabilities] = await read<[bigint, bigint]>(lc, vault, vaultAbi, "solvency");
    r.check("Vault.solvency() holds", assets >= liabilities);
    r.note(`metrics: ${JSON.stringify(metrics.snapshot())}`);
  } finally {
    await trading.end();
    lc.stop();
    await sql.end();
  }
  process.stdout.write(`\n${r.failures === 0 ? "✓ fee-tier drill passed" : `✗ fee-tier drill: ${r.failures} check(s) failed`}\n`);
  process.exit(r.failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
