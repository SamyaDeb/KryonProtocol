/**
 * TxSender: the only path by which a service key sends a transaction (plan §6.2).
 *
 *   - Nonces are allocated locally and seeded from `getTransactionCount(pending)`.
 *     Each send re-reads the pending count; a nonce gap left by a dropped
 *     transaction is filled by the next send.
 *   - Fees: maxFeePerGas = max(2 × baseFee, 40 gwei), tip 1 gwei. Nothing is
 *     ever signed below the network's 20 gwei base-fee floor.
 *   - Every attempt is persisted to the TxJobStore before broadcast.
 *   - No receipt and not in the mempool after 3s → rebroadcast the same bytes.
 *     No receipt after 10s → replace at the same nonce with fees +15%.
 *
 * One TxSender per key, one key per service. Server-side only.
 */

import {
  keccak256,
  parseGwei,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type TransactionSerializableEIP1559,
} from "viem";

import type { ArcNetwork } from "./networks";
import { OPEN_TX_STATUSES, type TxJob, type TxJobStore } from "./tx-store";

/** The read/broadcast subset of a viem PublicClient the sender uses. */
export type TxChain = Pick<
  PublicClient,
  | "getTransactionCount"
  | "getBlock"
  | "estimateGas"
  | "sendRawTransaction"
  | "getTransactionReceipt"
  | "getTransaction"
>;

/** A viem LocalAccount satisfies this. */
export interface TxSigner {
  address: Address;
  signTransaction(tx: TransactionSerializableEIP1559): Promise<Hex>;
}

export interface TxClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: TxClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface TxSenderOptions {
  network: ArcNetwork;
  service: string;
  chain: TxChain;
  signer: TxSigner;
  store: TxJobStore;
  clock?: TxClock;
  pollMs?: number;
  rebroadcastAfterMs?: number;
  replaceAfterMs?: number;
  /** Replacement fee bump in percent. Nodes require at least 10. */
  bumpPercent?: bigint;
  /** Replacements stop once maxFeePerGas would exceed this; rebroadcasts continue. */
  maxFeeCapWei?: bigint;
  /** `wait()` gives up after this long. The job stays open for the reconciler. */
  waitTimeoutMs?: number;
  /** estimateGas is multiplied by this (percent). */
  gasHeadroomPercent?: bigint;
  newId?: () => string;
}

export interface TxRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  /** Skips estimateGas when set. */
  gas?: bigint;
  label: string;
}

export interface TxOutcome {
  job: TxJob;
  receipt: TransactionReceipt;
}

export class TxTimeoutError extends Error {
  constructor(readonly nonce: number, readonly hash: Hex) {
    super(`transaction at nonce ${nonce} (${hash}) not mined before the wait timeout`);
  }
}

export class TxDroppedError extends Error {
  constructor(readonly nonce: number) {
    super(`nonce ${nonce} was consumed by a transaction this sender did not record`);
  }
}

export class TxRevertedError extends Error {
  constructor(readonly outcome: TxOutcome) {
    super(`transaction ${outcome.receipt.transactionHash} reverted`);
  }
}

const MIN_MAX_FEE = parseGwei("40");
const PRIORITY_FEE = parseGwei("1");

/** Plan §6.2 fee rule, with the network floor applied to a missing or low base fee. */
export function initialFees(baseFee: bigint | null | undefined, network: ArcNetwork) {
  const floor = parseGwei(network.minBaseFeeGwei.toString());
  const base = baseFee != null && baseFee > floor ? baseFee : floor;
  const doubled = base * 2n;
  const maxFeePerGas = doubled > MIN_MAX_FEE ? doubled : MIN_MAX_FEE;
  return { maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE };
}

function bump(value: bigint, percent: bigint): bigint {
  return (value * (100n + percent) + 99n) / 100n;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const details = (err as { details?: string }).details;
    return `${err.message}${details ? ` ${details}` : ""}`.toLowerCase();
  }
  return String(err).toLowerCase();
}

const isAlreadyKnown = (e: unknown) => /already known|known transaction|already imported/.test(errorText(e));
const isNonceTooLow = (e: unknown) => /nonce too low|nonce is too low|invalid nonce/.test(errorText(e));
const isUnderpriced = (e: unknown) => /underpriced|fee too low/.test(errorText(e));
const isNotFound = (e: unknown) =>
  (e as { name?: string })?.name === "TransactionReceiptNotFoundError" ||
  (e as { name?: string })?.name === "TransactionNotFoundError" ||
  /could not be found|not found/.test(errorText(e));

export class TxSender {
  readonly address: Address;
  private readonly o: Required<Omit<TxSenderOptions, "clock" | "newId">> & { clock: TxClock; newId: () => string };
  private nextNonce: number | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(options: TxSenderOptions) {
    this.address = options.signer.address;
    this.o = {
      clock: systemClock,
      pollMs: 500,
      rebroadcastAfterMs: 3_000,
      replaceAfterMs: 10_000,
      bumpPercent: 15n,
      maxFeeCapWei: parseGwei("1000"),
      waitTimeoutMs: 120_000,
      gasHeadroomPercent: 120n,
      newId: () => crypto.randomUUID(),
      ...options,
    };
    if (this.o.bumpPercent < 10n) throw new Error("bumpPercent must be at least 10");
  }

