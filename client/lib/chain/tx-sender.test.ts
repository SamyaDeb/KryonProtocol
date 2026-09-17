// TxSender behaviour against a scripted chain (plan §6.2). No network.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, parseGwei, parseTransaction, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { ARC_NETWORKS } from "./networks";
import { MemoryTxJobStore } from "./tx-store";
import { TxDroppedError, TxSender, TxTimeoutError, initialFees, type TxChain, type TxClock } from "./tx-sender";

const NETWORK = ARC_NETWORKS["arc-testnet"];
const TO = "0x00000000000000000000000000000000000000aa" as const;

class FakeClock implements TxClock {
  t = 1_700_000_000_000;
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
  }
}

class NotFound extends Error {
  name = "TransactionReceiptNotFoundError";
}

/**
 * A single-account chain. `mempool` holds raw txs by hash; `mine()` includes
 * one per nonce. `onBroadcast` lets a test drop or reject broadcasts.
 */
class FakeChain {
  baseFee = parseGwei("20");
  minedNonce = 0; // latest count
  mempool = new Map<Hex, Hex>();
  receipts = new Map<Hex, { status: "success" | "reverted" }>();
  broadcasts: Hex[] = [];
  onBroadcast: (raw: Hex) => void = () => {};
  extraPending = 0; // simulates another process using the key

  api(): TxChain {
    // The returned object's methods are not arrow functions, so they need a stable
    // handle on the fake's mutable state.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async getTransactionCount({ blockTag }: { blockTag?: string }) {
        if (blockTag === "pending") {
          const nonces = [...self.mempool.values()].map((r) => parseTransaction(r).nonce!);
          const top = nonces.length ? Math.max(...nonces) + 1 : 0;
          return Math.max(self.minedNonce + self.extraPending, top);
        }
        return self.minedNonce;
      },
      async getBlock() {
        return { baseFeePerGas: self.baseFee };
      },
      async estimateGas() {
        return 100_000n;
      },
      async sendRawTransaction({ serializedTransaction }: { serializedTransaction: Hex }) {
        self.broadcasts.push(serializedTransaction);
        self.onBroadcast(serializedTransaction);
        const hash = keccak256(serializedTransaction);
        if (parseTransaction(serializedTransaction).nonce! < self.minedNonce) throw new Error("nonce too low");
        if (self.mempool.has(hash)) throw new Error("already known");
        self.mempool.set(hash, serializedTransaction);
        return hash;
      },
      async getTransactionReceipt({ hash }: { hash: Hex }) {
        const r = self.receipts.get(hash);
        if (!r) throw new NotFound("Transaction receipt could not be found");
        return {
          transactionHash: hash,
          status: r.status,
          gasUsed: 90_000n,
          effectiveGasPrice: parseGwei("21"),
          blockNumber: 7n,
        };
      },
      async getTransaction({ hash }: { hash: Hex }) {
        if (!self.mempool.has(hash) && !self.receipts.has(hash)) {
          const e = new Error("Transaction could not be found");
          e.name = "TransactionNotFoundError";
          throw e;
        }
        return {};
      },
    } as unknown as TxChain;
  }

  /** Mine the mempool entry for the next nonce (highest fee if several). */
  mine(status: "success" | "reverted" = "success") {
    const candidates = [...this.mempool.entries()]
      .map(([hash, raw]) => ({ hash, tx: parseTransaction(raw) }))
      .filter((c) => c.tx.nonce === this.minedNonce)
      .sort((a, b) => Number(b.tx.maxFeePerGas! - a.tx.maxFeePerGas!));
    if (!candidates.length) return null;
    const { hash } = candidates[0];
    this.receipts.set(hash, { status });
    for (const [h, raw] of this.mempool) {
      if (parseTransaction(raw).nonce === this.minedNonce) this.mempool.delete(h);
    }
    this.minedNonce++;
    return hash;
  }
}

function setup(opts: { onSleep?: (clock: FakeClock, chain: FakeChain) => void } = {}) {
  const chain = new FakeChain();
  const clock = new FakeClock();
  const store = new MemoryTxJobStore();
  const account = privateKeyToAccount(generatePrivateKey());
  let id = 0;
  const sleepingClock: TxClock = {
    now: () => clock.now(),
    sleep: async (ms) => {
      await clock.sleep(ms);
      opts.onSleep?.(clock, chain);
    },
  };
  const sender = new TxSender({
    network: NETWORK,
    service: "test",
    chain: chain.api(),
    signer: account,
    store,
    clock: sleepingClock,
    newId: () => `job-${++id}`,
  });
  return { chain, clock, store, sender, account };
}

