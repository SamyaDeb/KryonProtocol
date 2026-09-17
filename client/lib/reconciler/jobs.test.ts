// Reconciler job state machine, driven by a fake chain.
//
// The pure helpers (nonce gaps, revert extraction) run everywhere. The state
// machine itself writes to Postgres through raw SQL, so it is exercised against
// a real, migrated, disposable database and skipped without one — a hand-rolled
// in-memory SQL interpreter would test the interpreter, not the queries.
//
// Run: KRYON_TEST_DATABASE_URL=postgresql://localhost:5432/kryon_keepers_test npm test

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, type Address, type Hex, type TransactionReceipt } from "viem";

import { neon, type SqlClient } from "@/lib/sql";
import { GasSpendRollup, Metrics, createLogger, type Logger } from "@/lib/keepers/runtime";
import {
  detectNonceGaps,
  extractRevertData,
  finalize,
  openKeys,
  reconcileKey,
  revertReasonFor,
  type ReconcilerChain,
} from "./jobs";

const NETWORK = "arc-local";
const KEY: Address = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const TO: Address = "0x00000000000000000000000000000000000000aa";
const SERVICE = "matcher";

// ─── pure helpers ───────────────────────────────────────────────────────────

describe("detectNonceGaps", () => {
  test("no gap when open nonces are contiguous from the mined nonce", () => {
    assert.deepEqual(detectNonceGaps(5, [5, 6, 7]), []);
  });

  test("reports the missing nonce that blocks everything above it", () => {
    // Chain will accept 5 next; we hold 6 and 7, so 5 is a hole nothing fills.
    assert.deepEqual(detectNonceGaps(5, [6, 7]), [5]);
  });

  test("reports several holes", () => {
    assert.deepEqual(detectNonceGaps(10, [13]), [10, 11, 12]);
  });

  test("ignores nonces already mined", () => {
    assert.deepEqual(detectNonceGaps(8, [8, 9]), []);
  });

  test("no open jobs means no gaps", () => {
    assert.deepEqual(detectNonceGaps(3, []), []);
  });
});

describe("extractRevertData", () => {
  test("finds data on the error itself", () => {
    assert.equal(extractRevertData({ data: "0xdeadbeef" }), "0xdeadbeef");
  });

  test("walks the cause chain", () => {
    const err = { cause: { cause: { data: "0x1234abcd" } } };
    assert.equal(extractRevertData(err), "0x1234abcd");
  });

  test("unwraps a nested data object", () => {
    assert.equal(extractRevertData({ data: { data: "0xcafebabe" } }), "0xcafebabe");
  });

  test("returns null when there is nothing to decode", () => {
    assert.equal(extractRevertData(new Error("boom")), null);
  });

  test("does not loop forever on a cyclic cause", () => {
    const err: Record<string, unknown> = {};
    err.cause = err;
    assert.equal(extractRevertData(err), null);
  });
});

// ─── fake chain ─────────────────────────────────────────────────────────────

class NotFoundError extends Error {
  override name = "TransactionReceiptNotFoundError";
}

interface FakeState {
  minedNonce: number;
  receipts: Map<Hex, TransactionReceipt>;
  mempool: Set<Hex>;
  broadcasts: Hex[];
  sendError?: Error;
  revertData?: Hex;
}

