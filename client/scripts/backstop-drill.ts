#!/usr/bin/env tsx
/**
 * Backstop unwind drill: the real unwinder against the real Insurance (ERC-1271),
 * OrderGateway and matcher on a local arc-anvil, with the real intake validation
 * and the real indexer.
 *
 *   1. Two 40x longs are liquidated into the backstop.
 *   2. Before governance acts, the unwinder idles: limits unset, then no role.
 *   3. Governance (the timelock) sets unwind limits and grants BACKSTOP_SIGNER_ROLE.
 *   4. The unwinder posts reduce-only Insurance-owned orders through the intake;
 *      a counterparty's bids fill them; the backstop's exposure falls; every fill
 *      is inside the band and the per-fill cap; the unwinder stops at the daily cap.
 *   5. The contract holds even when the service misbehaves: a validly signed but
 *      oversize order fills nothing (BackstopLimitExceeded); an order signed by a
 *      key without the role, or living past 1h, is refused at intake (ERC-1271).
 *   6. Paused protocol: the unwinder idles.
 *   7. Vault.solvency() holds; every unwind intent is terminal.
 *
 * LOCAL ONLY. Environment: KRYON_E2E_DATABASE_URL (required), KRYON_E2E_RPC_PORT,
 * KRYON_E2E_VERBOSE.
 */

import { decodeErrorResult, encodeFunctionData, parseEventLogs, type Address, type Hex } from "viem";

import { ALL_ERRORS_ABI, insuranceAbi, orderGatewayAbi, vaultAbi } from "@/lib/chain/contracts";
import { TxSender } from "@/lib/chain/tx-sender";
import { MemoryTxJobStore } from "@/lib/chain/tx-store";
import {
  BACKSTOP_SIGNER_ROLE,
  BackstopUnwinder,
  pgBackstopBook,
  signUnwindOrder,
  viemBackstopChain,
  type BackstopTickResult,
} from "@/lib/keepers/backstop";
import { LiquidationKeeper, viemLiquidationChain } from "@/lib/keepers/liquidation";
import { KeeperActions, Metrics, createLogger } from "@/lib/keepers/runtime";
import { FEES, NETWORK, ROLES, account, depositUsdc, reporter, startLocalChain, type LocalChain } from "@/lib/keepers/testkit/localchain";
import { E18, startTrading } from "@/lib/keepers/testkit/trading";
import { NO_REFERRER, type Order } from "@/lib/market/eip712";
import { neon } from "@/lib/sql";
import { rpcErc1271Checker } from "@/lib/validation";

