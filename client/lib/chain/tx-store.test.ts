// TxJobStore contract, run against MemoryTxJobStore always and against
// PgTxJobStore when KRYON_TEST_DATABASE_URL points at a migrated, disposable
// database (its TxJob table is truncated).
// Run: npm test
//   KRYON_TEST_DATABASE_URL=postgresql://localhost:5432/kryon_test?sslmode=disable npm test

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, type Address, type Hex } from "viem";

import { neon } from "@/lib/sql";
import { MemoryTxJobStore, type TxJob, type TxJobStore } from "./tx-store";
import { PgTxJobStore } from "./tx-store-pg";

const NETWORK = "arc-local";
const FROM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" as Address;
const OTHER = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359" as Address;
const TO = "0x00000000000000000000000000000000000000aa" as Address;
const MAX_UINT256 = 2n ** 256n - 1n;

let seq = 0;
function job(overrides: Partial<TxJob> = {}): TxJob {
  seq += 1;
  const at = new Date(1_700_000_000_000 + seq * 1000);
  return {
    id: `job-${seq}`,
    network: NETWORK,
    service: "matcher",
    label: "settleFillsSigned:BTC",
    fromAddress: FROM,
    toAddress: TO,
    nonce: 0,
    data: "0xdeadbeef",
    value: 0n,
    gasLimit: 3_000_000n,
    maxFeePerGas: 40_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    rawTx: "0x02f8",
    submittedHash: keccak256(toHex(`tx-${seq}`)),
    replacedByHash: null,
    status: "PENDING",
    gasUsed: null,
    effectiveGasPrice: null,
    blockNumber: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function contract(name: string, make: () => Promise<TxJobStore>, opts: { skip?: boolean } = {}) {
  describe(name, { skip: opts.skip }, () => {
    let store: TxJobStore;
    before(async () => {
      store = await make();
    });

    test("insert round-trips every field, including uint256 extremes", async () => {
      const j = job({ value: MAX_UINT256, gasLimit: MAX_UINT256, nonce: 7 });
      await store.insert(j);
      const [got] = await store.byNonce(NETWORK, FROM, 7);
      assert.equal(got.id, j.id);
      assert.equal(got.value, MAX_UINT256);
      assert.equal(got.gasLimit, MAX_UINT256);
      assert.equal(got.maxFeePerGas, j.maxFeePerGas);
      assert.equal(got.submittedHash, j.submittedHash);
      assert.equal(got.fromAddress.toLowerCase(), FROM.toLowerCase());
      assert.equal(got.createdAt.getTime(), j.createdAt.getTime());
      assert.equal(got.status, "PENDING");
    });

    test("duplicate id is rejected", async () => {
      const j = job({ nonce: 8 });
      await store.insert(j);
      await assert.rejects(store.insert({ ...j, submittedHash: keccak256(toHex("dup")) }), /already exists/);
    });

    test("update applies a patch and bumps updatedAt", async () => {
      const j = job({ nonce: 9 });
      await store.insert(j);
      await store.update(j.id, { status: "CONFIRMED", gasUsed: 21_000n, effectiveGasPrice: 20n, blockNumber: 123n });
      const [got] = await store.byNonce(NETWORK, FROM, 9);
      assert.equal(got.status, "CONFIRMED");
      assert.equal(got.gasUsed, 21_000n);
      assert.equal(got.blockNumber, 123n);
      assert.equal(got.error, null);
      assert.ok(got.updatedAt.getTime() > j.updatedAt.getTime());
    });

    test("update of an unknown id throws", async () => {
      await assert.rejects(store.update("missing", { status: "FAILED" }), /not found/);
    });

    test("openJobs: open rows for one key, lowest nonce first, address case-insensitive", async () => {
      const a = job({ nonce: 21, status: "SUBMITTED" });
      const b = job({ nonce: 20 });
      const done = job({ nonce: 19, status: "CONFIRMED" });
      const other = job({ nonce: 18, fromAddress: OTHER });
      for (const j of [a, b, done, other]) await store.insert(j);
      const open = (await store.openJobs(NETWORK, FROM.toLowerCase() as Address)).filter((j) => j.nonce >= 18);
      assert.deepEqual(
        open.map((j) => j.id),
        [b.id, a.id]
      );
    });

    test("byNonce: fee-bump chain oldest first", async () => {
      const first = job({ nonce: 30 });
      const bump = job({ nonce: 30, maxFeePerGas: 60_000_000_000n });
      await store.insert(bump);
      await store.insert(first);
      await store.update(first.id, { status: "REPLACED", replacedByHash: bump.submittedHash });
      const rows = await store.byNonce(NETWORK, FROM, 30);
      assert.deepEqual(
        rows.map((r) => r.id),
        [first.id, bump.id]
      );
      assert.equal(rows[0].replacedByHash, bump.submittedHash);
      assert.equal((await store.openJobs(NETWORK, FROM)).some((j) => j.id === first.id), false);
    });
  });
}

contract("MemoryTxJobStore", async () => new MemoryTxJobStore());

const url = process.env.KRYON_TEST_DATABASE_URL;
const sql = url ? neon(url) : null;
contract(
  "PgTxJobStore",
  async () => {
    await sql!.query(`TRUNCATE "TxJob"`);
    return new PgTxJobStore(sql!);
  },
  { skip: !url }
);

describe("TxJob table constraints", { skip: !url }, () => {
  test("rejects a mixed-case address and an unknown network", async () => {
    const insert = (network: string, from: string) =>
      sql!.query(
        `INSERT INTO "TxJob" ("id","network","service","label","fromAddress","toAddress","nonce","data","value",
           "gasLimit","maxFeePerGas","maxPriorityFeePerGas","rawTx","submittedHash","status","createdAt","updatedAt")
         VALUES ($1,$2,'s','l',$3,$4,0,'0x',0,0,0,0,'0x',$5,'PENDING',now(),now())`,
        [`raw-${network}-${from}`, network, from, TO, keccak256(toHex(`${network}${from}`)) as Hex]
      );
    await assert.rejects(insert(NETWORK, FROM), /TxJob_fromAddress_addr/);
    await assert.rejects(insert("stellar-mainnet", FROM.toLowerCase()), /TxJob_network_check/);
  });
});

after(async () => {
  await sql?.end();
});