  /** Sign, persist and broadcast. Resolves once the node has the transaction. */
  async submit(req: TxRequest): Promise<TxJob> {
    return this.exclusive(async () => {
      const value = req.value ?? 0n;
      const gasLimit =
        req.gas ??
        ((await this.o.chain.estimateGas({ account: this.address, to: req.to, data: req.data, value })) *
          this.o.gasHeadroomPercent) /
          100n;
      for (let attempt = 0; ; attempt++) {
        const nonce = await this.allocateNonce();
        const block = await this.o.chain.getBlock({ blockTag: "latest" });
        const fees = initialFees(block.baseFeePerGas, this.o.network);
        const job = await this.signAndPersist({ ...req, value, nonce, gasLimit, ...fees });
        try {
          await this.broadcast(job);
        } catch (err) {
          // Our view of the nonce was stale (another process used this key, or a
          // restart lost state). Resync from the node and try again.
          if (isNonceTooLow(err) && attempt < 2) {
            this.nextNonce = null;
            continue;
          }
          throw err;
        }
        // A gap fill sits below nonces already in flight; never move the cursor back.
        if (this.nextNonce === null || nonce + 1 > this.nextNonce) this.nextNonce = nonce + 1;
        return job;
      }
    });
  }

  /** submit() then wait(). Throws TxRevertedError on a reverted receipt. */
  async send(req: TxRequest): Promise<TxOutcome> {
    const outcome = await this.wait(await this.submit(req));
    if (outcome.receipt.status !== "success") throw new TxRevertedError(outcome);
    return outcome;
  }

  /**
   * Watch a nonce until one of its attempts is mined, rebroadcasting and
   * replacing on the §6.2 schedule. Also used by the reconciler to resume
   * jobs found open after a restart.
   */
  async wait(job: TxJob): Promise<TxOutcome> {
    const started = this.o.clock.now();
    let current = job;
    let lastSubmit = started;
    let lastRebroadcast = started;

    for (;;) {
      const mined = await this.findMined(current.nonce);
      if (mined) return mined;

      const now = this.o.clock.now();
      if (now - started >= this.o.waitTimeoutMs) throw new TxTimeoutError(current.nonce, current.submittedHash);

      if (now - lastSubmit >= this.o.replaceAfterMs) {
        const replacement = await this.replace(current);
        if (replacement) {
          current = replacement;
          lastSubmit = now;
          lastRebroadcast = now;
        } else {
          // At the fee cap: keep the transaction visible, try again next window.
          await this.rebroadcast(current);
          lastSubmit = now;
          lastRebroadcast = now;
        }
      } else if (now - lastRebroadcast >= this.o.rebroadcastAfterMs) {
        await this.assertNonceNotTaken(current.nonce);
        if (!(await this.inMempool(current.submittedHash))) await this.rebroadcast(current);
        lastRebroadcast = now;
      }

      await this.o.clock.sleep(this.o.pollMs);
    }
  }

  /** Open jobs for this key, for the reconciler to pass to wait(). */
  async openJobs(): Promise<TxJob[]> {
    return this.o.store.openJobs(this.o.network.id, this.address);
  }

  // ─── nonces ────────────────────────────────────────────────────────────────

  private async allocateNonce(): Promise<number> {
    const pending = await this.o.chain.getTransactionCount({ address: this.address, blockTag: "pending" });
    if (this.nextNonce === null || pending > this.nextNonce) {
      this.nextNonce = pending;
      return pending;
    }
    if (pending < this.nextNonce) {
      // Nonces in [pending, next) that we believe are in flight. If one has no
      // open job, its transaction is gone; fill the lowest such gap first.
      const open = new Set((await this.openJobs()).map((j) => j.nonce));
      for (let n = pending; n < this.nextNonce; n++) {
        if (!open.has(n)) return n;
      }
    }
    return this.nextNonce;
  }

  // ─── signing and broadcast ───────────────────────────────────────────────

