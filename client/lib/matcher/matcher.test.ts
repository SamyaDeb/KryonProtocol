// The matcher against a real Postgres and a scripted chain (plan §4.3).
//
// Needs KRYON_MATCHER_TEST_DATABASE_URL, or KRYON_TEST_DATABASE_URL, pointing
// at a migrated, DISPOSABLE database: the suite truncates the trading tables.
// It shares them with the indexer suite, so both take the same advisory lock
// and run one at a time.
//
// Run: KRYON_TEST_DATABASE_URL=postgresql://localhost:5432/kryon_matcher_test npm test
//
// The chain is a fake: it accepts raw transactions, decides what each fill in
// a batch does, and produces a receipt whose logs say so. That is the only
// thing the matcher may learn a batch's outcome from, so a fake that speaks in
// logs exercises the real path.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseGwei,
  parseTransaction,
  toHex,
  zeroAddress,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { ALL_ERRORS_ABI, orderGatewayAbi } from "@/lib/chain/contracts";
import { ARC_NETWORKS, oracleId, type ProtocolContracts } from "@/lib/chain/networks";
import { TxSender, type TxChain, type TxClock } from "@/lib/chain/tx-sender";
import { MemoryTxJobStore } from "@/lib/chain/tx-store";
import { hashOrder, orderTypedData, type Order } from "@/lib/market/eip712";
import { PRECISION } from "@/lib/market/matching-engine";
import { deriveFillId } from "./batch";
import { loadBook, loadOrders } from "./book";
import { pgDb, type Db } from "./db";
import { Matcher, type Logger, type MatcherClock } from "./loop";
import { persistPendingFills, releasePendingFills } from "./submit";

const url = process.env.KRYON_MATCHER_TEST_DATABASE_URL ?? process.env.KRYON_TEST_DATABASE_URL;

const NETWORK = ARC_NETWORKS["arc-local"];
const NET = NETWORK.id;
const E18 = PRECISION;
const MARKET_ID = 2;
const SYMBOL = "BTC-PERP";
const MIN_FILL_NOTIONAL = 40n * E18;
const MAX_DEVIATION_BPS = 75;
const INDEX_PRICE = 100_000n * E18;

/** The trading tables this suite owns; shared with the indexer suite. */
const TABLES = ["Fill", "Order", "Position", "Account", "Market"];
/**
 * The indexer suite truncates the same tables, and the runner starts test
 * files in parallel. Both take this lock, so neither wipes the other's rows
 * halfway through a test. Keep the value in step with `indexer.test.ts`.
 */
const ADVISORY_LOCK = "8150412001";

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

function addr(n: number): Address {
  return getAddress(`0x${n.toString(16).padStart(40, "0")}`);
}

const ALICE = privateKeyToAccount(`0x${"11".repeat(32)}`);
const BOB = privateKeyToAccount(`0x${"22".repeat(32)}`);
const CAROL = privateKeyToAccount(`0x${"33".repeat(32)}`);
const OPERATOR = privateKeyToAccount(`0x${"44".repeat(32)}`);

// ── Scripted chain ───────────────────────────────────────────────────────────

type FillOutcome = { kind: "settled" } | { kind: "rejected"; error: string };

class NotFound extends Error {
  name = "TransactionReceiptNotFoundError";
}

/**
 * A chain that mines every transaction on the next poll.
 *
 * `outcomes` decides what happens to each fill id; anything unlisted settles.
 * `revertWith` makes the whole batch revert instead, which is how
 * `InsufficientBatchGas` is scripted. `gasPerFill` drives both the estimate
 * and the receipt's `gasUsed`.
 */
class FakeChain {
  baseFee = parseGwei("20");
  minedNonce = 0;
  gasPerFill = 380_000n;
  outcomes = new Map<string, FillOutcome>();
  /** What a fill id with no entry above gets. A retry derives a NEW fill id,
   *  so a test about repeated rejections has to say so here. */
  defaultOutcome: FillOutcome = { kind: "settled" };
  revertWith: string | null = null;
  /** Fill counts of every batch it was asked to settle, in order. */
  submittedBatchSizes: number[] = [];
  /** Fill ids that actually settled, across every batch. */
  settledFillIds: Hex[] = [];
  /** `filled(owner, nonce)` as the gateway would report it. */
  filledByNonce = new Map<string, bigint>();
  indexPrice: bigint | null = INDEX_PRICE;

  private readonly pending = new Map<Hex, { nonce: number; fills: readonly Hex[]; gas: bigint }>();
  private readonly receipts = new Map<Hex, TransactionReceipt>();

  // — TxChain —

  async getTransactionCount({ blockTag }: { blockTag?: string }) {
    return blockTag === "pending" ? this.minedNonce + this.pending.size : this.minedNonce;
  }

  async getBlock() {
    return { baseFeePerGas: this.baseFee } as never;
  }

  async estimateGas({ data }: { data?: Hex }) {
    return BigInt(this.fillIdsIn(data!).length) * this.gasPerFill;
  }

  async sendRawTransaction({ serializedTransaction }: { serializedTransaction: Hex }) {
    const tx = parseTransaction(serializedTransaction);
    const hash = keccak256(serializedTransaction);
    const fills = this.fillIdsIn(tx.data!);
    this.submittedBatchSizes.push(fills.length);
    this.pending.set(hash, { nonce: tx.nonce!, fills, gas: tx.gas ?? 0n });
    return hash;
  }

  async getTransaction({ hash }: { hash: Hex }) {
    if (!this.pending.has(hash) && !this.receipts.has(hash)) throw new NotFound("not found");
    return {} as never;
  }

