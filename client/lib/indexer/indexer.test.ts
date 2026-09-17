// Indexer against a scripted chain and a real Postgres (plan §6.4 tests:
// kill-and-resume, full replay equality). Needs KRYON_TEST_DATABASE_URL
// pointing at a migrated, disposable database: every table is truncated.
// Run: KRYON_TEST_DATABASE_URL=postgresql://localhost:5432/kryon_test npm test

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  keccak256,
  toHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";

import {
  engineAbi,
  feeRouterAbi,
  insuranceAbi,
  kryonErrorsAbi,
  kryonTimelockAbi,
  liquidationAbi,
  oracleAdapterAbi,
  orderGatewayAbi,
  riskParamsAbi,
  vaultAbi,
} from "@/lib/chain/contracts";
import { oracleId, type ProtocolContracts } from "@/lib/chain/networks";
import { pgDb, type Db, type Query } from "./db";
import { ContractRegistry, type RawLog } from "./decode";
import { Indexer, type LogSource } from "./indexer";

const url = process.env.KRYON_TEST_DATABASE_URL;
const NETWORK = "arc-local";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const CONTRACTS: ProtocolContracts = {
  vault: addr(0xa1),
  engine: addr(0xa2),
  orderGateway: addr(0xa3),
  oracleAdapter: addr(0xa4),
  liquidation: addr(0xa5),
  insurance: addr(0xa6),
  riskParams: addr(0xa7),
  feeRouter: addr(0xa8),
  timelock: addr(0xa9),
};
const ALICE = "0xaaaa00000000000000000000000000000000aaaa" as Address;
const BOB = "0xbbbb00000000000000000000000000000000bbbb" as Address;
const KEEPER = "0xcccc00000000000000000000000000000000cccc" as Address;
const E18 = 10n ** 18n;
const h = (label: string) => keccak256(toHex(label));
const b32 = (s: string) => oracleId(s);

// ── Scripted chain ───────────────────────────────────────────────────────────

function makeLog(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>): Omit<RawLog, "blockNumber" | "logIndex" | "transactionHash"> {
  const item = abi.find((x) => x.type === "event" && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [item], eventName, args } as never) as Hex[];
  const data = item.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics,
    data: encodeAbiParameters(
      data,
      data.map((i) => args[i.name!])
    ),
  };
}

class FakeChain implements LogSource {
  logs: RawLog[] = [];
  head = 0n;
  /** getLogs fails with a range error above this many blocks. */
  maxRange = 1_000n;
  getLogsCalls = 0;

  block(txLabel: string, entries: ReturnType<typeof makeLog>[]): void {
    this.head += 1n;
    entries.forEach((e, i) =>
      this.logs.push({ ...e, blockNumber: this.head, logIndex: i, transactionHash: h(`${txLabel}-${this.head}`) })
    );
  }

  async getBlockNumber() {
    return this.head;
  }
  async getBlock(n: bigint) {
    return { hash: h(`block-${n}`), timestamp: 1_800_000_000n + n * 2n };
  }
  async getLogs({ address, fromBlock, toBlock }: { address: Address[]; fromBlock: bigint; toBlock: bigint }) {
    this.getLogsCalls += 1;
    if (toBlock - fromBlock + 1n > this.maxRange) throw new Error("query exceeds max block range 1");
    const set = new Set(address.map((a) => a.toLowerCase()));
    return this.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && set.has(l.address.toLowerCase()));
  }
}

