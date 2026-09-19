/**
 * Trading for the keeper drills: seed markets, publish an index price, cross
 * two signed orders through the real matcher, and run the real indexer so the
 * database says what the chain says. LOCAL ONLY (it rides on LocalChain).
 *
 * Mirrors scripts/matcher-e2e.ts, which proves the same path end to end; this
 * is the reusable slice the funding, liquidation and end-to-end drills need.
 */

import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";

import { engineAbi, oracleAdapterAbi, riskParamsAbi } from "@/lib/chain/contracts";
import { oracleId } from "@/lib/chain/networks";
import { TxSender } from "@/lib/chain/tx-sender";
import { MemoryTxJobStore, type TxJobStore } from "@/lib/chain/tx-store";
import { pgDb, type Db } from "@/lib/indexer/db";
import { ContractRegistry } from "@/lib/indexer/decode";
import { Indexer, publicClientSource } from "@/lib/indexer/indexer";
import { DERIVED_TABLES } from "@/lib/indexer/projections";
import { hashOrder, orderTypedData, type Order } from "@/lib/market/eip712";
import { Matcher } from "@/lib/matcher/loop";

import { FEES, NETWORK, ROLES, type LocalChain } from "./localchain";

export const E18 = 10n ** 18n;

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const say = (lvl: string) => (e: string, f?: Record<string, unknown>) =>
  process.stdout.write(`    · matcher ${lvl} ${e} ${f ? JSON.stringify(f, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : ""}\n`);
const matcherLog = process.env.KRYON_E2E_VERBOSE ? { info: say("info"), warn: say("warn"), error: say("error") } : silent;

export interface Trading {
  db: Db;
  indexer: Indexer;
  /** Push index prices from the arc-local publisher (minPublishers = 1 there). */
  pushIndex(prices: Record<string, bigint>): Promise<void>;
  /** Maker sells to taker (taker long) or buys from taker, at `price`, for `size`. */
  trade(o: { marketId: number; long: HDAccount; short: HDAccount; size: bigint; price: bigint }): Promise<void>;
  /** Rest one signed order in the book (no match). Returns its hash. */
  place(o: { who: HDAccount; marketId: number; isLong: boolean; size: bigint; price: bigint }): Promise<Hex>;
  /** One matcher tick over `marketId`, then index what it settled. */
  match(marketId: number): Promise<void>;
  index(): Promise<void>;
  position(who: Address, marketId: number): Promise<{ size: bigint; openNotional: bigint }>;
  end(): Promise<void>;
}