  async getTransactionReceipt({ hash }: { hash: Hex }) {
    this.mine();
    const receipt = this.receipts.get(hash);
    if (!receipt) throw new NotFound("not found");
    return receipt;
  }

  // — MatcherChain —

  async readContract({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
    if (functionName === "getPrice") {
      if (this.indexPrice === null) throw new Error("execution reverted: StalePrice");
      return {
        price: this.indexPrice,
        confidence: 0n,
        publishTime: 1_800_000_000n,
        writeTime: 1_800_000_000n,
        source: 1,
        sourceCount: 3,
      } as never;
    }
    if (functionName === "filled") {
      const [owner, nonce] = args as [Address, bigint];
      return (this.filledByNonce.get(`${owner.toLowerCase()}:${nonce}`) ?? 0n) as never;
    }
    throw new Error(`unexpected readContract ${functionName}`);
  }

  /** Replays a reverted batch so `revertReasonFor` can recover the reason. */
  async call() {
    if (this.revertWith) {
      const error = new Error("execution reverted");
      (error as { data?: Hex }).data = encodeErrorResult({
        abi: ALL_ERRORS_ABI,
        errorName: this.revertWith,
      });
      throw error;
    }
    return { data: "0x" as Hex };
  }

  // — mining —

  private mine() {
    for (const [hash, tx] of this.pending) {
      if (tx.nonce !== this.minedNonce) continue;
      this.pending.delete(hash);
      this.minedNonce += 1;
      this.receipts.set(hash, this.receiptFor(hash, tx.fills));
    }
  }

  private receiptFor(hash: Hex, fills: readonly Hex[]): TransactionReceipt {
    if (this.revertWith) {
      return {
        transactionHash: hash,
        status: "reverted",
        gasUsed: BigInt(fills.length) * this.gasPerFill,
        blockNumber: BigInt(1_000 + this.minedNonce),
        effectiveGasPrice: this.baseFee,
        logs: [],
      } as unknown as TransactionReceipt;
    }
    const logs = fills.map((fillId, i) => {
      const outcome = this.outcomes.get(fillId.toLowerCase()) ?? this.defaultOutcome;
      if (outcome.kind === "settled") this.settledFillIds.push(fillId);
      return outcome.kind === "settled" ? settledLog(fillId, i) : rejectedLog(fillId, outcome.error, i);
    });
    return {
      transactionHash: hash,
      status: "success",
      gasUsed: BigInt(fills.length) * this.gasPerFill,
      blockNumber: BigInt(1_000 + this.minedNonce),
      effectiveGasPrice: this.baseFee,
      logs,
    } as unknown as TransactionReceipt;
  }

  /** The fill ids inside a `settleFillsSigned` calldata blob. */
  private fillIdsIn(data: Hex): Hex[] {
    // Decode the batch the way the gateway would. Scanning for ids this run
    // had issued up front looked equivalent, but a retry derives a NEW fill id
    // (the sequence breaks the tie against the earlier row), so the batch came
    // back empty and the retry was neither settled nor rejected but silently
    // unaccounted — which hid the retry storm this suite now tests for.
    const { args } = decodeFunctionData({ abi: orderGatewayAbi, data });
    const fills = (args?.[0] ?? []) as readonly { fillId: Hex }[];
    return fills.map((f) => f.fillId);
  }
}

/** Every fill id the fixtures expect to appear on the wire, in issue order. */
const issuedFillIds: Hex[] = [];

const event = (name: string) => orderGatewayAbi.find((i) => i.type === "event" && i.name === name) as AbiEvent;

function settledLog(fillId: Hex, logIndex: number) {
  const abi = [event("FillSettled")] as Abi;
  const topics = encodeEventTopics({
    abi,
    eventName: "FillSettled",
    args: { fillId, makerOrderHash: keccak256(toHex("m")), takerOrderHash: keccak256(toHex("t")) },
  });
  return {
    address: CONTRACTS.orderGateway,
    topics,
    data: encodeAbiParameters(
      [
        { type: "uint32" },
        { type: "address" },
        { type: "address" },
        { type: "bool" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "int256" },
        { type: "int256" },
        { type: "uint8" },
        { type: "uint8" },
      ],
      [MARKET_ID, ALICE.address, BOB.address, true, E18, INDEX_PRICE, 0n, 0n, 0, 0]
    ),
    logIndex,
    blockNumber: 1_000n,
    transactionHash: keccak256(toHex("tx")),
  };
}

function rejectedLog(fillId: Hex, errorName: string, logIndex: number) {
  const abi = [event("FillRejected")] as Abi;
  return {
    address: CONTRACTS.orderGateway,
    topics: encodeEventTopics({ abi, eventName: "FillRejected", args: { fillId } }),
    data: encodeAbiParameters(
      [{ type: "bytes" }],
      [encodeErrorResult({ abi: ALL_ERRORS_ABI, errorName })]
    ),
    logIndex,
    blockNumber: 1_000n,
    transactionHash: keccak256(toHex("tx")),
  };
}

// ── Clocks ───────────────────────────────────────────────────────────────────

/** Anchored to real time: seeded rows get Postgres `now()`, and recovery's
 *  grace period compares the two. */
const NOW_MS = Date.now();
const NOW_SEC = BigInt(Math.floor(NOW_MS / 1000));

class FakeClock implements TxClock, MatcherClock {
  t = NOW_MS;
  now() {
    return this.t;
  }
  nowMs() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
  }
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

// ── Fixtures ─────────────────────────────────────────────────────────────────

let db: Db;
let lockPool: Pool;

function makeOrder(
  account: PrivateKeyAccount,
  isLong: boolean,
  size: bigint,
  limitPrice: bigint,
  nonce: bigint,
  reduceOnly = false
): Order {
  return {
    owner: account.address,
    marketId: MARKET_ID,
    isLong,
    size,
    limitPrice,
    reduceOnly,
    nonce,
    expiry: NOW_SEC + 3_600n,
    referrer: zeroAddress,
  };
}

async function seedOrder(
  account: PrivateKeyAccount,
  order: Order,
  opts: { createdAt?: Date; signature?: Hex; status?: string } = {}
): Promise<Hex> {
  const orderHash = hashOrder(NETWORK.chainId, CONTRACTS.orderGateway, order);
  const signature =
    opts.signature ?? (await account.signTypedData(orderTypedData(NETWORK.chainId, CONTRACTS.orderGateway, order)));
  await db.query(
    `INSERT INTO "Account" ("network", "address", "updatedAt") VALUES ($1, $2, now())
     ON CONFLICT DO NOTHING`,
    [NET, account.address.toLowerCase()]
  );
  await db.query(
    `INSERT INTO "Order" ("orderHash", "network", "owner", "marketId", "isLong", "size", "limitPrice",
                          "reduceOnly", "nonce", "expiry", "referrer", "signature", "status",
                          "filledSize", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::"OrderStatus", 0, $14, now())`,
    [
      orderHash.toLowerCase(),
      NET,
      order.owner.toLowerCase(),
      order.marketId,
      order.isLong,
      order.size.toString(),
      order.limitPrice.toString(),
      order.reduceOnly,
      order.nonce.toString(),
      order.expiry.toString(),
      zeroAddress,
      signature.toLowerCase(),
      opts.status ?? "OPEN",
      opts.createdAt ?? new Date(NOW_MS - 300_000),
    ]
  );
  return orderHash.toLowerCase() as Hex;
}

async function seedMarket(params: Partial<Record<string, unknown>> = {}) {
  await db.query(
    `INSERT INTO "Market" ("network", "id", "symbol", "oracleId", "active", "params", "updatedAt")
     VALUES ($1, $2, $3, $4, true, $5, now())
     ON CONFLICT ("network", "id") DO UPDATE SET "params" = EXCLUDED."params", "active" = true`,
    [
      NET,
      MARKET_ID,
      SYMBOL,
      oracleId("BTC").toLowerCase(),
      JSON.stringify({
        oracleId: oracleId("BTC").toLowerCase(),
        minFillNotional: MIN_FILL_NOTIONAL.toString(),
        maxExecutionDeviationBps: MAX_DEVIATION_BPS,
        maxOracleAge: 15,
        maxOracleConfidenceBps: 100,
        ...params,
      }),
    ]
  );
}

async function fills(): Promise<Record<string, unknown>[]> {
  return db.query(
    `SELECT "fillId", "status", "rejectReason", "txJobId", "size"::text AS size, "price"::text AS price
     FROM "Fill" WHERE "network" = $1 ORDER BY "id"`,
    [NET]
  );
}

async function orderRow(orderHash: Hex) {
  const rows = await db.query(
    `SELECT "status", "filledSize"::text AS "filledSize" FROM "Order" WHERE "orderHash" = $1`,
    [orderHash.toLowerCase()]
  );
  return rows[0];
}

function newMatcher(chain: FakeChain, clock: FakeClock, overrides: Record<string, unknown> = {}) {
  const sender = new TxSender({
    network: NETWORK,
    service: "matcher",
    chain: chain as unknown as TxChain,
    signer: OPERATOR,
    store: new MemoryTxJobStore(),
    clock,
    pollMs: 1,
    waitTimeoutMs: 60_000,
  });
  const matcher = new Matcher({
    db,
    network: NETWORK,
    contracts: CONTRACTS,
    chain: chain as never,
    sender,
    marketIds: [MARKET_ID],
    log: silent,
    clock,
    pollMs: 1,
    // These owners are EOAs with no code, which is what the gateway's
    // ERC-1271 fallback answers "not valid" for. No network in this suite.
    erc1271: async () => false,
    ...overrides,
  });
  return { matcher, sender };
}

/**
 * A crossing pair: Alice rests an ask, Bob crosses it later.
 *
 * Every ask arrives before every bid, and each pair is one second apart, so
 * price-time priority pairs ask_i with bid_i and the fill ids below are the
 * ones that reach the wire.
 */
let crossSeq = 0;
async function seedCross(size = E18, price = INDEX_PRICE, makerNonce = 1n, takerNonce = 2n) {
  const i = crossSeq++;
  const ask = makeOrder(ALICE, false, size, price, makerNonce);
  const bid = makeOrder(BOB, true, size, price, takerNonce);
  const askHash = await seedOrder(ALICE, ask, { createdAt: new Date(NOW_MS - 600_000 + i * 1_000) });
  const bidHash = await seedOrder(BOB, bid, { createdAt: new Date(NOW_MS - 300_000 + i * 1_000) });
  const fillId = deriveFillId(askHash, bidHash, size, price, 0n);
  issuedFillIds.push(fillId);
  return { ask, bid, askHash, bidHash, fillId };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("matcher against Postgres", { skip: !url, concurrency: 1 }, () => {
  before(async () => {
    db = pgDb(url!);
    lockPool = new Pool({ connectionString: url!, max: 1 });
    await lockPool.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK]);
  });

  after(async () => {
    await lockPool.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK]);
    await lockPool.end();
    await db.end();
  });

  beforeEach(async () => {
    issuedFillIds.length = 0;
    crossSeq = 0;
    await db.query(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
    await seedMarket();
  });

  describe("one tick", () => {
    test("a crossing pair settles and the matcher writes only the pending fill", async () => {
      const { fillId, askHash, bidHash } = await seedCross();
      const chain = new FakeChain();
      const clock = new FakeClock();
      const { matcher } = newMatcher(chain, clock);

      await matcher.tick();

      const rows = await fills();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].fillId, fillId.toLowerCase());
      assert.equal(rows[0].status, "PENDING", "only the indexer may write SETTLED");
      assert.equal(rows[0].rejectReason, null);
      assert.ok(rows[0].txJobId, "the fill is linked to the job that carried it");
      assert.equal(rows[0].size, E18.toString());

      // The matcher does not touch filledSize: that is the indexer's column.
      assert.equal((await orderRow(askHash)).filledSize, "0");
      assert.equal((await orderRow(bidHash)).status, "OPEN");
      assert.deepEqual(chain.settledFillIds, [fillId]);
      assert.equal(matcher.metrics.fillsSettled, 1);
    });

    test("the same tick run twice does not reserve the size twice", async () => {
      await seedCross(2n * E18);
      const chain = new FakeChain();
      const clock = new FakeClock();
      const { matcher } = newMatcher(chain, clock);

      await matcher.tick();
      await matcher.tick();

      assert.equal((await fills()).length, 1, "the second tick sees the reservation and matches nothing");
      assert.equal(chain.submittedBatchSizes.length, 1);
    });

    test("a pending fill reserves the size, so a partial fill's remainder is what is left", async () => {
      // Alice 5, Bob 2 → a 2 fill, leaving 3 of Alice's ask available.
      const ask = makeOrder(ALICE, false, 5n * E18, INDEX_PRICE, 1n);
      const askHash = await seedOrder(ALICE, ask, { createdAt: new Date(NOW_MS - 500_000) });
      const bid = makeOrder(BOB, true, 2n * E18, INDEX_PRICE, 2n);
      const bidHash = await seedOrder(BOB, bid, { createdAt: new Date(NOW_MS - 300_000) });
      issuedFillIds.push(deriveFillId(askHash, bidHash, 2n * E18, INDEX_PRICE, 0n));

      const chain = new FakeChain();
      const { matcher } = newMatcher(chain, new FakeClock());
      await matcher.tick();

      const book = await loadOrders(db, NET, MARKET_ID, NOW_SEC);
      const alice = book.find((o) => o.orderHash === askHash)!;
      const bob = book.find((o) => o.orderHash === bidHash)!;
      assert.equal(alice.size - alice.filledSize, 3n * E18, "3 of Alice's 5 is still matchable");
      assert.equal(bob.size - bob.filledSize, 0n, "Bob is fully reserved");
    });

    test("a stale oracle skips the market instead of building a doomed batch", async () => {
      await seedCross();
      const chain = new FakeChain();
      chain.indexPrice = null;
      const { matcher } = newMatcher(chain, new FakeClock());

      await matcher.tick();

      assert.deepEqual(await fills(), []);
      assert.equal(chain.submittedBatchSizes.length, 0);
      assert.equal(matcher.metrics.oracleSkips, 1);
    });

    test("a pair crossing outside the band does not trade", async () => {
      // 5% above the index, far outside the 75 bps band.
      await seedCross(E18, (INDEX_PRICE * 105n) / 100n);
      const chain = new FakeChain();
      const { matcher } = newMatcher(chain, new FakeClock());

      await matcher.tick();

      assert.deepEqual(await fills(), []);
      assert.equal(chain.submittedBatchSizes.length, 0);
    });

    test("an out-of-band quote does not starve the orders behind it", async () => {
      // Carol's ask is the best price but unsettleable; Alice's is in band.
      const bad = makeOrder(CAROL, false, E18, (INDEX_PRICE * 90n) / 100n, 1n);
      const badHash = await seedOrder(CAROL, bad, { createdAt: new Date(NOW_MS - 600_000) });
      const good = makeOrder(ALICE, false, E18, INDEX_PRICE, 2n);
      const goodHash = await seedOrder(ALICE, good, { createdAt: new Date(NOW_MS - 500_000) });
      const bid = makeOrder(BOB, true, E18, INDEX_PRICE, 3n);
      const bidHash = await seedOrder(BOB, bid, { createdAt: new Date(NOW_MS - 300_000) });
      issuedFillIds.push(deriveFillId(goodHash, bidHash, E18, INDEX_PRICE, 0n));

      const chain = new FakeChain();
      const { matcher } = newMatcher(chain, new FakeClock());
      await matcher.tick();

      const rows = await fills();
      assert.equal(rows.length, 1, "Bob trades with Alice rather than being blocked by Carol");
      assert.equal(rows[0].price, INDEX_PRICE.toString());
      assert.ok(!(await fills()).some((r) => r.fillId === badHash), "Carol's quote is untouched");
    });
  });

  describe("rejections", () => {
    test("a rejected fill records its reason and frees the size again", async () => {
      const { fillId, askHash } = await seedCross();
      const chain = new FakeChain();
      chain.outcomes.set(fillId.toLowerCase(), { kind: "rejected", error: "InsufficientCollateral" });
      const { matcher } = newMatcher(chain, new FakeClock());

      await matcher.tick();

      const [row] = await fills();
      assert.equal(row.status, "PENDING", "only the indexer may write REJECTED");
      assert.equal(row.rejectReason, "InsufficientCollateral");

      // The reason releases the reservation, so the order is matchable again.
      const book = await loadOrders(db, NET, MARKET_ID, NOW_SEC);
      const alice = book.find((o) => o.orderHash === askHash)!;
      assert.equal(alice.filledSize, 0n);
      assert.equal(matcher.metrics.fillsRejected, 1);
    });

    test("a refused pair is not re-offered on the next tick, and gas is not burned again", async () => {
      // The storm this prevents: the reason is retryable, so the size goes
      // back on the book and the same pair matches again immediately. On the
      // live testnet venue that cost 52 rejected batches in minutes.
      await seedCross();
      const chain = new FakeChain();
      chain.defaultOutcome = { kind: "rejected", error: "InsufficientCollateral" };
      const clock = new FakeClock();
      const { matcher } = newMatcher(chain, clock);

      await matcher.tick();
      assert.equal(chain.submittedBatchSizes.length, 1, "offered once");

      for (let i = 0; i < 5; i++) await matcher.tick();
      assert.equal(chain.submittedBatchSizes.length, 1, "and not again while it waits");
      assert.equal(matcher.metrics.ordersCoolingDown, 2, "both sides of the fill are held");

      // The wait is a wait, not a ban: past it the matcher tries once more.
      clock.t += 2_500;
      await matcher.tick();
      assert.equal(chain.submittedBatchSizes.length, 2, "one retry, not a stream");
    });

    test("an order that keeps being refused is parked", async () => {
      await seedCross();
      const chain = new FakeChain();
      chain.defaultOutcome = { kind: "rejected", error: "InsufficientCollateral" };
      const clock = new FakeClock();
      const { matcher } = newMatcher(chain, clock, { cooldown: { baseMs: 1_000, maxMs: 4_000, parkAfter: 3 } });

      for (let i = 0; i < 3; i++) {
        await matcher.tick();
        clock.t += 5_000; // past whatever it is waiting
      }
      assert.equal(chain.submittedBatchSizes.length, 3, "three attempts, spaced out");
      assert.equal(matcher.metrics.ordersParked, 2, "both sides parked after the third");
    });

    test("a fill that settles clears the strikes its orders were carrying", async () => {
      await seedCross();
      const chain = new FakeChain();
      chain.defaultOutcome = { kind: "rejected", error: "InsufficientCollateral" };
      const clock = new FakeClock();
      const { matcher } = newMatcher(chain, clock);

      await matcher.tick();
      chain.defaultOutcome = { kind: "settled" }; // the account was funded
      clock.t += 2_500;
      await matcher.tick();
      assert.equal(matcher.metrics.fillsSettled, 1);
      assert.equal(matcher.metrics.ordersCoolingDown, 0, "nothing held once it trades");
    });

    test("a bad signature retires the order it can blame, and only that one", async () => {
      const ask = makeOrder(ALICE, false, E18, INDEX_PRICE, 1n);
      const askHash = await seedOrder(ALICE, ask, {
        createdAt: new Date(NOW_MS - 500_000),
        signature: `0x${"ab".repeat(65)}`,
      });
      const bid = makeOrder(BOB, true, E18, INDEX_PRICE, 2n);
      const bidHash = await seedOrder(BOB, bid, { createdAt: new Date(NOW_MS - 300_000) });
      const fillId = deriveFillId(askHash, bidHash, E18, INDEX_PRICE, 0n);
      issuedFillIds.push(fillId);

      const chain = new FakeChain();
      chain.outcomes.set(fillId.toLowerCase(), { kind: "rejected", error: "InvalidSignature" });
      const { matcher } = newMatcher(chain, new FakeClock());
      await matcher.tick();

      assert.equal((await orderRow(askHash)).status, "CANCELLED");
      assert.equal((await orderRow(bidHash)).status, "OPEN", "Bob's valid order must survive");
    });

    test("a contract wallet's order survives when the other side's signature is the bad one", async () => {
      // The Insurance backstop's unwind orders are ERC-1271: a blob signature
      // that never recovers to the owner. Recovery alone used to convict it
      // whenever the counterparty was at fault, retiring a valid order.
      const ask = makeOrder(ALICE, false, E18, INDEX_PRICE, 1n);
      const askHash = await seedOrder(ALICE, ask, {
        createdAt: new Date(NOW_MS - 500_000),
        signature: `0x${"cd".repeat(200)}`,
      });
      const bid = makeOrder(BOB, true, E18, INDEX_PRICE, 2n);
      const bidHash = await seedOrder(BOB, bid, {
        createdAt: new Date(NOW_MS - 300_000),
        signature: `0x${"ab".repeat(65)}`,
      });
      const fillId = deriveFillId(askHash, bidHash, E18, INDEX_PRICE, 0n);
      issuedFillIds.push(fillId);

      const chain = new FakeChain();
      chain.outcomes.set(fillId.toLowerCase(), { kind: "rejected", error: "InvalidSignature" });
      const { matcher } = newMatcher(chain, new FakeClock(), {
        // Alice's owner validates its own signature; Bob's does not.
        erc1271: async (owner: string) => owner.toLowerCase() === ALICE.address.toLowerCase(),
      });
      await matcher.tick();

      assert.equal((await orderRow(askHash)).status, "OPEN", "the ERC-1271 order the owner accepts must survive");
      assert.equal((await orderRow(bidHash)).status, "CANCELLED");
    });

    test("a poison order does not come back on the next tick", async () => {
      const ask = makeOrder(ALICE, false, E18, INDEX_PRICE, 1n);
      const askHash = await seedOrder(ALICE, ask, {
        createdAt: new Date(NOW_MS - 500_000),
        signature: `0x${"ab".repeat(65)}`,
      });
      const bid = makeOrder(BOB, true, E18, INDEX_PRICE, 2n);
      const bidHash = await seedOrder(BOB, bid, { createdAt: new Date(NOW_MS - 300_000) });
      issuedFillIds.push(deriveFillId(askHash, bidHash, E18, INDEX_PRICE, 0n));

      const chain = new FakeChain();
      chain.outcomes.set(issuedFillIds[0].toLowerCase(), { kind: "rejected", error: "InvalidSignature" });
      const { matcher } = newMatcher(chain, new FakeClock());

      await matcher.tick();
      await matcher.tick();

      assert.equal(chain.submittedBatchSizes.length, 1, "the cancelled order is not re-matched");
    });

    test("good and rejected fills in one batch are settled independently", async () => {
      const good = await seedCross(E18, INDEX_PRICE, 1n, 2n);
      const bad = await seedCross(E18, INDEX_PRICE, 3n, 4n);
      const chain = new FakeChain();
      chain.outcomes.set(bad.fillId.toLowerCase(), { kind: "rejected", error: "InsufficientCollateral" });
      const { matcher } = newMatcher(chain, new FakeClock());

      await matcher.tick();

      assert.equal(chain.submittedBatchSizes[0], 2, "both fills went in one batch");
      assert.deepEqual(chain.settledFillIds, [good.fillId]);
      const rows = await fills();
      assert.equal(rows.find((r) => r.fillId === good.fillId.toLowerCase())!.rejectReason, null);
      assert.equal(
        rows.find((r) => r.fillId === bad.fillId.toLowerCase())!.rejectReason,
        "InsufficientCollateral"
      );
    });
  });

  describe("InsufficientBatchGas", () => {
    test("a batch that reverts for gas is halved, retried, and the size that worked is recorded", async () => {
      for (let i = 0; i < 4; i++) await seedCross(E18, INDEX_PRICE, BigInt(i * 2 + 1), BigInt(i * 2 + 2));

      const chain = new FakeChain();
      chain.revertWith = "InsufficientBatchGas";
      const { matcher } = newMatcher(chain, new FakeClock(), { minBatchFills: 2 });

      // Revert the first batch, then let the halves through.
      const original = chain.sendRawTransaction.bind(chain);
      let sends = 0;
      chain.sendRawTransaction = async (args) => {
        sends += 1;
        if (sends === 2) chain.revertWith = null;
        return original(args);
      };

      await matcher.tick();

      assert.equal(chain.submittedBatchSizes[0], 4, "the first attempt was the whole batch");
      assert.deepEqual(chain.submittedBatchSizes.slice(1), [2, 2], "then two halves");
      assert.equal(matcher.metrics.gasResizes, 1);
      assert.equal(matcher.metrics.batchReverts, 1);
      assert.equal(matcher.metrics.maxSettledBatchFills, 2, "the size that worked");
      assert.equal((await fills()).length, 4);
    });

    test("a reverted batch releases its reservation before retrying", async () => {
      const { askHash } = await seedCross();
      const chain = new FakeChain();
      chain.revertWith = "InsufficientBatchGas";
      const { matcher } = newMatcher(chain, new FakeClock());

      await matcher.tick();

      // One fill cannot be halved, so it gives up — and leaves nothing reserved.
      assert.deepEqual(await fills(), [], "the reservation went back");
      const book = await loadOrders(db, NET, MARKET_ID, NOW_SEC);
      assert.equal(book.find((o) => o.orderHash === askHash)!.filledSize, 0n);
    });

    test("an unknown revert does not trigger a resize loop", async () => {
      for (let i = 0; i < 4; i++) await seedCross(E18, INDEX_PRICE, BigInt(i * 2 + 1), BigInt(i * 2 + 2));
      const chain = new FakeChain();
      chain.revertWith = "Paused";
      const { matcher } = newMatcher(chain, new FakeClock(), { minBatchFills: 2 });

      await matcher.tick();

      assert.equal(chain.submittedBatchSizes.length, 1, "one attempt, no halving");
      assert.equal(matcher.metrics.gasResizes, 0);
      assert.deepEqual(await fills(), []);
    });
  });

  describe("batching", () => {
    test("more than 40 matches are split at the cap", async () => {
      for (let i = 0; i < 45; i++) await seedCross(E18, INDEX_PRICE, BigInt(i * 2 + 1), BigInt(i * 2 + 2));
      const chain = new FakeChain();
      const { matcher } = newMatcher(chain, new FakeClock());

      await matcher.tick();

      assert.deepEqual(chain.submittedBatchSizes, [40, 5]);
      assert.equal((await fills()).length, 45);
    });
  });

  describe("crash recovery", () => {
    test("fills reserved but never broadcast are released when the chain never saw them", async () => {
      // The crash window: persistPendingFills committed, the broadcast never
      // happened. `filled(owner, nonce)` is 0, so the batch cannot have landed.
      const { fillId, askHash, ask, askHash: _ } = await seedCross();
      void _;
      const planned = await plannedFrom(fillId, askHash);
      await persistPendingFills(db, NET, [planned]);
      assert.equal((await fills()).length, 1);

      const chain = new FakeChain();
      const clock = new FakeClock();
      clock.t += 120_000; // past the orphan grace period
      const { matcher } = newMatcher(chain, clock);
      await matcher.recover();

      assert.deepEqual(await fills(), [], "the reservation was released");
      const book = await loadOrders(db, NET, MARKET_ID, NOW_SEC);
      assert.equal(book.find((o) => o.orderHash === askHash)!.filledSize, 0n);
      void ask;
    });

    test("fills the chain did see are kept for the indexer, not released", async () => {
      const { fillId, askHash, ask } = await seedCross();
      const planned = await plannedFrom(fillId, askHash);
      await persistPendingFills(db, NET, [planned]);

      const chain = new FakeChain();
      // The gateway says this order is filled: the batch landed after all.
      chain.filledByNonce.set(`${ALICE.address.toLowerCase()}:${ask.nonce}`, E18);
      const clock = new FakeClock();
      clock.t += 120_000;
      const { matcher } = newMatcher(chain, clock);
      await matcher.recover();

      assert.equal((await fills()).length, 1, "a possibly-settled fill is never released");
    });

    test("a fill inside the grace period is left alone", async () => {
      const { fillId, askHash } = await seedCross();
      await persistPendingFills(db, NET, [await plannedFrom(fillId, askHash)]);

      const chain = new FakeChain();
      const { matcher } = newMatcher(chain, new FakeClock());
      await matcher.recover();

      assert.equal((await fills()).length, 1, "too recent to judge");
    });

    test("fills linked to a dropped job are reconciled, not stranded", async () => {
      // A batch that was broadcast and then lost its transaction. `openJobs`
      // will never return the job again, so without this the fill would hold
      // its size reserved for as long as the row lives.
      const { fillId, askHash } = await seedCross();
      await persistPendingFills(db, NET, [await plannedFrom(fillId, askHash)]);
      const jobId = "00000000-0000-4000-8000-00000000dead";
      await db.query(
        `INSERT INTO "TxJob" ("id", "network", "service", "label", "fromAddress", "toAddress", "nonce",
                              "data", "value", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "rawTx",
                              "submittedHash", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, 'matcher', 'settleFillsSigned:BTC-PERP', $3, $4, 0, '0x', 0, 21000, 40000000000,
                 1000000000, '0x', $5, 'DROPPED', now(), now())`,
        [
          jobId,
          NET,
          OPERATOR.address.toLowerCase(),
          CONTRACTS.orderGateway.toLowerCase(),
          `0x${"12".repeat(32)}`,
        ]
      );
      await db.query(`UPDATE "Fill" SET "txJobId" = $2 WHERE "network" = $1`, [NET, jobId]);

      const chain = new FakeChain();
      const clock = new FakeClock();
      clock.t += 120_000;
      const { matcher } = newMatcher(chain, clock);
      await matcher.recover();

      assert.deepEqual(await fills(), [], "the dropped batch's reservation was released");
      await db.query(`DELETE FROM "TxJob" WHERE "id" = $1`, [jobId]);
    });

    test("fills linked to a live job are left for that job's wait", async () => {
      const { fillId, askHash } = await seedCross();
      await persistPendingFills(db, NET, [await plannedFrom(fillId, askHash)]);
      const jobId = "00000000-0000-4000-8000-0000000000aa";
      await db.query(
        `INSERT INTO "TxJob" ("id", "network", "service", "label", "fromAddress", "toAddress", "nonce",
                              "data", "value", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "rawTx",
                              "submittedHash", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, 'matcher', 'settleFillsSigned:BTC-PERP', $3, $4, 0, '0x', 0, 21000, 40000000000,
                 1000000000, '0x', $5, 'SUBMITTED', now(), now())`,
        [
          jobId,
          NET,
          OPERATOR.address.toLowerCase(),
          CONTRACTS.orderGateway.toLowerCase(),
          `0x${"34".repeat(32)}`,
        ]
      );
      await db.query(`UPDATE "Fill" SET "txJobId" = $2 WHERE "network" = $1`, [NET, jobId]);

      const chain = new FakeChain();
      const clock = new FakeClock();
      clock.t += 120_000;
      // recover() would also resume this job through the sender; only the
      // orphan sweep is under test here.
      await (newMatcher(chain, clock).matcher as unknown as {
        reconcileOrphanFills(): Promise<void>;
      }).reconcileOrphanFills();

      assert.equal((await fills()).length, 1, "an in-flight batch keeps its reservation");
      await db.query(`DELETE FROM "Fill" WHERE "network" = $1`, [NET]);
      await db.query(`DELETE FROM "TxJob" WHERE "id" = $1`, [jobId]);
    });

    test("recovery then a tick does not fill the same size twice", async () => {
      const { fillId, askHash } = await seedCross();
      await persistPendingFills(db, NET, [await plannedFrom(fillId, askHash)]);

      const chain = new FakeChain();
      const clock = new FakeClock();
      clock.t += 120_000;
      const { matcher } = newMatcher(chain, clock);
      await matcher.recover();
      await matcher.tick();

      const rows = await fills();
      assert.equal(rows.length, 1, "released, then matched once — never twice");
      assert.equal(chain.submittedBatchSizes.length, 1);
    });
  });

  describe("reconciliation with the indexer", () => {
    test("a fill the indexer marked SETTLED keeps the size consumed", async () => {
      const { fillId, askHash, bidHash } = await seedCross();
      const chain = new FakeChain();
      const { matcher } = newMatcher(chain, new FakeClock());
      await matcher.tick();

      // The indexer catches up: it writes SETTLED and rewrites filledSize.
      await db.query(
        `UPDATE "Fill" SET "status" = 'SETTLED', "txHash" = $2, "logIndex" = 0, "blockNumber" = 1000
         WHERE "network" = $1 AND "fillId" = $3`,
        [NET, `0x${"cd".repeat(32)}`, fillId.toLowerCase()]
      );
      await db.query(
        `UPDATE "Order" SET "filledSize" = "size", "status" = 'FILLED' WHERE "orderHash" = ANY($1::text[])`,
        [[askHash, bidHash]]
      );

      const book = await loadOrders(db, NET, MARKET_ID, NOW_SEC);
      assert.deepEqual(book, [], "both orders are done and leave the book");

      await matcher.tick();
      assert.equal(chain.submittedBatchSizes.length, 1, "nothing is matched a second time");
    });

    test("the settled total and the pending reservation do not double-count", async () => {
      // Alice 5: 2 settled by the indexer, 1 reserved by the matcher.
      const ask = makeOrder(ALICE, false, 5n * E18, INDEX_PRICE, 1n);
      const askHash = await seedOrder(ALICE, ask, { createdAt: new Date(NOW_MS - 500_000) });
      await db.query(`UPDATE "Order" SET "filledSize" = $2, "status" = 'PARTIALLY_FILLED' WHERE "orderHash" = $1`, [
        askHash,
        (2n * E18).toString(),
      ]);
      const bid = makeOrder(BOB, true, E18, INDEX_PRICE, 2n);
      const bidHash = await seedOrder(BOB, bid, { createdAt: new Date(NOW_MS - 300_000) });
      issuedFillIds.push(deriveFillId(askHash, bidHash, E18, INDEX_PRICE, 0n));

      const chain = new FakeChain();
      const { matcher } = newMatcher(chain, new FakeClock());
      await matcher.tick();

      const book = await loadOrders(db, NET, MARKET_ID, NOW_SEC);
      const alice = book.find((o) => o.orderHash === askHash)!;
      assert.equal(alice.filledSize, 3n * E18, "2 settled + 1 reserved");
      assert.equal(alice.size - alice.filledSize, 2n * E18);
    });

    test("releasing a pending fill never touches a settled one", async () => {
      const { fillId, askHash } = await seedCross();
      await persistPendingFills(db, NET, [await plannedFrom(fillId, askHash)]);
      await db.query(
        `UPDATE "Fill" SET "status" = 'SETTLED', "txHash" = $2, "logIndex" = 0, "blockNumber" = 1000
         WHERE "network" = $1 AND "fillId" = $3`,
        [NET, `0x${"ef".repeat(32)}`, fillId.toLowerCase()]
      );

      const released = await releasePendingFills(db, NET, [fillId]);
      assert.equal(released, 0);
      assert.equal((await fills()).length, 1);
    });
  });

  describe("book loading", () => {
    test("an unconfigured market refuses to match rather than guessing a floor", async () => {
      await db.query(`UPDATE "Market" SET "params" = '{}' WHERE "network" = $1 AND "id" = $2`, [NET, MARKET_ID]);
      await assert.rejects(() => loadBook(db, NET, MARKET_ID, NOW_SEC), /not ready to match/);
    });

    test("cancelled, expired and filled orders are not on the book", async () => {
      const base = makeOrder(ALICE, false, E18, INDEX_PRICE, 1n);
      await seedOrder(ALICE, base, { status: "CANCELLED" });
      await seedOrder(ALICE, makeOrder(ALICE, false, E18, INDEX_PRICE, 2n), { status: "FILLED" });
      await seedOrder(ALICE, { ...makeOrder(ALICE, false, E18, INDEX_PRICE, 3n), expiry: NOW_SEC - 1n });
      const live = await seedOrder(ALICE, makeOrder(ALICE, false, E18, INDEX_PRICE, 4n));

      const book = await loadOrders(db, NET, MARKET_ID, NOW_SEC);
      assert.deepEqual(book.map((o) => o.orderHash), [live]);
    });
  });
});

