#!/usr/bin/env tsx
/**
 * Liquidation cascade drill (audit KRY-Q7, on Arc): the real liquidation
 * keeper against the real Engine, Liquidation, Insurance and Vault on a local
 * arc-anvil, with the real matcher opening the positions and the real indexer
 * projecting them.
 *
 * The cascade:
 *   - three 40x longs and one ~27x long against one well-capitalised short
 *   - a pause: the keeper idles instead of burning gas on reverts
 *   - a 3% drop with a stale oracle: every account is blocked, nothing is sent
 *   - prices fresh: the 40x longs are closed out in full (equity <= 0), their
 *     deficits exceed the fund's operating capital and become bad debt; the
 *     27x long is cut by a partial step and ends healthy
 *   - a further drop: the backstop that absorbed the positions goes under
 *   - ADL, one step per tick, haircuts the in-profit short until the unfunded
 *     shortfall is zero
 *   - at the end: Vault.solvency() holds, every intent is terminal, and every
 *     confirmed liquidation/ADL is matched by an indexer event row
 *
 * LOCAL ONLY. Environment: KRYON_E2E_DATABASE_URL (required), KRYON_E2E_RPC_PORT,
 * KRYON_E2E_VERBOSE.
 */

import { encodeFunctionData, type Address } from "viem";

import { engineAbi, insuranceAbi, liquidationAbi, vaultAbi } from "@/lib/chain/contracts";
import { TxSender } from "@/lib/chain/tx-sender";
import { MemoryTxJobStore } from "@/lib/chain/tx-store";
import { LiquidationKeeper, viemLiquidationChain, type LiquidationTickResult } from "@/lib/keepers/liquidation";
import { KeeperActions, Metrics, createLogger } from "@/lib/keepers/runtime";
import { FEES, NETWORK, ROLES, account, depositUsdc, reporter, startLocalChain, type LocalChain } from "@/lib/keepers/testkit/localchain";
import { E18, startTrading } from "@/lib/keepers/testkit/trading";
import { neon } from "@/lib/sql";

const r = reporter();
const BTC = 2;
const usd = (v: bigint) => `$${(Number(v / 10n ** 14n) / 1e4).toFixed(2)}`;

async function read<T>(lc: LocalChain, address: Address, abi: unknown, functionName: string, args: readonly unknown[] = []) {
  return (await lc.client.readContract({ address, abi, functionName, args } as never)) as T;
}