function fakeChain(state: FakeState): ReconcilerChain {
  return {
    async getTransactionCount() {
      return state.minedNonce;
    },
    async getTransactionReceipt({ hash }) {
      const r = state.receipts.get(hash);
      if (!r) throw new NotFoundError(`receipt ${hash} could not be found`);
      return r;
    },
    async getTransaction({ hash }) {
      if (!state.mempool.has(hash)) throw new NotFoundError(`tx ${hash} could not be found`);
      return {};
    },
    async sendRawTransaction({ serializedTransaction }) {
      if (state.sendError) throw state.sendError;
      state.broadcasts.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
    async call() {
      if (state.revertData) throw Object.assign(new Error("execution reverted"), { data: state.revertData });
      return {};
    },
  };
}

function receipt(over: Partial<TransactionReceipt> & { status: "success" | "reverted" }): TransactionReceipt {
  return {
    blockNumber: 100n,
    gasUsed: 21_000n,
    effectiveGasPrice: 20_000_000_000n,
    ...over,
  } as TransactionReceipt;
}

// ─── database-backed state machine ──────────────────────────────────────────

const url = process.env.KRYON_TEST_DATABASE_URL;

describe("reconcileKey", { skip: !url }, () => {
  let sql: SqlClient;
  let log: Logger;
  let metrics: Metrics;
  let gas: GasSpendRollup;
  let seq = 0;

  before(() => {
    sql = neon(url!);
    // Silence the service's own logging; assertions read the database.
    log = createLogger("test", "error", {}, () => {});
  });

  after(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await sql.query(`TRUNCATE "TxJob", "GasSpend"`);
    metrics = new Metrics();
    gas = new GasSpendRollup(sql, NETWORK);
  });

  async function insertJob(over: { nonce: number; status?: string; createdAt?: Date; label?: string } ): Promise<{ id: string; hash: Hex; rawTx: Hex }> {
    seq += 1;
    const id = `job-${seq}`;
    const rawTx = toHex(`raw-${seq}`);
    const hash = keccak256(rawTx);
    const at = over.createdAt ?? new Date();
    await sql.query(
      `INSERT INTO "TxJob" ("id","network","service","label","fromAddress","toAddress","nonce","data",
        "value","gasLimit","maxFeePerGas","maxPriorityFeePerGas","rawTx","submittedHash","replacedByHash",
        "status","gasUsed","effectiveGasPrice","blockNumber","error","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,3000000,40000000000,1000000000,$9,$10,NULL,
        $11::"TxJobStatus",NULL,NULL,NULL,NULL,$12,$12)`,
      [
        id,
        NETWORK,
        SERVICE,
        over.label ?? "settleFillsSigned:BTC",
        KEY.toLowerCase(),
        TO.toLowerCase(),
        over.nonce,
        "0xdeadbeef",
        rawTx,
        hash,
        over.status ?? "SUBMITTED",
        at,
      ]
    );
    return { id, hash, rawTx };
  }

  const statusOf = async (id: string) =>
    (await sql.query(`SELECT "status"::text AS s, "gasUsed", "effectiveGasPrice", "blockNumber", "error" FROM "TxJob" WHERE "id" = $1`, [id]))[0];

  const run = (state: FakeState, now = Date.now()) =>
    reconcileKey(
      { chain: fakeChain(state), sql, network: NETWORK, log, metrics, gas, now: () => now, stuckAfterMs: 60_000 },
      { address: KEY, service: SERVICE }
    );

  test("confirmed: records gas, block and a GasSpend roll-up", async () => {
    const job = await insertJob({ nonce: 0 });
    const state: FakeState = {
      minedNonce: 0,
      receipts: new Map([[job.hash, receipt({ status: "success" })]]),
      mempool: new Set(),
      broadcasts: [],
    };

    const report = await run(state);
    assert.equal(report.outcomes.confirmed, 1);

    const row = await statusOf(job.id);
    assert.equal(row.s, "CONFIRMED");
    assert.equal(BigInt(row.gasUsed), 21_000n);
    assert.equal(BigInt(row.blockNumber), 100n);

    const spend = await sql.query(`SELECT "txCount", "gasUsed", "costWei" FROM "GasSpend"`);
    assert.equal(spend.length, 1);
    assert.equal(Number(spend[0].txCount), 1);
    assert.equal(BigInt(spend[0].gasUsed), 21_000n);
    assert.equal(BigInt(spend[0].costWei), 21_000n * 20_000_000_000n);
  });

  test("gas is rolled up once even if the tick runs twice", async () => {
    const job = await insertJob({ nonce: 0 });
    const state: FakeState = {
      minedNonce: 0,
      receipts: new Map([[job.hash, receipt({ status: "success" })]]),
      mempool: new Set(),
      broadcasts: [],
    };
    await run(state);
    await run(state); // the job is terminal now, so the second pass sees nothing

    const spend = await sql.query(`SELECT "txCount" FROM "GasSpend"`);
    assert.equal(Number(spend[0].txCount), 1);
  });

  test("finalize is the transition owner exactly once", async () => {
    const job = await insertJob({ nonce: 0 });
    assert.equal(await finalize(sql, job.id, { status: "CONFIRMED" }), true);
    assert.equal(await finalize(sql, job.id, { status: "CONFIRMED" }), false);
  });

  test("reverted: decodes the custom error and still charges gas", async () => {
    const job = await insertJob({ nonce: 0, label: "liquidate" });
    // KryonErrors.StaleOracle() — selector only, no arguments.
    const selector = keccak256(toHex("StaleOracle()")).slice(0, 10) as Hex;
    const state: FakeState = {
      minedNonce: 0,
      receipts: new Map([[job.hash, receipt({ status: "reverted" })]]),
      mempool: new Set(),
      broadcasts: [],
      revertData: selector,
    };

    const report = await run(state);
    assert.equal(report.outcomes.reverted, 1);

    const row = await statusOf(job.id);
    assert.equal(row.s, "REVERTED");
    assert.match(row.error, /StaleOracle/);
    // A reverted transaction still burns gas, so it must appear in the roll-up.
    const spend = await sql.query(`SELECT "txCount" FROM "GasSpend"`);
    assert.equal(Number(spend[0].txCount), 1);
  });

  test("reverted with an undecodable reason is recorded, not guessed at", async () => {
    const job = await insertJob({ nonce: 0 });
    const state: FakeState = {
      minedNonce: 0,
      receipts: new Map([[job.hash, receipt({ status: "reverted" })]]),
      mempool: new Set(),
      broadcasts: [],
      revertData: "0x11223344",
    };
    await run(state);
    const row = await statusOf(job.id);
    assert.equal(row.s, "REVERTED");
    assert.match(row.error, /undecodable/);
  });

  test("dropped: the nonce was consumed by a transaction we never recorded", async () => {
    const job = await insertJob({ nonce: 3 });
    const state: FakeState = { minedNonce: 4, receipts: new Map(), mempool: new Set(), broadcasts: [] };

    const report = await run(state);
    assert.equal(report.outcomes.dropped, 1);

    const row = await statusOf(job.id);
    assert.equal(row.s, "DROPPED");
    assert.match(row.error, /did not record/);
  });

  test("replaced: only the mined attempt at a nonce survives, the rest drop", async () => {
    const first = await insertJob({ nonce: 2, createdAt: new Date(Date.now() - 20_000) });
    const bumped = await insertJob({ nonce: 2, createdAt: new Date() });
    const state: FakeState = {
      minedNonce: 2,
      // The fee-bumped attempt is the one that mined.
      receipts: new Map([[bumped.hash, receipt({ status: "success" })]]),
      mempool: new Set(),
      broadcasts: [],
    };

    const report = await run(state);
    assert.equal(report.outcomes.confirmed, 1);
    assert.equal((await statusOf(bumped.id)).s, "CONFIRMED");
    assert.equal((await statusOf(first.id)).s, "DROPPED");

    // One mined transaction, one gas charge — not one per attempt.
    const spend = await sql.query(`SELECT "txCount" FROM "GasSpend"`);
    assert.equal(Number(spend[0].txCount), 1);
  });

  test("pending: in the mempool, left alone", async () => {
    const job = await insertJob({ nonce: 0 });
    const state: FakeState = {
      minedNonce: 0,
      receipts: new Map(),
      mempool: new Set([job.hash]),
      broadcasts: [],
    };
    const report = await run(state);
    assert.equal(report.outcomes.pending, 1);
    assert.equal(state.broadcasts.length, 0);
    assert.equal((await statusOf(job.id)).s, "SUBMITTED");
  });

  test("rebroadcast re-sends the identical signed bytes, never a new transaction", async () => {
    const job = await insertJob({ nonce: 0 });
    const state: FakeState = { minedNonce: 0, receipts: new Map(), mempool: new Set(), broadcasts: [] };

    const report = await run(state);
    assert.equal(report.outcomes.rebroadcast, 1);
    assert.deepEqual(state.broadcasts, [job.rawTx]);
    // Still open: a rebroadcast is not an outcome, it is a nudge.
    assert.equal((await statusOf(job.id)).s, "SUBMITTED");
  });

  test("stuck: past the window and the node refuses the rebroadcast", async () => {
    const old = new Date(Date.now() - 120_000);
    const job = await insertJob({ nonce: 0, createdAt: old });
    const state: FakeState = {
      minedNonce: 0,
      receipts: new Map(),
      mempool: new Set(),
      broadcasts: [],
      sendError: new Error("replacement transaction underpriced"),
    };

    const report = await run(state);
    assert.equal(report.outcomes.stuck, 1);
    assert.equal(report.stuck[0].id, job.id);
    // Reported, not resolved: only the key's owner can sign a fee bump.
    assert.equal((await statusOf(job.id)).s, "SUBMITTED");
  });

  test("nonce gap is detected and reported", async () => {
    // Chain will take nonce 5 next, but our lowest open job is 6.
    await insertJob({ nonce: 6 });
    await insertJob({ nonce: 7 });
    const state: FakeState = { minedNonce: 5, receipts: new Map(), mempool: new Set(), broadcasts: [] };

    const report = await run(state);
    assert.deepEqual(report.nonceGaps, [5]);
  });

  test("no gap reported when the open jobs start at the mined nonce", async () => {
    await insertJob({ nonce: 5 });
    await insertJob({ nonce: 6 });
    const state: FakeState = { minedNonce: 5, receipts: new Map(), mempool: new Set(), broadcasts: [] };
    const report = await run(state);
    assert.deepEqual(report.nonceGaps, []);
  });

  test("openKeys discovers keys from the table, not from configuration", async () => {
    await insertJob({ nonce: 0 });
    const keys = await openKeys(sql, NETWORK);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].address.toLowerCase(), KEY.toLowerCase());
    assert.equal(keys[0].service, SERVICE);
  });

  test("crash recovery: jobs persisted by a dead process are driven to terminal", async () => {
    // Simulates a TxSender that persisted and broadcast, then died: rows are
    // PENDING/SUBMITTED with no outcome recorded, and nothing else will finish
    // them. The reconciler is started cold and must drain all of them.
    const confirmedJob = await insertJob({ nonce: 0, status: "PENDING" });
    const revertedJob = await insertJob({ nonce: 1, status: "SUBMITTED" });
    const droppedJob = await insertJob({ nonce: 2, status: "SUBMITTED" });

    const state: FakeState = {
      minedNonce: 3,
      receipts: new Map([
        [confirmedJob.hash, receipt({ status: "success", blockNumber: 10n })],
        [revertedJob.hash, receipt({ status: "reverted", blockNumber: 11n })],
      ]),
      mempool: new Set(),
      broadcasts: [],
      revertData: "0x",
    };

    const report = await run(state);
    assert.equal(report.outcomes.confirmed, 1);
    assert.equal(report.outcomes.reverted, 1);
    assert.equal(report.outcomes.dropped, 1);

    assert.equal((await statusOf(confirmedJob.id)).s, "CONFIRMED");
    assert.equal((await statusOf(revertedJob.id)).s, "REVERTED");
    assert.equal((await statusOf(droppedJob.id)).s, "DROPPED");

    // Nothing is left open for a second reconciler to act on.
    const open = await sql.query(
      `SELECT count(*)::int AS n FROM "TxJob" WHERE "status"::text IN ('PENDING','SUBMITTED')`
    );
    assert.equal(open[0].n, 0);
  });

  test("GasSpend accumulates across jobs on the same day and key", async () => {
    const a = await insertJob({ nonce: 0 });
    const b = await insertJob({ nonce: 1 });
    const state: FakeState = {
      minedNonce: 0,
      receipts: new Map([
        [a.hash, receipt({ status: "success", gasUsed: 100n, effectiveGasPrice: 2n })],
        [b.hash, receipt({ status: "success", gasUsed: 50n, effectiveGasPrice: 3n })],
      ]),
      mempool: new Set(),
      broadcasts: [],
    };
    await run(state);

    const spend = await sql.query(`SELECT "txCount", "gasUsed", "costWei" FROM "GasSpend"`);
    assert.equal(spend.length, 1);
    assert.equal(Number(spend[0].txCount), 2);
    assert.equal(BigInt(spend[0].gasUsed), 150n);
    assert.equal(BigInt(spend[0].costWei), 100n * 2n + 50n * 3n);
  });
});

describe("revertReasonFor", () => {
  test("a replay that succeeds means the revert was state- or gas-dependent", async () => {
    const chain = fakeChain({ minedNonce: 0, receipts: new Map(), mempool: new Set(), broadcasts: [] });
    const reason = await revertReasonFor(
      chain,
      { toAddress: TO, data: "0x", value: 0n, fromAddress: KEY } as never,
      1n
    );
    assert.equal(reason.errorName, null);
    assert.equal(reason.raw, null);
  });

  test("decodes a known protocol error from the replay", async () => {
    const selector = keccak256(toHex("StaleOracle()")).slice(0, 10) as Hex;
    const chain = fakeChain({
      minedNonce: 0,
      receipts: new Map(),
      mempool: new Set(),
      broadcasts: [],
      revertData: selector,
    });
    const reason = await revertReasonFor(
      chain,
      { toAddress: TO, data: "0x", value: 0n, fromAddress: KEY } as never,
      1n
    );
    assert.equal(reason.errorName, "StaleOracle");
  });
});