/** The planned fill for a seeded cross, as the matcher would have built it. */
async function plannedFrom(fillId: Hex, makerOrderHash: Hex) {
  const rows = await db.query(
    `SELECT "orderHash", "owner", "marketId", "isLong", "size"::text AS size,
            "limitPrice"::text AS "limitPrice", "reduceOnly", "nonce"::text AS nonce, "expiry", "signature"
     FROM "Order" WHERE "network" = $1 ORDER BY "createdAt" ASC`,
    [NET]
  );
  const [makerRow, takerRow] = rows;
  const toOrder = (r: Record<string, unknown>): Order => ({
    owner: getAddress(String(r.owner)),
    marketId: Number(r.marketId),
    isLong: r.isLong === true,
    size: BigInt(String(r.size)),
    limitPrice: BigInt(String(r.limitPrice)),
    reduceOnly: r.reduceOnly === true,
    nonce: BigInt(String(r.nonce)),
    expiry: BigInt(String(r.expiry)),
    referrer: zeroAddress,
  });
  return {
    fillId,
    maker: toOrder(makerRow),
    makerSignature: String(makerRow.signature) as Hex,
    taker: toOrder(takerRow),
    takerSignature: String(takerRow.signature) as Hex,
    size: BigInt(String(makerRow.size)),
    price: BigInt(String(makerRow.limitPrice)),
    marketId: MARKET_ID,
    makerOrderHash,
    takerOrderHash: String(takerRow.orderHash) as Hex,
    takerIsBuy: true,
    notional: (BigInt(String(makerRow.size)) * BigInt(String(makerRow.limitPrice))) / E18,
  };
}