function scenario(chain: FakeChain): void {
  const { vault, engine, orderGateway, oracleAdapter, liquidation, insurance, riskParams, feeRouter, timelock } = CONTRACTS;
  const opId = h("op-1");
  chain.block("setup", [
    makeLog(riskParamsAbi, riskParams, "MarketListed", { marketId: 1, oracleId: b32("BTC") }),
    makeLog(riskParamsAbi, riskParams, "MarketActiveSet", { marketId: 1, active: true }),
    makeLog(feeRouterAbi, feeRouter, "MarketFeesSet", { marketId: 1, makerRate: 5, takerRate: 35 }),
  ]);
  chain.block("deposits", [
    makeLog(vaultAbi, vault, "Deposited", { payer: ALICE, account: ALICE, amount: 1_000_000_000n, internalAmount: 1_000n * E18 }),
    makeLog(vaultAbi, vault, "Deposited", { payer: BOB, account: BOB, amount: 500_000_000n, internalAmount: 500n * E18 }),
    makeLog(kryonTimelockAbi, timelock, "CallScheduled", {
      id: opId, index: 0n, target: riskParams, value: 0n, data: "0x1234", predecessor: `0x${"0".repeat(64)}`, delay: 172_800n,
    }),
    makeLog(kryonTimelockAbi, timelock, "CallScheduled", {
      id: opId, index: 1n, target: feeRouter, value: 0n, data: "0xabcd", predecessor: `0x${"0".repeat(64)}`, delay: 172_800n,
    }),
    makeLog(kryonTimelockAbi, timelock, "CallSalt", { id: opId, salt: h("salt") }),
  ]);
  chain.block("batch", [
    makeLog(engineAbi, engine, "PositionChanged", {
      trader: ALICE, marketId: 1, reason: b32("TRADE"), sizeDelta: E18, price: 60_000n * E18, size: E18, openNotional: 60_000n * E18, realizedPnl: 0n,
    }),
    makeLog(engineAbi, engine, "PositionChanged", {
      trader: BOB, marketId: 1, reason: b32("TRADE"), sizeDelta: -E18, price: 60_000n * E18, size: -E18, openNotional: 60_000n * E18, realizedPnl: 0n,
    }),
    makeLog(feeRouterAbi, feeRouter, "FeeAccrued", {
      marketId: 1, payer: ALICE, referrer: addr(0), amount: 21n * E18, toTreasury: 147n * E18 / 10n, toInsurance: 42n * E18 / 10n, toReferral: 21n * E18 / 10n,
    }),
    makeLog(feeRouterAbi, feeRouter, "FeeAccrued", {
      marketId: 1, payer: BOB, referrer: addr(0), amount: -3n * E18, toTreasury: -3n * E18, toInsurance: 0n, toReferral: 0n,
    }),
    makeLog(orderGatewayAbi, orderGateway, "FillSettled", {
      fillId: h("fill-1"), makerOrderHash: h("order-bob"), takerOrderHash: h("order-alice"), marketId: 1, maker: BOB, taker: ALICE,
      takerIsBuy: true, size: E18, price: 60_000n * E18, makerFee: -3n * E18, takerFee: 21n * E18, makerTier: 0, takerTier: 0,
    }),
    makeLog(orderGatewayAbi, orderGateway, "FillRejected", {
      fillId: h("fill-2"), reason: encodeErrorResult({ abi: kryonErrorsAbi, errorName: "AccountInsolvent" }),
    }),
  ]);
  chain.block("keepers", [
    makeLog(oracleAdapterAbi, oracleAdapter, "PriceUpdated", {
      id: b32("BTC"), price: 59_000n * E18, confidence: E18, publishTime: 1_800_000_007n, writeTime: 1_800_000_008n, sourceCount: 3,
    }),
    makeLog(engineAbi, engine, "FundingUpdated", {
      marketId: 1, longIndex: 5n * E18 / 1000n, shortIndex: -5n * E18 / 1000n, ratePerHour: E18 / 10_000n, premium: E18 / 1000n, mark: 59_050n * E18, index: 59_000n * E18,
    }),
    makeLog(engineAbi, engine, "FundingSettled", { trader: ALICE, marketId: 1, amount: -2n * E18 }),
    makeLog(feeRouterAbi, feeRouter, "FeeTierSet", { account: BOB, tier: 2 }),
  ]);
  chain.block("liquidation", [
    makeLog(engineAbi, engine, "PositionChanged", {
      trader: BOB, marketId: 1, reason: b32("LIQUIDATION"), sizeDelta: E18, price: 70_000n * E18, size: 0n, openNotional: 0n, realizedPnl: -10_000n * E18,
    }),
    makeLog(engineAbi, engine, "PositionChanged", {
      trader: insurance, marketId: 1, reason: b32("LIQUIDATION"), sizeDelta: -E18, price: 70_000n * E18, size: -E18, openNotional: 70_000n * E18, realizedPnl: 0n,
    }),
    makeLog(vaultAbi, vault, "InternalTransfer", { from: BOB, to: insurance, amount: 50n * E18, reason: b32("LIQUIDATION_PENALTY") }),
    makeLog(liquidationAbi, liquidation, "Liquidated", {
      trader: BOB, liquidator: KEEPER, marketId: 1, closeSize: E18, price: 70_000n * E18, realizedPnl: -10_000n * E18,
      penalty: 50n * E18, reward: 10n * E18, equityBefore: 100n * E18, equityAfter: 40n * E18,
    }),
    makeLog(orderGatewayAbi, orderGateway, "NoncesCancelledUpTo", { owner: ALICE, minNonce: 5n }),
    makeLog(orderGatewayAbi, orderGateway, "OrderCancelled", { owner: BOB, nonce: 9n }),
  ]);
  chain.block("ops", [
    makeLog(liquidationAbi, liquidation, "Deleveraged", {
      counterparty: ALICE, keeper: KEEPER, marketId: 1, closeSize: E18 / 2n, price: 70_000n * E18, realizedPnl: 5_000n * E18, haircut: E18,
    }),
    makeLog(insuranceAbi, insurance, "BackstopUnwound", { marketId: 1, size: E18 / 2n, price: 69_000n * E18, notional: 34_500n * E18, dayTotal: 34_500n * E18 }),
    makeLog(feeRouterAbi, feeRouter, "FeeClaimed", { bucket: b32("TREASURY"), recipient: KEEPER, amount: 14_700_000n, internalAmount: 147n * E18 / 10n }),
    makeLog(kryonTimelockAbi, timelock, "CallExecuted", { id: opId, index: 0n, target: riskParams, value: 0n, data: "0x1234" }),
    makeLog(vaultAbi, vault, "Withdrawn", { account: ALICE, to: ALICE, amount: 100_000_000n, internalAmount: 100n * E18 }),
    { address: vault, topics: [h("NotAnEvent()")], data: "0x" },
  ]);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TABLES = [
  "ProtocolEvent", "BlockCursor", "Market", "Account", "Order", "Fill", "Position", "OracleSnapshot", "FundingUpdate",
  "FundingPayment", "LiquidationEvent", "DeleverageEvent", "BackstopUnwind", "FeeAccrual", "FeeClaim", "FeeTierAssignment",
  "BalanceChange", "PnlEvent", "GovernanceOperation",
];

async function truncateAll(q: Query) {
  await q.query(
    // Only the indexer's own tables: other suites (e.g. TxJobStore) share this
    // database and run in parallel.
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")}`
  );
}

/** Every projected table, without surrogate ids and timestamps, in a stable order. */
async function snapshot(q: Query): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    const rows = await q.query(`SELECT * FROM "${t}"`);
    out[t] = rows
      .map((r) => {
        const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = r as Record<string, unknown>;
        return JSON.stringify(t === "Market" || t === "Order" ? { id: _id, ...rest } : rest);
      })
      .sort();
  }
  return out;
}

