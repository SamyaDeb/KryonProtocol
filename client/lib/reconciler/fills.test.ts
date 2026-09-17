// Unaccounted-fill classification against a real, migrated, disposable database.
//
// Run: KRYON_TEST_DATABASE_URL=postgresql://localhost:5432/kryon_keepers_test npm test

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { neon, type SqlClient } from "@/lib/sql";
import { KeeperActions, Metrics, createLogger, type Logger } from "@/lib/keepers/runtime";
import { scanUnaccountedFills } from "./fills";

const NETWORK = "arc-local";
const MARKET_ID = 2;
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const OLD = new Date(NOW - 600_000); // well past the 120s default threshold

const url = process.env.KRYON_TEST_DATABASE_URL;

describe("scanUnaccountedFills", { skip: !url }, () => {
  let sql: SqlClient;
  let log: Logger;
  let metrics: Metrics;
  let actions: KeeperActions;
  let seq = 0;

  before(async () => {
    sql = neon(url!);
    log = createLogger("test", "error", {}, () => {});
    // Fill has an FK to Market, and Market to nothing else.
    await sql.query(
      `INSERT INTO "Market" ("network","id","symbol","oracleId","active","updatedAt")
       VALUES ($1,$2,'BTC-PERP','0x4254430000000000000000000000000000000000000000000000000000000000',true,now())
       ON CONFLICT ("network","id") DO NOTHING`,
      [NETWORK, MARKET_ID]
    );
  });

  after(async () => {
    await sql?.query(`TRUNCATE "Fill", "TxJob", "KeeperAction"`);
    await sql?.end();
  });

  beforeEach(async () => {
    await sql.query(`TRUNCATE "Fill", "TxJob", "KeeperAction"`);
    metrics = new Metrics();
    actions = new KeeperActions(sql, NETWORK);
  });

  async function addJob(status: string, blockNumber: bigint | null): Promise<string> {
    seq += 1;
    const id = `job-${seq}`;
    await sql.query(
      `INSERT INTO "TxJob" ("id","network","service","label","fromAddress","toAddress","nonce","data",
        "value","gasLimit","maxFeePerGas","maxPriorityFeePerGas","rawTx","submittedHash","replacedByHash",
        "status","gasUsed","effectiveGasPrice","blockNumber","error","createdAt","updatedAt")
       VALUES ($1,$2,'matcher','settleFillsSigned','0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed',
        '0x00000000000000000000000000000000000000aa',$3,'0xab',0,3000000,40000000000,1000000000,
        $4,$5,NULL,$6::"TxJobStatus",NULL,NULL,$7,NULL,now(),now())`,
      [
        id,
        NETWORK,
        seq,
        // The schema CHECKs these as even-length lowercase hex.
        `0x${seq.toString(16).padStart(8, "0")}`,
        `0x${seq.toString(16).padStart(64, "0")}`,
        status,
        blockNumber?.toString() ?? null,
      ]
    );
    return id;
  }

  async function addFill(o: {
    status: string;
    txJobId: string | null;
    createdAt: Date;
    blockNumber?: bigint | null;
  }): Promise<string> {
    seq += 1;
    const fillId = `0x${seq.toString(16).padStart(64, "0")}`;
    // Fill_status_settled: SETTLED holds exactly when txHash, logIndex and
    // blockNumber are all set, so the log coordinates travel with the status.
    const settled = o.status === "SETTLED";
    await sql.query(
      `INSERT INTO "Fill" ("network","fillId","status","marketId","maker","taker","makerOrderHash",
        "takerOrderHash","takerIsBuy","size","price","txJobId","blockNumber","txHash","logIndex",
        "createdAt","updatedAt")
       VALUES ($1,$2,$3::"FillStatus",$4,'0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
        '0x3333333333333333333333333333333333333333333333333333333333333333',
        '0x4444444444444444444444444444444444444444444444444444444444444444',
        true,1000000000000000000,50000000000000000000000,$5,$6,$7,$8,$9,$9)`,
      [
        NETWORK,
        fillId,
        o.status,
        MARKET_ID,
        o.txJobId,
        settled ? (o.blockNumber?.toString() ?? null) : null,
        settled ? `0x${seq.toString(16).padStart(64, "0")}` : null,
        settled ? 0 : null,
        o.createdAt,
      ]
    );
    return fillId;
  }

  const scan = () =>
    scanUnaccountedFills({ sql, network: NETWORK, log, metrics, actions, now: () => NOW });

  test("a young pending fill is in flight, not a mismatch", async () => {
    const job = await addJob("CONFIRMED", 100n);
    await addFill({ status: "PENDING", txJobId: job, createdAt: new Date(NOW - 1_000) });
    assert.deepEqual(await scan(), []);
  });

  test("a fill whose batch is still open is not a mismatch", async () => {
    const job = await addJob("SUBMITTED", null);
    await addFill({ status: "PENDING", txJobId: job, createdAt: OLD });
    assert.deepEqual(await scan(), []);
  });

  test("batch-failed: the batch reverted, so the fill will never settle", async () => {
    const job = await addJob("REVERTED", 100n);
    await addFill({ status: "PENDING", txJobId: job, createdAt: OLD });

    const found = await scan();
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "batch-failed");
    assert.equal(found[0].jobStatus, "REVERTED");
  });

  test("never-submitted: pending with no batch at all", async () => {
    await addFill({ status: "PENDING", txJobId: null, createdAt: OLD });

    const found = await scan();
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "never-submitted");
    assert.equal(found[0].txJobId, null);
  });

  test("indexer-lag: batch confirmed above the indexer's high-water mark", async () => {
    const job = await addJob("CONFIRMED", 500n);
    await addFill({ status: "PENDING", txJobId: job, createdAt: OLD });
    // The indexer has only projected up to block 100.
    const older = await addJob("CONFIRMED", 100n);
    await addFill({ status: "SETTLED", txJobId: older, createdAt: OLD, blockNumber: 100n });

    const found = await scan();
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "indexer-lag");
  });

  test("not-in-receipt: the indexer passed the block and the fill was not in it", async () => {
    const job = await addJob("CONFIRMED", 100n);
    await addFill({ status: "PENDING", txJobId: job, createdAt: OLD });
    // The indexer has projected past block 100, so it saw that block.
    const later = await addJob("CONFIRMED", 200n);
    await addFill({ status: "SETTLED", txJobId: later, createdAt: OLD, blockNumber: 200n });

    const found = await scan();
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "not-in-receipt");
  });

  test("mismatches are durable as KeeperAction rows, and indexer lag is not", async () => {
    const failed = await addJob("REVERTED", 100n);
    await addFill({ status: "PENDING", txJobId: failed, createdAt: OLD });
    const lagging = await addJob("CONFIRMED", 900n);
    await addFill({ status: "PENDING", txJobId: lagging, createdAt: OLD });

    await scan();

    const rows = await sql.query(
      `SELECT "kind", "status"::text AS s, "payload" FROM "KeeperAction" WHERE "network" = $1`,
      [NETWORK]
    );
    assert.equal(rows.length, 1, "only the real mismatch is recorded");
    assert.equal(rows[0].kind, "reconcile.fill_mismatch");
    // SKIPPED, because the reconciler deliberately did nothing about it.
    assert.equal(rows[0].s, "SKIPPED");
    assert.equal(rows[0].payload.mismatchKind, "batch-failed");
  });

  test("a settled fill is never reported", async () => {
    const job = await addJob("CONFIRMED", 100n);
    await addFill({ status: "SETTLED", txJobId: job, createdAt: OLD, blockNumber: 100n });
    assert.deepEqual(await scan(), []);
  });

  test("a rejected fill is never reported", async () => {
    const job = await addJob("CONFIRMED", 100n);
    await addFill({ status: "REJECTED", txJobId: job, createdAt: OLD });
    assert.deepEqual(await scan(), []);
  });
});