const req = (label = "t") => ({ to: TO, data: "0x1234" as Hex, label });

test("fee rule: max(2 × baseFee, 40 gwei), 1 gwei tip, floor applied", () => {
  assert.deepEqual(initialFees(parseGwei("20"), NETWORK), {
    maxFeePerGas: parseGwei("40"),
    maxPriorityFeePerGas: parseGwei("1"),
  });
  assert.equal(initialFees(parseGwei("35"), NETWORK).maxFeePerGas, parseGwei("70"));
  // Below-floor or missing base fee is priced as the 20 gwei floor.
  assert.equal(initialFees(parseGwei("1"), NETWORK).maxFeePerGas, parseGwei("40"));
  assert.equal(initialFees(null, NETWORK).maxFeePerGas, parseGwei("40"));
});

test("persists before broadcast, then confirms with receipt data", async () => {
  const { chain, store, sender } = setup({ onSleep: (_c, ch) => void ch.mine() });
  chain.onBroadcast = (raw) => {
    const rows = [...store.jobs.values()];
    assert.equal(rows.length, 1, "row must exist before the node sees the tx");
    assert.equal(rows[0].rawTx, raw);
    assert.equal(rows[0].status, "PENDING");
  };
  const { job, receipt } = await sender.send({ ...req(), gas: 50_000n });
  assert.equal(receipt.status, "success");
  const row = store.jobs.get(job.id)!;
  assert.equal(row.status, "CONFIRMED");
  assert.equal(row.gasUsed, 90_000n);
  assert.equal(row.effectiveGasPrice, parseGwei("21"));
  assert.equal(row.nonce, 0);
  assert.equal(row.gasLimit, 50_000n);
  const tx = parseTransaction(row.rawTx);
  assert.equal(tx.chainId, NETWORK.chainId);
  assert.equal(tx.maxFeePerGas, parseGwei("40"));
});

test("estimates gas with headroom when not given", async () => {
  const { sender, store } = setup();
  const job = await sender.submit(req());
  assert.equal(store.jobs.get(job.id)!.gasLimit, 120_000n);
});

test("sequential submits take consecutive nonces", async () => {
  const { sender } = setup();
  const nonces = await Promise.all([sender.submit(req()), sender.submit(req()), sender.submit(req())]);
  assert.deepEqual(
    nonces.map((j) => j.nonce).sort(),
    [0, 1, 2]
  );
});

test("seeds from the pending count when another process used the key", async () => {
  const { chain, sender } = setup();
  chain.extraPending = 5;
  assert.equal((await sender.submit(req())).nonce, 5);
  assert.equal((await sender.submit(req())).nonce, 6);
});

test("fills a nonce gap left by a dropped transaction", async () => {
  const { chain, store, sender } = setup();
  await sender.submit(req()); // 0
  const lost = await sender.submit(req()); // 1
  await sender.submit(req()); // 2
  // Nonce 1 vanishes from the mempool and its job was marked failed elsewhere.
  chain.mempool.delete(lost.submittedHash);
  await store.update(lost.id, { status: "FAILED" });
  // Nonce 2 is still pending, so the pending count stays 3; also drop it to expose the gap.
  const two = [...chain.mempool.entries()].find(([, r]) => parseTransaction(r).nonce === 2)!;
  chain.mempool.delete(two[0]);
  const fill = await sender.submit(req());
  assert.equal(fill.nonce, 1, "the gap at nonce 1 is filled first");
  // The cursor did not move back: the next fresh nonce is still 3.
  assert.equal((await sender.submit(req())).nonce, 3);
});

test("rebroadcasts identical bytes after 3s when the tx left the mempool", async () => {
  let evicted = false;
  const { chain, sender } = setup({
    onSleep: (clock, ch) => {
      if (!evicted) {
        ch.mempool.clear();
        evicted = true;
      }
      if (ch.broadcasts.length >= 2) ch.mine();
    },
  });
  const job = await sender.submit(req());
  const { receipt } = await sender.wait(job);
  assert.equal(chain.broadcasts.length, 2);
  assert.equal(chain.broadcasts[1], chain.broadcasts[0]);
  assert.equal(receipt.transactionHash, job.submittedHash);
});

