#!/usr/bin/env tsx
/**
 * Oracle publisher drill: two publisher keys against the real OracleAdapter on
 * a local arc-anvil. Proves, with the real publisher code:
 *
 *   1. normal publish      two publishers, quorum of two, getPrice serves it
 *   2. moves               a 1.5% move converges with no stale window; a 30% move is held for jump
 *   3. quorum-of-one       one publisher alone cannot move the price; it goes stale
 *   4. outage + re-anchor  after > maxAge, the moved price re-anchors cleanly
 *   5. divergence halt     a price away from the Chainlink reference is held + alerted
 *   6. de-peg halt         USDC off peg stops every feed; nothing is sent
 *
 * Sources are scripted, the chain and contracts are real. LOCAL ONLY.
 *
 * Environment:
 *   KRYON_E2E_DATABASE_URL   a migrated, DISPOSABLE Postgres (required; KeeperAction rows)
 *   KRYON_E2E_RPC_PORT       anvil port (default 8545)
 *   KRYON_E2E_VERBOSE        print every publisher log line
 *
 * Usage:
 *   KRYON_E2E_DATABASE_URL=postgresql://localhost:5432/kryon_keepers_test npm run drill:oracle
 */

import { encodeFunctionData, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";

import { oracleAdapterAbi } from "@/lib/chain/contracts";
import { oracleId } from "@/lib/chain/networks";
import { TxSender } from "@/lib/chain/tx-sender";
import { MemoryTxJobStore } from "@/lib/chain/tx-store";
import { KeeperActions, Metrics, createLogger } from "@/lib/keepers/runtime";
import {
  NETWORK,
  ROLES,
  account,
  mockAggregatorAbi,
  reporter,
  startLocalChain,
  type LocalChain,
} from "@/lib/keepers/testkit/localchain";
import { viemOracleChain } from "@/lib/oracle/chain";
import { OraclePublisher, type TickResult } from "@/lib/oracle/publisher";
import type { PriceSource } from "@/lib/oracle/sources";
import { neon } from "@/lib/sql";

const E18 = 10n ** 18n;
const r = reporter();

// ─── scripted venues ────────────────────────────────────────────────────────

const market: Record<string, number> = { BTC: 100_000, ETH: 3_000, USDC: 1 };
let clockMs = 0;

function venue(name: string, skew = 0): PriceSource {
  return {
    name,
    supports: () => true,
    fetch: async (symbols) => ({
      quotes: symbols
        .filter((s) => s in market)
        .map((s) => ({
          source: name,
          symbol: s,
          price: BigInt(Math.round(market[s] * (1 + skew) * 1e6)) * 10n ** 12n,
          ts: clockMs,
        })),
      errors: [],
    }),
  };
}

// ─── setup ──────────────────────────────────────────────────────────────────

async function configure(lc: LocalChain, p2: HDAccount): Promise<Hex> {
  const timelock = await lc.timelock();
  const oracle = lc.contracts.oracleAdapter;
  const call = (functionName: string, args: readonly unknown[]) =>
    lc.asAddress(timelock, { to: oracle, data: encodeFunctionData({ abi: oracleAdapterAbi, functionName, args } as never) });

  await call("setPublishers", [[ROLES.publisher.address, p2.address]]);
  for (const sym of ["BTC", "ETH"]) {
    const cfg = await lc.client.readContract({ address: oracle, abi: oracleAdapterAbi, functionName: "feed", args: [oracleId(sym)] });
    await call("setFeed", [oracleId(sym), { ...cfg, minPublishers: 2 }]);
  }
  const agg = await lc.deployMockAggregator(8);
  await setReference(lc, agg, market.BTC);
  await call("setReferenceFeed", [
    oracleId("BTC"),
    { aggregator: agg, enabled: true, required: false, maxDivergenceBps: 150, maxRefAge: 90_000 },
  ]);
  return agg;
}

async function setReference(lc: LocalChain, agg: Hex, usd: number) {
  const hash = await lc.wallet(ROLES.deployer).writeContract({
    address: agg,
    abi: mockAggregatorAbi,
    functionName: "set",
    args: [BigInt(Math.round(usd * 1e8)), BigInt(await lc.now())],
    chain: lc.chain,
    account: ROLES.deployer,
    maxFeePerGas: 100_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  await lc.client.waitForTransactionReceipt({ hash });
}

interface Pub {
  name: string;
  publisher: OraclePublisher;
  logs: { level: string; msg: string; fields: Record<string, unknown> }[];
  tick(): Promise<TickResult>;
}

function makePublisher(lc: LocalChain, name: string, who: HDAccount, actions: KeeperActions): Pub {
  const logs: Pub["logs"] = [];
  const verbose = !!process.env.KRYON_E2E_VERBOSE;
  const log = createLogger(name, "debug", {}, (line) => {
    const { level, msg, ...fields } = JSON.parse(line);
    logs.push({ level, msg, fields });
    if (verbose) process.stdout.write(`    · ${name} ${level} ${msg} ${JSON.stringify(fields)}\n`);
  });
  const sender = new TxSender({
    network: NETWORK,
    service: name,
    chain: lc.client,
    signer: who,
    store: new MemoryTxJobStore(),
    pollMs: 100,
    rebroadcastAfterMs: 1_000,
    replaceAfterMs: 3_000,
    waitTimeoutMs: 12_000,
  });
  const publisher = new OraclePublisher({
    chain: viemOracleChain({ client: lc.client, oracle: lc.contracts.oracleAdapter, self: who.address }),
    sender,
    oracle: lc.contracts.oracleAdapter,
    sources: [venue("v1"), venue("v2", 0.0001), venue("v3", -0.0001)],
    log,
    metrics: new Metrics(),
    actions,
    aggregate: { minSources: 2, maxSourceDeviationBps: 50n },
    // Heartbeat of 1s so every drill tick is due; the timing rules still apply.
    policy: { deviationBps: 5n, heartbeatSecs: 1, inclusionMarginSecs: 3, maxRefDivergenceBps: 0 },
    maxQuoteAgeMs: 5_000,
    usdcDepegHaltBps: 100n,
    depegFailClosed: true,
    backdateSecs: 1,
    alertAfterSecs: 30,
    now: () => clockMs,
  });
  return {
    name,
    publisher,
    logs,
    async tick() {
      await lc.warp(2);
      clockMs = (await lc.now()) * 1000;
      return publisher.tick();
    },
  };
}

async function getPrice(lc: LocalChain, sym: string): Promise<{ ok: true; price: bigint } | { ok: false; error: string }> {
  try {
    const s = await lc.client.readContract({
      address: lc.contracts.oracleAdapter,
      abi: oracleAdapterAbi,
      functionName: "getPrice",
      args: [oracleId(sym), 0, 0],
    });
    return { ok: true, price: s.price };
  } catch (err) {
    const m = /(StaleOracle|OracleConfidenceTooWide|InvalidPrice)/.exec(String(err));
    return { ok: false, error: m ? m[1] : String(err).slice(0, 80) };
  }
}

const usd = (v: bigint) => `$${(Number(v / 10n ** 12n) / 1e6).toLocaleString()}`;

// ─── scenarios ──────────────────────────────────────────────────────────────

async function main() {
  const dbUrl = process.env.KRYON_E2E_DATABASE_URL;
  if (!dbUrl) throw new Error("KRYON_E2E_DATABASE_URL is required (a migrated, disposable Postgres)");
  const sql = neon(dbUrl);
  const actions = new KeeperActions(sql, "arc-local");

  r.step("boot arc-anvil and deploy");
  const lc = await startLocalChain({ blockTime: 1, log: r.note });
  try {
    const p2key = account(11);
    await lc.setBalance(p2key.address, 1_000n * E18);
    const agg = await configure(lc, p2key);
    r.check("two publishers, minPublishers = 2, Chainlink reference on BTC", true);

    const P1 = makePublisher(lc, "publisher-1", ROLES.publisher, actions);
    const P2 = makePublisher(lc, "publisher-2", p2key, actions);

    // ── 1 ──
    r.step("1. normal publish: quorum of two");
    const a1 = await P1.tick();
    r.check("first publisher alone: observation stored, aggregate skipped for quorum",
      a1.outcomes?.get("BTC")?.kind === "skipped" && (a1.outcomes.get("BTC") as { reason: string }).reason === "quorum",
      JSON.stringify(a1.outcomes?.get("BTC"), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const a2 = await P2.tick();
    const b = a2.outcomes?.get("BTC");
    r.check("second publisher: PriceUpdated with two sources", b?.kind === "updated" && b.sourceCount === 2);
    const gp = await getPrice(lc, "BTC");
    r.check("getPrice serves the median", gp.ok && gp.price > 99_900n * E18 && gp.price < 100_100n * E18, JSON.stringify(gp, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    if (gp.ok) r.note(`BTC ${usd(gp.price)}`);

    // ── 2 ──
    // With two publishers the median is their midpoint, so each sits half the
    // gap from it: 1.5% apart is 0.75% from the median, past the 0.5% bound.
    r.step("2a. a 1.5% move: the publishers converge with no stale window");
    market.BTC = 101_500;
    await setReference(lc, agg, market.BTC);
    const m1 = await P1.tick();
    const m1o = m1.outcomes?.get("BTC");
    r.check("publisher-1 sends although the contract will skip for spread (peer still at $100k)",
      m1o?.kind === "skipped" && m1o.reason === "spread", JSON.stringify(m1o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    r.check("the old price is still served meanwhile", (await getPrice(lc, "BTC")).ok);
    const m2 = await P2.tick();
    const m2o = m2.outcomes?.get("BTC");
    r.check("publisher-2's push converges: PriceUpdated at the new level",
      m2o?.kind === "updated" && m2o.price > 101_400n * E18);
    r.check("getPrice never went stale", (await getPrice(lc, "BTC")).ok);

    // _aggregate checks spread before jump, so the first publisher to see a
    // 30% move is skipped for spread; the second then sees both observations
    // agree and hits the jump guard against the fresh stored price.
    r.step("2b. a 30% move against a fresh price: sent once, then held for jump");
    market.BTC = 130_000;
    await setReference(lc, agg, market.BTC);
    const j1 = await P1.tick();
    const j1o = j1.outcomes?.get("BTC");
    r.check("publisher-1: observation stored, aggregate skipped for spread", j1o?.kind === "skipped" && j1o.reason === "spread");
    r.check("ETH still published in the same tick", j1.outcomes?.get("ETH")?.kind === "updated");
    const j2 = await P2.tick();
    const jd = j2.decisions.get("BTC");
    r.check("publisher-2: BTC held for jump, not sent", jd?.action === "hold" && jd.reason === "jump",
      JSON.stringify(jd?.action === "hold" ? jd.reason : jd?.action));

    // ── 3 ──
    r.step("3. quorum-of-one: publisher-2 goes down");
    await lc.warp(20);
    const q = await P1.tick();
    const qd = q.decisions.get("BTC");
    r.check("publisher-1 re-anchor candidate sent despite the jump (stored price stale)", qd?.action === "publish");
    const qo = q.outcomes?.get("BTC");
    r.check("contract refuses the lone observation: QuorumNotMet", qo?.kind === "skipped" && qo.reason === "quorum");
    const stale = await getPrice(lc, "BTC");
    r.check("getPrice reverts StaleOracle while quorum is lost", !stale.ok && stale.error === "StaleOracle", JSON.stringify(stale));
    r.check("stale feed raised an alert", P1.logs.some((l) => l.fields.alertKey === "stale:BTC"));

    // ── 4 ──
    r.step("4. outage over: publisher-2 returns and the feed re-anchors");
    const ra = await P2.tick();
    const rao = ra.outcomes?.get("BTC");
    r.check("PriceUpdated with PriceReanchored", rao?.kind === "updated" && rao.reanchored, JSON.stringify(rao, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    r.check("re-anchor logged explicitly", P2.logs.some((l) => l.msg === "feed re-anchored after an outage"));
    const back = await getPrice(lc, "BTC");
    r.check("getPrice serves the new level", back.ok && back.price > 129_800n * E18, JSON.stringify(back, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    if (back.ok) r.note(`BTC ${usd(back.price)}`);
    const again = await P1.tick();
    r.check("publishing resumes normally (no lingering back-off)", again.outcomes?.get("BTC")?.kind === "updated");

    // ── 5 ──
    r.step("5. divergence halt: Chainlink says 5% lower");
    await setReference(lc, agg, market.BTC * 0.95);
    const dv = await P1.tick();
    const dvd = dv.decisions.get("BTC");
    r.check("BTC held for divergence", dvd?.action === "hold" && dvd.reason === "divergence");
    r.check("divergence alert raised", P1.logs.some((l) => l.fields.alertKey === "divergence:BTC"));
    r.check("no BTC observation sent", !dv.outcomes?.has("BTC"));
    await setReference(lc, agg, market.BTC);

    // ── 6 ──
    r.step("6. de-peg halt: USDC at $0.97");
    market.USDC = 0.97;
    const nonceBefore = await lc.client.getTransactionCount({ address: ROLES.publisher.address });
    const dp = await P1.tick();
    const nonceAfter = await lc.client.getTransactionCount({ address: ROLES.publisher.address });
    r.check("tick halts on de-peg", dp.status === "depeg-halt");
    r.check("nothing sent", nonceAfter === nonceBefore);
    r.check("de-peg alert raised", P1.logs.some((l) => l.fields.alertKey === "depeg"));
    market.USDC = 1;
    const ok = await P1.tick();
    r.check("peg restored: publishing resumes", ok.status === "published");

    const rows = await sql.query(`SELECT count(*)::int AS n FROM "KeeperAction" WHERE "kind" = 'oracle.push'`);
    r.note(`${rows[0].n} oracle.push KeeperAction rows recorded`);
  } finally {
    lc.stop();
    await sql.end();
  }

  process.stdout.write(`\n${r.failures === 0 ? "✓ oracle drill passed" : `✗ oracle drill: ${r.failures} check(s) failed`}\n`);
  process.exit(r.failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