export async function startTrading(
  lc: LocalChain,
  dbUrl: string,
  marketIds: number[],
  /** Where the matcher's TxJobs go; Postgres when the reconciler should see them. */
  store: TxJobStore = new MemoryTxJobStore()
): Promise<Trading> {
  const db = pgDb(dbUrl);
  // Start from nothing: every indexer-derived table (the indexer's own list),
  // the event log, and the service tables. Other suites share this database.
  const tables = [...DERIVED_TABLES, "ProtocolEvent", "Fill", "Order", "Account", "Market", "BlockCursor", "KeeperAction", "TxJob", "GasSpend"];
  await db.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} CASCADE`);
  const indexer = new Indexer(db, publicClientSource(lc.client), new ContractRegistry(lc.contracts), {
    network: NETWORK.id,
    startBlock: 0n,
  });
  await indexer.catchUp();

  for (const id of marketIds) {
    const p = await lc.client.readContract({
      address: lc.contracts.riskParams,
      abi: riskParamsAbi,
      functionName: "market",
      args: [id],
    });
    await db.query(
      `INSERT INTO "Market" ("network", "id", "symbol", "oracleId", "active", "params", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT ("network", "id") DO UPDATE SET "params" = EXCLUDED."params", "active" = EXCLUDED."active"`,
      [
        NETWORK.id,
        id,
        `M${id}`,
        (p.oracleId as string).toLowerCase(),
        p.active,
        JSON.stringify({
          oracleId: (p.oracleId as string).toLowerCase(),
          minFillNotional: p.minFillNotional.toString(),
          maxExecutionDeviationBps: p.maxExecutionDeviationBps,
          maxOracleAge: p.maxOracleAge,
          maxOracleConfidenceBps: p.maxOracleConfidenceBps,
        }),
      ]
    );
  }

  const sender = new TxSender({
    network: NETWORK,
    service: "matcher",
    chain: lc.client,
    signer: ROLES.operator,
    store,
    pollMs: 100,
  });
  let nonce = 1n;
  let arrival = 0;

  async function placeOrder(who: HDAccount, marketId: number, isLong: boolean, size: bigint, limitPrice: bigint, createdAt: Date) {
    const order: Order = {
      owner: getAddress(who.address),
      marketId,
      isLong,
      size,
      limitPrice,
      reduceOnly: false,
      nonce: nonce++,
      // OrderGateway.MAX_ORDER_TTL is 7 days; a day ahead of chain time is valid
      // both for the matcher (wall clock) and for drills that warp the chain.
      expiry: BigInt((await lc.now()) + 86_400),
      referrer: zeroAddress,
    };
    const orderHash = hashOrder(NETWORK.chainId, lc.contracts.orderGateway, order);
    const signature = await who.signTypedData(orderTypedData(NETWORK.chainId, lc.contracts.orderGateway, order));
    await db.query(
      `INSERT INTO "Account" ("network", "address", "updatedAt") VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
      [NETWORK.id, order.owner.toLowerCase()]
    );
    await db.query(
      `INSERT INTO "Order" ("orderHash", "network", "owner", "marketId", "isLong", "size", "limitPrice",
                            "reduceOnly", "nonce", "expiry", "referrer", "signature", "status",
                            "filledSize", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, $11, 'OPEN', 0, $12, now())`,
      [
        orderHash.toLowerCase(),
        NETWORK.id,
        order.owner.toLowerCase(),
        marketId,
        isLong,
        size.toString(),
        limitPrice.toString(),
        order.nonce.toString(),
        order.expiry.toString(),
        zeroAddress,
        signature.toLowerCase(),
        createdAt,
      ]
    );
    return orderHash.toLowerCase() as Hex;
  }

  const t: Trading = {
    db,
    indexer,
    async pushIndex(prices) {
      await lc.warp(2);
      const publishTime = BigInt(await lc.now());
      const syms = Object.keys(prices);
      const hash = await lc.wallet(ROLES.publisher).writeContract({
        address: lc.contracts.oracleAdapter,
        abi: oracleAdapterAbi,
        functionName: "pushPrices",
        args: [syms.map((s) => oracleId(s)), syms.map((s) => prices[s]), syms.map(() => 0n), publishTime],
        chain: lc.chain,
        account: ROLES.publisher,
        ...FEES,
      });
      const r = await lc.client.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("pushPrices reverted");
    },
    async trade(o) {
      const base = Date.now() - 3_600_000;
      const makerAt = new Date(base + arrival++ * 1000);
      const takerAt = new Date(base + 1_800_000 + arrival++ * 1000);
      // The short rests first (maker), the long crosses it (taker).
      await placeOrder(o.short, o.marketId, false, o.size, o.price, makerAt);
      await placeOrder(o.long, o.marketId, true, o.size, o.price, takerAt);
      const matcher = new Matcher({
        db,
        network: NETWORK,
        contracts: lc.contracts,
        chain: lc.client,
        sender,
        marketIds: [o.marketId],
        log: matcherLog,
        pollMs: 100,
      });
      await matcher.tick();
      const [l, s] = await Promise.all([t.position(o.long.address, o.marketId), t.position(o.short.address, o.marketId)]);
      if (l.size <= 0n || s.size >= 0n) throw new Error(`trade did not settle (long ${l.size}, short ${s.size})`);
      await t.index();
    },
    async place(o) {
      return placeOrder(o.who, o.marketId, o.isLong, o.size, o.price, new Date());
    },
    async match(marketId) {
      const matcher = new Matcher({
        db,
        network: NETWORK,
        contracts: lc.contracts,
        chain: lc.client,
        sender,
        marketIds: [marketId],
        log: matcherLog,
        pollMs: 100,
      });
      await matcher.tick();
      await t.index();
    },
    async index() {
      await indexer.catchUp();
    },
    async position(who, marketId) {
      const p = (await lc.client.readContract({
        address: lc.contracts.engine,
        abi: engineAbi,
        functionName: "getPosition",
        args: [who, marketId],
      })) as { size: bigint; openNotional: bigint };
      return { size: p.size, openNotional: p.openNotional };
    },
    async end() {
      await db.end();
    },
  };
  return t;
}