  private async signAndPersist(p: {
    to: Address;
    data: Hex;
    value: bigint;
    label: string;
    nonce: number;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }): Promise<TxJob> {
    const floor = parseGwei(this.o.network.minBaseFeeGwei.toString());
    if (p.maxFeePerGas < floor) throw new Error(`maxFeePerGas ${p.maxFeePerGas} is below the network floor`);
    const rawTx = await this.o.signer.signTransaction({
      type: "eip1559",
      chainId: this.o.network.chainId,
      nonce: p.nonce,
      to: p.to,
      data: p.data,
      value: p.value,
      gas: p.gasLimit,
      maxFeePerGas: p.maxFeePerGas,
      maxPriorityFeePerGas: p.maxPriorityFeePerGas,
    });
    const now = new Date(this.o.clock.now());
    const job: TxJob = {
      id: this.o.newId(),
      network: this.o.network.id,
      service: this.o.service,
      label: p.label,
      fromAddress: this.address,
      toAddress: p.to,
      nonce: p.nonce,
      data: p.data,
      value: p.value,
      gasLimit: p.gasLimit,
      maxFeePerGas: p.maxFeePerGas,
      maxPriorityFeePerGas: p.maxPriorityFeePerGas,
      rawTx,
      submittedHash: keccak256(rawTx),
      replacedByHash: null,
      status: "PENDING",
      gasUsed: null,
      effectiveGasPrice: null,
      blockNumber: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.o.store.insert(job);
    return job;
  }

  private async broadcast(job: TxJob): Promise<void> {
    try {
      await this.o.chain.sendRawTransaction({ serializedTransaction: job.rawTx });
    } catch (err) {
      if (!isAlreadyKnown(err)) {
        const status = isNonceTooLow(err) ? "DROPPED" : "FAILED";
        await this.o.store.update(job.id, { status, error: errorText(err).slice(0, 500) });
        job.status = status;
        throw err;
      }
    }
    await this.o.store.update(job.id, { status: "SUBMITTED" });
    job.status = "SUBMITTED";
  }

  private async rebroadcast(job: TxJob): Promise<void> {
    try {
      await this.o.chain.sendRawTransaction({ serializedTransaction: job.rawTx });
    } catch (err) {
      // "already known" is the expected answer; anything else surfaces on the next receipt poll.
      if (!isAlreadyKnown(err) && !isNonceTooLow(err) && !isUnderpriced(err)) throw err;
    }
  }

  /** Same nonce, same call, fees +bumpPercent. Returns null at the fee cap. */
  private async replace(job: TxJob): Promise<TxJob | null> {
    const block = await this.o.chain.getBlock({ blockTag: "latest" });
    const fresh = initialFees(block.baseFeePerGas, this.o.network);
    const bumpedMax = bump(job.maxFeePerGas, this.o.bumpPercent);
    const maxFeePerGas = bumpedMax > fresh.maxFeePerGas ? bumpedMax : fresh.maxFeePerGas;
    const maxPriorityFeePerGas = bump(job.maxPriorityFeePerGas, this.o.bumpPercent);
    if (maxFeePerGas > this.o.maxFeeCapWei) return null;

    const next = await this.signAndPersist({
      to: job.toAddress,
      data: job.data,
      value: job.value,
      label: job.label,
      nonce: job.nonce,
      gasLimit: job.gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    await this.o.store.update(job.id, { status: "REPLACED", replacedByHash: next.submittedHash });
    try {
      await this.broadcast(next);
    } catch (err) {
      // Underpriced: the next window bumps again from these fees. Nonce too low:
      // an attempt was mined meanwhile, and the next poll finds it.
      if (!isUnderpriced(err) && !isNonceTooLow(err)) throw err;
    }
    return next;
  }

  // ─── observation ─────────────────────────────────────────────────────────

  private async inMempool(hash: Hex): Promise<boolean> {
    try {
      await this.o.chain.getTransaction({ hash });
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** A mined nonce with none of our attempts mined means a foreign transaction took it. */
  private async assertNonceNotTaken(nonce: number): Promise<void> {
    const mined = await this.o.chain.getTransactionCount({ address: this.address, blockTag: "latest" });
    if (mined <= nonce) return;
    // Re-check: one of ours may have been mined between the two reads.
    if (await this.findMined(nonce)) return;
    for (const attempt of await this.o.store.byNonce(this.o.network.id, this.address, nonce)) {
      if (OPEN_TX_STATUSES.includes(attempt.status)) await this.o.store.update(attempt.id, { status: "DROPPED" });
    }
    throw new TxDroppedError(nonce);
  }

  /**
   * Checks every attempt at `nonce` for a receipt. On a hit, records the
   * outcome on the mined row and marks the other open attempts DROPPED.
   */
  private async findMined(nonce: number): Promise<TxOutcome | null> {
    const attempts = await this.o.store.byNonce(this.o.network.id, this.address, nonce);
    for (const attempt of attempts) {
      let receipt: TransactionReceipt;
      try {
        receipt = await this.o.chain.getTransactionReceipt({ hash: attempt.submittedHash });
      } catch (err) {
        if (isNotFound(err)) continue;
        throw err;
      }
      const patch = {
        status: receipt.status === "success" ? ("CONFIRMED" as const) : ("REVERTED" as const),
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        blockNumber: receipt.blockNumber,
      };
      await this.o.store.update(attempt.id, patch);
      for (const other of attempts) {
        if (other.id !== attempt.id && OPEN_TX_STATUSES.includes(other.status)) {
          await this.o.store.update(other.id, { status: "DROPPED" });
        }
      }
      return { job: { ...attempt, ...patch }, receipt };
    }
    return null;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }
}