async function seedMatcherRows(q: Query) {
  // Orders and fills the intake API / matcher write before the chain sees them.
  await q.query(`INSERT INTO "Market" ("network","id","symbol","oracleId","updatedAt") VALUES ($1, 1, 'BTC', $2, now())`, [NETWORK, b32("BTC")]);
  for (const a of [ALICE, BOB]) {
    await q.query(`INSERT INTO "Account" ("network","address","updatedAt") VALUES ($1,$2,now())`, [NETWORK, a.toLowerCase()]);
  }
  const order = (hash: Hex, owner: Address, isLong: boolean, nonce: number, size: bigint) =>
    q.query(
      `INSERT INTO "Order" ("orderHash","network","owner","marketId","isLong","size","limitPrice","reduceOnly","nonce","expiry","signature","updatedAt")
       VALUES ($1,$2,$3,1,$4,$5,$6,false,$7,1900000000,'0x00',now())`,
      [hash, NETWORK, owner.toLowerCase(), isLong, size.toString(), (61_000n * E18).toString(), nonce]
    );
  await order(h("order-alice"), ALICE, true, 1, E18);
  await order(h("order-bob"), BOB, false, 9, 2n * E18);
  await order(h("order-alice-2"), ALICE, true, 3, E18);
  for (const [fill, maker, taker] of [["fill-1", BOB, ALICE], ["fill-2", ALICE, BOB]] as const) {
    await q.query(
      `INSERT INTO "Fill" ("network","fillId","marketId","maker","taker","makerOrderHash","takerOrderHash","takerIsBuy","size","price","updatedAt")
       VALUES ($1,$2,1,$3,$4,$5,$6,true,$7,$8,now())`,
      [NETWORK, h(fill), maker.toLowerCase(), taker.toLowerCase(), h("order-bob"), h("order-alice"), E18.toString(), (60_000n * E18).toString()]
    );
  }
}