async function main() {
  const dbUrl = process.env.KRYON_E2E_DATABASE_URL;
  if (!dbUrl) throw new Error("KRYON_E2E_DATABASE_URL is required (a migrated, disposable Postgres)");
  const sql = neon(dbUrl);

  r.step("boot arc-anvil, deploy, open the book");
  const lc = await startLocalChain({ log: r.note });
  const trading = await startTrading(lc, dbUrl, [BTC]);
  const { engine, liquidation, insurance, vault } = lc.contracts;
  try {
    const whale = account(20);
    const v40 = [account(21), account(22), account(23)];
    const v27 = account(24);
    const liquidator = account(25);
    for (const a of [whale, ...v40, v27, liquidator]) await lc.setBalance(a.address, 20_000n * E18);

    await depositUsdc(lc, whale, 9_000_000_000n);
    for (const v of v40) await depositUsdc(lc, v, 200_000_000n);
    await depositUsdc(lc, v27, 300_000_000n);
    await trading.pushIndex({ BTC: 100_000n * E18, ETH: 3_000n * E18 });

    const SIZE = 8n * 10n ** 16n; // 0.08 BTC, $8,000 at $100k
    for (const v of [...v40, v27]) {
      await trading.trade({ marketId: BTC, long: v, short: whale, size: SIZE, price: 100_000n * E18 });
    }
    const w = await trading.position(whale.address, BTC);
    r.check("four longs of 0.08 BTC against one 0.32 BTC short", w.size === -4n * SIZE, String(w.size));
    const posRows = (await sql.query(`SELECT count(*)::int AS n FROM "Position" WHERE "size" <> 0`)) as { n: number }[];
    r.check("indexer projected all five positions", posRows[0].n === 5, String(posRows[0].n));

    const logs: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
    const log = createLogger("liquidator", "debug", {}, (line) => {
      const { level, msg, ...fields } = JSON.parse(line);
      logs.push({ level, msg, fields });
      if (process.env.KRYON_E2E_VERBOSE) process.stdout.write(`    · ${level} ${msg} ${JSON.stringify(fields).slice(0, 300)}\n`);
    });
    const keeper = new LiquidationKeeper({
      chain: viemLiquidationChain({ client: lc.client, engine, liquidation, insurance, vault }),
      sender: new TxSender({ network: NETWORK, service: "liquidator", chain: lc.client, signer: liquidator, store: new MemoryTxJobStore(), pollMs: 100 }),
      sql,
      network: NETWORK.id,
      contracts: { engine, liquidation, insurance },
      log,
      metrics: new Metrics(),
      actions: new KeeperActions(sql, NETWORK.id),
      maxAccountsPerTick: 25,
      maxStepsPerAccount: 10,
      indexerGraceMs: 0,
      adlMinShortfall: E18,
    });
    const nonce = () => lc.client.getTransactionCount({ address: liquidator.address });
    const health = (who: Address) =>
      read<{ equity: bigint; maintenanceMarginRequired: bigint; liquidatable: boolean }>(lc, engine, engineAbi, "accountHealth", [who]);
    const tick = async (): Promise<LiquidationTickResult> => {
      const res = await keeper.tick();
      await trading.index();
      return res;
    };

    // ── pause ──
    r.step("1. paused protocol: the keeper idles");
    const ph = await lc.wallet(ROLES.guardian).writeContract({
      address: liquidation,
      abi: liquidationAbi,
      functionName: "pause",
      chain: lc.chain,
      account: ROLES.guardian,
      ...FEES,
    });
    await lc.client.waitForTransactionReceipt({ hash: ph });
    const n0 = await nonce();
    const p = await tick();
    r.check("tick reports paused", p.status === "paused");
    r.check("nothing sent", (await nonce()) === n0);
    await lc.asAddress(await lc.timelock(), { to: liquidation, data: encodeFunctionData({ abi: liquidationAbi, functionName: "unpause" }) });
    r.check("unpaused by governance", !(await read<boolean>(lc, liquidation, liquidationAbi, "paused")));

    // ── stale oracle ──
    r.step("2. a 3% drop, but the oracle goes stale first: every account blocked");
    await trading.pushIndex({ BTC: 97_000n * E18, ETH: 3_000n * E18 });
    await lc.warp(30);
    const n1 = await nonce();
    const st = await tick();
    r.check("all five accounts reported blocked on the oracle", st.blocked.length === 5, String(st.blocked.length));
    r.check("no liquidation attempted", st.liquidated.length === 0 && (await nonce()) === n1);
    // The backstop is still flat, so unfundedShortfall needs no price: "no shortfall" is right here.
    r.check("ADL: backstop flat, nothing to offset", (st.adl as { skipped?: string })?.skipped === "no-shortfall", JSON.stringify(st.adl));

    // ── liquidations ──
    r.step("3. prices fresh: the cascade");
    await trading.pushIndex({ BTC: 97_000n * E18, ETH: 3_000n * E18 });
    for (const v of v40) {
      const h = await health(v.address);
      r.check(`40x long ${v.address.slice(0, 8)} under water (equity ${usd(h.equity)})`, h.liquidatable && h.equity <= 0n);
    }
    const h27 = await health(v27.address);
    r.check(
      `27x long liquidatable with positive equity (${usd(h27.equity)} < MM ${usd(h27.maintenanceMarginRequired)})`,
      h27.liquidatable && h27.equity > 0n
    );

    const liq = await tick();
    for (const v of v40) {
      const pos = await trading.position(v.address, BTC);
      r.check(`40x long ${v.address.slice(0, 8)} closed out in full`, pos.size === 0n, String(pos.size));
    }
    const p27 = await trading.position(v27.address, BTC);
    const after27 = await health(v27.address);
    r.check("27x long cut by a partial step, not closed", p27.size > 0n && p27.size < SIZE, String(p27.size));
    r.check("27x long healthy after the step", !after27.liquidatable);
    r.check(
      "the keeper stopped stepping once health was restored",
      liq.liquidated.find((x) => x.trader.toLowerCase() === v27.address.toLowerCase())?.stillLiquidatable === false
    );

    // Judged from the indexer's event rows: ADL may already have started in
    // this same tick, as soon as the close-outs left bad debt behind.
    const moved = (await sql.query(
      `SELECT COALESCE(SUM("closeSize"), 0)::text AS s FROM "LiquidationEvent" WHERE "network" = $1`,
      [NETWORK.id]
    )) as { s: string }[];
    r.check("the backstop absorbed the closed longs (LiquidationEvent rows)", BigInt(moved[0].s) > 3n * SIZE, moved[0].s);
    const badDebt = await read<bigint>(lc, insurance, insuranceAbi, "badDebt");
    r.check(`bad debt recorded (${usd(badDebt)}): deficits exceeded operating capital`, badDebt > 0n);
    r.check("ADL began in the same tick the bad debt appeared", !!(liq.adl as { counterparty?: string })?.counterparty, JSON.stringify(liq.adl, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

    // ── backstop under water ──
    r.step("4. a further drop to $95,000: the backstop goes under");
    await trading.pushIndex({ BTC: 95_000n * E18, ETH: 3_000n * E18 });
    const [marked] = await read<[bigint, boolean]>(lc, insurance, insuranceAbi, "markedOperatingBalance");
    r.check(`insurance marked operating balance negative (${usd(marked)})`, marked < 0n);
    const shortfall0 = await read<bigint>(lc, insurance, insuranceAbi, "unfundedShortfall");
    r.check(`unfunded shortfall ${usd(shortfall0)}`, shortfall0 > 0n);

    r.step("5. ADL blocked while the backstop cannot be priced");
    await lc.warp(30);
    const blockedAdl = await tick();
    r.check("unfundedShortfall reverting StaleOracle reads as blocked, never as zero", (blockedAdl.adl as { skipped?: string })?.skipped === "oracle", JSON.stringify(blockedAdl.adl));

    r.step("6. ADL, one step per tick, until the shortfall is gone");
    await trading.pushIndex({ BTC: 95_000n * E18, ETH: 3_000n * E18 });
    const whaleEq0 = (await health(whale.address)).equity;
    let steps = 0;
    for (let i = 0; i < 10; i++) {
      await trading.pushIndex({ BTC: 95_000n * E18, ETH: 3_000n * E18 });
      const t = await tick();
      const a = t.adl as { counterparty?: Address; haircut?: bigint; skipped?: string };
      if (!a?.counterparty) break;
      steps += 1;
      r.check(`ADL step ${steps}: counterparty is the in-profit short`, a.counterparty.toLowerCase() === whale.address.toLowerCase());
    }
    const shortfall1 = await read<bigint>(lc, insurance, insuranceAbi, "unfundedShortfall");
    r.check(`shortfall cleared to below $1 in ${steps} step(s) (left: ${shortfall1} wei)`, shortfall1 < E18);
    // Every haircut bounded by the shortfall the keeper saw when it decided.
    const adls = (await sql.query(
      `SELECT "payload" FROM "KeeperAction" WHERE "kind" = 'liquidation.adl' AND "status" = 'CONFIRMED' ORDER BY "id"`
    )) as { payload: { shortfall: string; events: { event: string; args: { haircut?: string } }[] } }[];
    const bounded = adls.every((x) => {
      const h = BigInt(x.payload.events.find((e) => e.event === "Deleveraged")?.args.haircut ?? "0");
      return h > 0n && h <= BigInt(x.payload.shortfall);
    });
    r.check(`${adls.length} ADL haircut(s), each within the shortfall at the time`, adls.length > 0 && bounded);
    const whaleEq1 = (await health(whale.address)).equity;
    r.check("the short kept the rest of its profit", whaleEq1 > 0n && whaleEq1 <= whaleEq0);
    const n2 = await nonce();
    const idle = await tick();
    const idleWhy = (idle.adl as { skipped?: string })?.skipped;
    r.check("no ADL attempted once the shortfall is gone or dust", (idleWhy === "no-shortfall" || idleWhy === "dust") && (await nonce()) === n2, String(idleWhy));

    // ── end state ──
    r.step("7. end state");
    const [assets, liabilities] = await read<[bigint, bigint]>(lc, vault, vaultAbi, "solvency");
    r.check(`Vault.solvency(): assets ${usd(assets)} >= liabilities ${usd(liabilities)}`, assets >= liabilities);
    const open = (await sql.query(
      `SELECT count(*)::int AS n FROM "KeeperAction" WHERE "kind" LIKE 'liquidation.%' AND "status"::text IN ('PLANNED','SUBMITTED')`
    )) as { n: number }[];
    r.check("every keeper intent is terminal", open[0].n === 0);
    await keeper.tick(); // one more pass so reconcileIndexed sees the indexer's rows
    const unindexed = (await sql.query(
      `SELECT count(*)::int AS n FROM "KeeperAction" WHERE "status" = 'CONFIRMED'
         AND "kind" IN ('liquidation.liquidate','liquidation.adl') AND ("payload"->>'indexed') <> 'true'`
    )) as { n: number }[];
    r.check("every confirmed liquidation/ADL matched by an indexer event row", unindexed[0].n === 0, String(unindexed[0].n));
    const counts = (await sql.query(
      `SELECT (SELECT count(*)::int FROM "LiquidationEvent") AS l, (SELECT count(*)::int FROM "DeleverageEvent") AS d`
    )) as { l: number; d: number }[];
    r.note(`indexer: ${counts[0].l} LiquidationEvent, ${counts[0].d} DeleverageEvent rows`);
  } finally {
    await trading.end();
    lc.stop();
    await sql.end();
  }
  process.stdout.write(`\n${r.failures === 0 ? "✓ liquidation cascade drill passed" : `✗ liquidation drill: ${r.failures} check(s) failed`}\n`);
  process.exit(r.failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