test("replaces at +15% after 10s and records the chain of attempts", async () => {
  const start = { t: 0 };
  const { chain, clock, store, sender } = setup({
    onSleep: (c, ch) => {
      // Never mine the first attempt; mine once a higher-fee attempt exists.
      const fees = [...ch.mempool.values()].map((r) => parseTransaction(r).maxFeePerGas!);
      if (fees.some((f) => f > parseGwei("40"))) ch.mine();
      assert.ok(c.t - start.t < 30_000, "should have replaced by now");
    },
  });
  start.t = clock.now();
  const job = await sender.submit(req());
  const { job: mined } = await sender.wait(job);

  assert.notEqual(mined.submittedHash, job.submittedHash);
  assert.equal(mined.nonce, job.nonce);
  assert.equal(mined.maxFeePerGas, parseGwei("46")); // 40 × 1.15
  assert.equal(mined.maxPriorityFeePerGas, parseGwei("1.15"));
  const original = store.jobs.get(job.id)!;
  assert.equal(original.status, "REPLACED");
  assert.equal(original.replacedByHash, mined.submittedHash);
  assert.equal(store.jobs.get(mined.id)!.status, "CONFIRMED");
  assert.ok(chain.broadcasts.length >= 2);
});

test("if the original lands after a replacement, the replacement is DROPPED", async () => {
  let replaced = false;
  const { store, sender } = setup({
    onSleep: (_c, ch) => {
      const txs = [...ch.mempool.entries()];
      if (txs.length >= 2 && !replaced) {
        replaced = true;
        // Mine the cheaper original instead of the replacement.
        const [origHash] = txs.sort((a, b) =>
          Number(parseTransaction(a[1]).maxFeePerGas! - parseTransaction(b[1]).maxFeePerGas!)
        )[0];
        ch.receipts.set(origHash, { status: "success" });
        ch.mempool.clear();
        ch.minedNonce++;
      }
    },
  });
  const job = await sender.submit(req());
  const { job: mined } = await sender.wait(job);
  assert.equal(mined.id, job.id);
  const rows = [...store.jobs.values()];
  assert.equal(rows.find((r) => r.id === job.id)!.status, "CONFIRMED");
  assert.equal(rows.find((r) => r.id !== job.id)!.status, "DROPPED");
});

test("stops replacing at the fee cap but keeps waiting", async () => {
  const chain = new FakeChain();
  const clock = new FakeClock();
  const store = new MemoryTxJobStore();
  const sender = new TxSender({
    network: NETWORK,
    service: "test",
    chain: chain.api(),
    signer: privateKeyToAccount(generatePrivateKey()),
    store,
    clock,
    maxFeeCapWei: parseGwei("50"),
    waitTimeoutMs: 60_000,
  });
  const job = await sender.submit(req());
  await assert.rejects(sender.wait(job), TxTimeoutError);
  const fees = [...store.jobs.values()].map((j) => j.maxFeePerGas);
  assert.deepEqual(fees, [parseGwei("40"), parseGwei("46")], "one replacement, then capped");
});

test("reports a nonce taken by a foreign transaction", async () => {
  const { store, sender } = setup({
    onSleep: (_c, ch) => {
      ch.mempool.clear();
      ch.minedNonce = 1;
    },
  });
  const job = await sender.submit(req());
  await assert.rejects(sender.wait(job), TxDroppedError);
  assert.equal(store.jobs.get(job.id)!.status, "DROPPED");
});

test("a nonce advanced elsewhere is picked up on the next submit", async () => {
  const { chain, sender, store } = setup();
  await sender.submit(req()); // nonce 0, cursor → 1
  chain.mempool.clear();
  chain.minedNonce = 3; // three txs landed from elsewhere; pending count now 3
  const job = await sender.submit(req());
  assert.equal(job.nonce, 3);
  assert.equal(store.jobs.get(job.id)!.status, "SUBMITTED");
});

test("nonce too low on submit marks the attempt DROPPED, resyncs and retries", async () => {
  const { chain, sender, store } = setup();
  let rejected = false;
  chain.onBroadcast = () => {
    if (!rejected) {
      rejected = true;
      throw new Error("nonce too low: next nonce 0, tx nonce 0");
    }
  };
  const job = await sender.submit(req());
  const rows = [...store.jobs.values()];
  assert.deepEqual(rows.map((r) => r.status), ["DROPPED", "SUBMITTED"]);
  assert.equal(job.id, rows[1].id);
});

test("a broadcast rejected on submit leaves the row FAILED and the nonce reusable", async () => {
  const { chain, sender, store } = setup();
  chain.onBroadcast = () => {
    throw new Error("insufficient funds for gas * price + value");
  };
  await assert.rejects(sender.submit(req()));
  assert.equal([...store.jobs.values()][0].status, "FAILED");
  chain.onBroadcast = () => {};
  assert.equal((await sender.submit(req())).nonce, 0);
});