/** A Db whose transactions fail on the Nth statement, once. */
function failingDb(db: Db, failAt: number): Db {
  let armed = true;
  return {
    ...db,
    query: db.query.bind(db),
    end: db.end.bind(db),
    transaction: (fn) =>
      db.transaction(async (q) => {
        let count = 0;
        return fn({
          query: async (text, params) => {
            count += 1;
            if (armed && count === failAt) {
              armed = false;
              throw new Error("simulated crash");
            }
            return q.query(text, params);
          },
        });
      }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Indexer", { skip: !url }, () => {
  let db: Db;
  const registry = new ContractRegistry(CONTRACTS);
  before(async () => {
    db = pgDb(url!);
    await truncateAll(db);
  });
  after(async () => {
    await db?.end();
  });

  test("indexes the scenario, shrinking the window on provider range errors", async () => {
    await seedMatcherRows(db);
    const chain = new FakeChain();
    scenario(chain);
    chain.maxRange = 2n;
    const indexer = new Indexer(db, chain, registry, { network: NETWORK, startBlock: 1n, maxWindow: 4n });
    await indexer.catchUp();
    assert.equal(await indexer.cursor(), chain.head);

    const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params))[0] as Record<string, unknown>;

    const market = await one(`SELECT * FROM "Market" WHERE "id" = 1`);
    assert.equal(market.symbol, "BTC");
    assert.equal(market.active, true);
    assert.equal(market.takerRate, 35);
    assert.equal(market.lastIndex, (59_000n * E18).toString());
    assert.equal(market.lastMark, (59_050n * E18).toString());
    assert.equal(market.longOpenInterest, E18.toString());
    assert.equal(market.shortOpenInterest, E18.toString(), "short OI moved from bob to the insurance backstop");

    const bob = await one(`SELECT * FROM "Position" WHERE "trader" = $1`, [BOB.toLowerCase()]);
    assert.equal(bob.size, "0");
    assert.equal(bob.realizedPnlCum, (-10_000n * E18).toString());

    const f1 = await one(`SELECT * FROM "Fill" WHERE "fillId" = $1`, [h("fill-1")]);
    assert.equal(f1.status, "SETTLED");
    assert.equal(f1.makerFee, (-3n * E18).toString());
    assert.equal(f1.blockNumber, "3");
    const f2 = await one(`SELECT * FROM "Fill" WHERE "fillId" = $1`, [h("fill-2")]);
    assert.equal(f2.status, "REJECTED");
    assert.equal(f2.rejectReason, "AccountInsolvent");

    const orders = Object.fromEntries(
      (await db.query(`SELECT "orderHash", "status", "filledSize" FROM "Order"`)).map((r) => [r.orderHash, r])
    );
    assert.deepEqual([orders[h("order-alice")].status, orders[h("order-alice")].filledSize], ["FILLED", E18.toString()]);
    assert.equal(orders[h("order-bob")].status, "CANCELLED", "on-chain OrderCancelled");
    assert.equal(orders[h("order-bob")].filledSize, E18.toString());
    assert.equal(orders[h("order-alice-2")].status, "CANCELLED", "nonce 3 < minValidNonce 5");

    const accBob = await one(`SELECT * FROM "Account" WHERE "address" = $1`, [BOB.toLowerCase()]);
    assert.equal(accBob.feeTier, 2);
    const accAlice = await one(`SELECT * FROM "Account" WHERE "address" = $1`, [ALICE.toLowerCase()]);
    assert.equal(accAlice.minValidNonce, "5");

    const pnl = await db.query(`SELECT "address", "kind", "amount" FROM "PnlEvent" ORDER BY "blockNumber", "logIndex", "kind"`);
    assert.deepEqual(
      pnl.map((r) => `${r.address === BOB.toLowerCase() ? "bob" : "alice"}:${r.kind}:${BigInt(r.amount as string) / E18}`),
      ["alice:FEE:-21", "bob:FEE:3", "alice:FUNDING:-2", "bob:LIQUIDATION:-10000", "bob:LIQUIDATION_PENALTY:-50"]
    );

    const transfers = await db.query(`SELECT "kind" FROM "BalanceChange" WHERE "reason" IS NOT NULL ORDER BY "kind"`);
    assert.deepEqual(transfers.map((r) => r.kind), ["TRANSFER_IN", "TRANSFER_OUT"]);

    const op = await one(`SELECT * FROM "GovernanceOperation"`);
    assert.equal(op.status, "EXECUTED");
    assert.equal(op.salt, h("salt"));
    assert.equal((op.calls as unknown[]).length, 2);
    assert.equal((op.readyAt as Date).getTime(), (1_800_000_000 + 2 * 2 + 172_800) * 1000);

    const unknown = await one(`SELECT "eventName", "args" FROM "ProtocolEvent" WHERE "eventName" = 'Unknown'`);
    assert.ok(unknown, "undecodable logs are kept, not skipped");

    for (const [table, count] of [
      ["LiquidationEvent", 1], ["DeleverageEvent", 1], ["BackstopUnwind", 1], ["FeeAccrual", 2], ["FeeClaim", 1],
      ["FeeTierAssignment", 1], ["OracleSnapshot", 1], ["FundingPayment", 1], ["ProtocolEvent", 30],
    ] as const) {
      assert.equal(Number((await one(`SELECT count(*) AS c FROM "${table}"`)).c), count, table);
    }
  });

  test("catching up again is a no-op, and new blocks are picked up incrementally", async () => {
    const chain = new FakeChain();
    scenario(chain);
    const indexer = new Indexer(db, chain, registry, { network: NETWORK, startBlock: 1n });
    const before = await snapshot(db);
    assert.equal(await indexer.catchUp(), 0);
    assert.deepEqual(await snapshot(db), before);

    chain.block("later", [makeLog(feeRouterAbi, CONTRACTS.feeRouter, "FeeTierSet", { account: BOB, tier: 3 })]);
    assert.equal(await indexer.catchUp(), 1);
    const [acc] = await db.query(`SELECT "feeTier" FROM "Account" WHERE "address" = $1`, [BOB.toLowerCase()]);
    assert.equal(acc.feeTier, 3);
  });

  test("rebuild from ProtocolEvent reproduces the live projections exactly", async () => {
    const indexer = new Indexer(db, new FakeChain(), registry, { network: NETWORK, startBlock: 1n });
    const live = await snapshot(db);
    const applied = await indexer.rebuild(4);
    assert.ok(applied > 20);
    assert.deepEqual(await snapshot(db), live);
  });

  test("a crash mid-window leaves nothing behind and the retry matches a clean run", async () => {
    await truncateAll(db);
    await seedMatcherRows(db);
    const chain = new FakeChain();
    scenario(chain);

    const crashing = new Indexer(failingDb(db, 7), chain, registry, { network: NETWORK, startBlock: 1n, maxWindow: 100n });
    await assert.rejects(crashing.catchUp(), /simulated crash/);
    assert.equal(await crashing.cursor(), null);
    assert.equal(Number((await db.query(`SELECT count(*) AS c FROM "ProtocolEvent"`))[0].c), 0);

    await crashing.catchUp();
    const recovered = await snapshot(db);

    await truncateAll(db);
    await seedMatcherRows(db);
    await new Indexer(db, chain, registry, { network: NETWORK, startBlock: 1n, maxWindow: 1n }).catchUp();
    const clean = await snapshot(db);
    // Cursor hashes are identical; only window sizes differed.
    assert.deepEqual(recovered, clean);
  });
});