const r = reporter();
const BTC = 2;
const usd = (v: bigint) => `$${(Number(v / 10n ** 14n) / 1e4).toFixed(2)}`;
const abs = (x: bigint) => (x < 0n ? -x : x);

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
  const { engine, liquidation, insurance, vault, orderGateway } = lc.contracts;
  try {
    const whale = account(20);
    const longs = [account(21), account(22)];
    const liquidator = account(25);
    const buyer = account(26);
    const backstopKey = account(27);
    const rogueKey = account(28);
    for (const a of [whale, ...longs, liquidator, buyer]) await lc.setBalance(a.address, 20_000n * E18);
    await depositUsdc(lc, whale, 9_000_000_000n);
    for (const l of longs) await depositUsdc(lc, l, 200_000_000n);
    await depositUsdc(lc, buyer, 2_000_000_000n);

    // ── 1. liquidate into the backstop ──
    r.step("1. two 40x longs are liquidated into the backstop");
    await trading.pushIndex({ BTC: 100_000n * E18, ETH: 3_000n * E18 });
    const SIZE = 8n * 10n ** 16n;
    for (const l of longs) await trading.trade({ marketId: BTC, long: l, short: whale, size: SIZE, price: 100_000n * E18 });
    await trading.pushIndex({ BTC: 97_000n * E18, ETH: 3_000n * E18 });
    const liqKeeper = new LiquidationKeeper({
      chain: viemLiquidationChain({ client: lc.client, engine, liquidation, insurance, vault }),
      sender: new TxSender({ network: NETWORK, service: "liquidator", chain: lc.client, signer: liquidator, store: new MemoryTxJobStore(), pollMs: 100 }),
      sql,
      network: NETWORK.id,
      contracts: { engine, liquidation, insurance },
      log: quietLog("liquidator"),
      metrics: new Metrics(),
      actions: new KeeperActions(sql, NETWORK.id),
      maxAccountsPerTick: 25,
      maxStepsPerAccount: 10,
      indexerGraceMs: 0,
      // No ADL in this drill: the unwinder, not ADL, is what is being tested.
      adlMinShortfall: 10n ** 40n,
    });
    await liqKeeper.tick();
    await trading.index();
    const held0 = (await trading.position(insurance, BTC)).size;
    r.check(`the backstop holds a long of ${Number(held0) / 1e18} BTC`, held0 > 0n, String(held0));

    // ── 2. idle before governance acts ──
    let chainNow = BigInt(await lc.now());
    const metrics = new Metrics();
    const actions = new KeeperActions(sql, NETWORK.id);
    const unwinder = new BackstopUnwinder({
      chain: viemBackstopChain({ client: lc.client, engine, orderGateway, insurance }),
      book: pgBackstopBook({
        q: sql,
        network: NETWORK.id,
        chainId: NETWORK.chainId,
        gateway: orderGateway,
        erc1271: rpcErc1271Checker(lc.rpc),
        nowSec: () => chainNow,
      }),
      signer: backstopKey,
      chainId: NETWORK.chainId,
      gateway: orderGateway,
      insurance,
      log: quietLog("backstop"),
      metrics,
      actions,
      nowSec: () => chainNow,
    });
    const tick = async (): Promise<BackstopTickResult> => {
      chainNow = BigInt(await lc.now());
      return unwinder.tick();
    };

    r.step("2. before governance acts, the unwinder idles and says why");
    const t0 = await tick();
    r.check("limits unset: idle (limits-unset)", t0.status === "idle" && t0.reason === "limits-unset", JSON.stringify(t0));

    // ── 3. governance ──
    r.step("3. the timelock sets unwind limits and grants BACKSTOP_SIGNER_ROLE");
    const timelock = await lc.timelock();
    const DEV = 100; // 1%
    const MAX_FILL = 3_000n * E18;
    const MAX_DAILY = 10_000n * E18;
    await lc.asAddress(timelock, {
      to: insurance,
      data: encodeFunctionData({ abi: insuranceAbi, functionName: "setUnwindLimits", args: [DEV, MAX_FILL, MAX_DAILY] }),
    });
    const t1 = await tick();
    r.check("limits set, key not yet granted: idle (signer-lacks-role)", t1.status === "idle" && t1.reason === "signer-lacks-role", JSON.stringify(t1));
    await lc.asAddress(timelock, {
      to: insurance,
      data: encodeFunctionData({ abi: insuranceAbi, functionName: "grantRole", args: [BACKSTOP_SIGNER_ROLE, backstopKey.address] }),
    });
    r.check("role granted", await read<boolean>(lc, insurance, insuranceAbi, "hasRole", [BACKSTOP_SIGNER_ROLE, backstopKey.address]));

    // ── 4. unwind ──
    r.step("4. the unwinder posts, a counterparty fills, the backstop's exposure falls");
    const fromBlock = await lc.client.getBlockNumber();
    let posted = 0;
    let stoppedOnBudget = false;
    for (let round = 0; round < 8; round++) {
      await trading.pushIndex({ BTC: 97_000n * E18, ETH: 3_000n * E18 });
      // The buyer's bid rests first; the unwind order then crosses it as taker.
      await trading.place({ who: buyer, marketId: BTC, isLong: true, size: 5n * 10n ** 16n, price: 97_000n * E18 });
      const t = await tick();
      if (t.status !== "ran") {
        r.check(`round ${round}: unexpected idle ${JSON.stringify(t)}`, false);
        break;
      }
      if (t.rejected.length > 0) r.check(`round ${round}: intake accepted the unwind order`, false, JSON.stringify(t.rejected));
      posted += t.posted.length;
      if (t.posted.length === 0) {
        stoppedOnBudget = t.plan.skipped.some((s) => s.reason === "no-budget");
        break;
      }
      await trading.match(BTC);
    }
    const held1 = (await trading.position(insurance, BTC)).size;
    r.check(`${posted} unwind order(s) posted through the intake`, posted >= 2, String(posted));
    r.check(`backstop exposure fell: ${Number(held0) / 1e18} → ${Number(held1) / 1e18} BTC`, held1 < held0 && held1 >= 0n);
    r.check("the unwinder stopped at the daily cap, not at a flat book", stoppedOnBudget && held1 > 0n);

    const logs = await lc.client.getLogs({ address: insurance, fromBlock });
    const unwound = parseEventLogs({ abi: insuranceAbi, logs, eventName: "BackstopUnwound" }) as unknown as {
      args: { size: bigint; price: bigint; notional: bigint; dayTotal: bigint };
    }[];
    r.check(`${unwound.length} BackstopUnwound fill(s)`, unwound.length >= 2);
    const [, , , usedToday] = await read<[number, bigint, bigint, bigint]>(lc, insurance, insuranceAbi, "unwindLimits");
    r.check(`every fill ≤ per-fill cap ${usd(MAX_FILL)}`, unwound.every((e) => e.args.notional <= MAX_FILL));
    r.check(
      "every fill priced within 1% of the $97,000 index",
      unwound.every((e) => abs(e.args.price - 97_000n * E18) <= (97_000n * E18 * BigInt(DEV)) / 10_000n)
    );
    r.check(`day total ${usd(usedToday)} ≤ daily cap ${usd(MAX_DAILY)}`, usedToday <= MAX_DAILY && usedToday > 0n);
    const sumFills = unwound.reduce((a, e) => a + e.args.size, 0n);
    r.check("exposure fell by exactly what filled", held0 - held1 === sumFills, `${held0 - held1} vs ${sumFills}`);

    // ── 5. the contract holds even if the service misbehaves ──
    r.step("5. Insurance enforces the limits on its own");
    // Lift the daily cap so only the per-fill cap can refuse the next fill.
    await lc.asAddress(timelock, {
      to: insurance,
      data: encodeFunctionData({ abi: insuranceAbi, functionName: "setUnwindLimits", args: [DEV, MAX_FILL, 10_000_000n * E18] }),
    });
    await trading.pushIndex({ BTC: 97_000n * E18, ETH: 3_000n * E18 });
    chainNow = BigInt(await lc.now());
    const book = pgBackstopBook({ q: sql, network: NETWORK.id, chainId: NETWORK.chainId, gateway: orderGateway, erc1271: rpcErc1271Checker(lc.rpc), nowSec: () => chainNow });
    const craft = (o: Partial<Order>): Order => ({
      owner: insurance,
      marketId: BTC,
      isLong: false,
      size: 5n * 10n ** 16n, // $4,850 at $97k: over the $3,000 per-fill cap
      limitPrice: 97_000n * E18,
      reduceOnly: true,
      nonce: BigInt(Date.now()) * 1_000n + 999n,
      expiry: chainNow + 600n,
      referrer: NO_REFERRER,
      ...o,
    });
    const body = async (o: Order, signer = backstopKey) => ({
      owner: o.owner, marketId: o.marketId, isLong: o.isLong, size: o.size.toString(), limitPrice: o.limitPrice.toString(),
      reduceOnly: o.reduceOnly, nonce: o.nonce.toString(), expiry: o.expiry.toString(), referrer: o.referrer,
      signature: await signUnwindOrder(signer, NETWORK.chainId, orderGateway, o), chainId: NETWORK.chainId,
    });

    const rogue = await book.submit(await body(craft({ nonce: 1n }), rogueKey));
    r.check("order signed by a key without the role: refused at intake (ERC-1271)", !rogue.ok && rogue.code === "bad_signature", JSON.stringify(rogue));
    const long = await book.submit(await body(craft({ nonce: 2n, expiry: chainNow + 3_700n })));
    r.check("order living past MAX_UNWIND_ORDER_TTL: refused at intake (ERC-1271)", !long.ok && long.code === "bad_signature", JSON.stringify(long));

    // Clear the book so the oversize order meets exactly one bid of its own
    // size: leftover step-4 bids would fill it in slices under the cap, which
    // is correct (the cap is per fill) but not what this check is about.
    await sql.query(
      `UPDATE "Order" SET "status" = 'CANCELLED', "updatedAt" = now() WHERE "network" = $1 AND "status" IN ('OPEN', 'PARTIALLY_FILLED')`,
      [NETWORK.id]
    );
    const oversize = await book.submit(await body(craft({ nonce: 3n })));
    r.check("oversize but validly signed order passes the intake", oversize.ok, JSON.stringify(oversize));
    const fb = await lc.client.getBlockNumber();
    await trading.place({ who: buyer, marketId: BTC, isLong: true, size: 5n * 10n ** 16n, price: 97_000n * E18 });

    // The matcher holds backstop fills to Insurance's own band and caps
    // (lib/matcher/band.ts), so it never offers this one: no gas is spent.
    const guarded = await trading.match(BTC);
    const guardedRow = oversize.ok ? await book.orderState(oversize.orderHash) : null;
    const guardedRejects = parseEventLogs({ abi: orderGatewayAbi, logs: await lc.client.getLogs({ address: orderGateway, fromBlock: fb }), eventName: "FillRejected" });
    r.check(
      "the matcher drops the oversize fill before it costs gas",
      guarded.backstopDrops >= 1 && guardedRow?.filledSize === 0n && guardedRejects.length === 0,
      `drops ${guarded.backstopDrops}, filled ${guardedRow?.filledSize}, ${guardedRejects.length} FillRejected`
    );

    // With that guard bypassed, the contract itself is what refuses the fill.
    const ub = await lc.client.getBlockNumber();
    const unguarded = await trading.match(BTC, { unguarded: true });
    const rejections = parseEventLogs({ abi: orderGatewayAbi, logs: await lc.client.getLogs({ address: orderGateway, fromBlock: ub }), eventName: "FillRejected" })
      .map((e) => {
        try {
          return decodeErrorResult({ abi: ALL_ERRORS_ABI, data: (e.args as { reason: Hex }).reason }).errorName;
        } catch {
          return "undecoded";
        }
      });
    const oversizeRow = oversize.ok ? await book.orderState(oversize.orderHash) : null;
    r.check(
      "…and Insurance rejects it on its own when it does reach the chain (BackstopLimitExceeded)",
      rejections.includes("BackstopLimitExceeded") && oversizeRow?.filledSize === 0n,
      `${rejections.join(",")}; oversize filled ${oversizeRow?.filledSize}; drops ${unguarded.backstopDrops}`
    );
    const late = parseEventLogs({ abi: insuranceAbi, logs: await lc.client.getLogs({ address: insurance, fromBlock: fb }), eventName: "BackstopUnwound" }) as unknown as { args: { notional: bigint } }[];
    r.check("no fill accepted over the per-fill cap", late.every((e) => e.args.notional <= MAX_FILL));

    // ── 6. paused ──
    r.step("6. paused protocol: the unwinder idles");
    const ph = await lc.wallet(ROLES.guardian).writeContract({ address: orderGateway, abi: orderGatewayAbi, functionName: "pause", chain: lc.chain, account: ROLES.guardian, ...FEES });
    await lc.client.waitForTransactionReceipt({ hash: ph });
    const tp = await tick();
    r.check("idle (paused)", tp.status === "idle" && tp.reason === "paused", JSON.stringify(tp));
    await lc.asAddress(timelock, { to: orderGateway, data: encodeFunctionData({ abi: orderGatewayAbi, functionName: "unpause" }) });

    // ── 7. end state ──
    r.step("7. end state");
    await lc.warp(3_700);
    await trading.pushIndex({ BTC: 97_000n * E18, ETH: 3_000n * E18 });
    chainNow = BigInt(await lc.now());
    await unwinder.closeFinished(chainNow);
    const [assets, liabilities] = await read<[bigint, bigint]>(lc, vault, vaultAbi, "solvency");
    r.check(`Vault.solvency(): assets ${usd(assets)} >= liabilities ${usd(liabilities)}`, assets >= liabilities);
    const open = (await sql.query(
      `SELECT count(*)::int AS n FROM "KeeperAction" WHERE "kind" = 'backstop.unwind' AND "status"::text IN ('PLANNED','SUBMITTED')`
    )) as { n: number }[];
    r.check("every unwind intent is terminal", open[0].n === 0, String(open[0].n));
    const confirmed = (await sql.query(
      `SELECT count(*)::int AS n FROM "KeeperAction" WHERE "kind" = 'backstop.unwind' AND "status" = 'CONFIRMED'`
    )) as { n: number }[];
    r.check(`${confirmed[0].n} intent(s) confirmed from the indexer's Order rows`, confirmed[0].n >= 2);
    r.note(`metrics: ${JSON.stringify(metrics.snapshot())}`);
  } finally {
    await trading.end();
    lc.stop();
    await sql.end();
  }
  process.stdout.write(`\n${r.failures === 0 ? "✓ backstop unwind drill passed" : `✗ backstop drill: ${r.failures} check(s) failed`}\n`);
  process.exit(r.failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
