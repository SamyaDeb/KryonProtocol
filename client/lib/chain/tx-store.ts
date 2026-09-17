/**
 * Durable record of every transaction a service key signs (plan §6.2, §9).
 *
 * One row per broadcast attempt. A fee-bump replacement is a new row with the
 * same (fromAddress, nonce); the row it replaces moves to REPLACED and points
 * at it through `replacedByHash`. A row is written before its transaction is
 * broadcast, so after a crash the reconciler can find and finish every
 * transaction that might be in flight.
 *
 * The Postgres implementation arrives with the Step 4 schema; services
 * use `MemoryTxJobStore` until then, and tests always do.
 */

import type { Address, Hex } from "viem";

export type TxJobStatus =
  /** Signed and persisted, broadcast not yet acknowledged. */
  | "PENDING"
  | "SUBMITTED"
  /** Superseded by a fee bump at the same nonce. */
  | "REPLACED"
  | "CONFIRMED"
  | "REVERTED"
  /** The nonce was consumed by another transaction (e.g. its replacement). */
  | "DROPPED"
  /** Rejected by the node for a reason a retry will not fix. */
  | "FAILED";

export const OPEN_TX_STATUSES: readonly TxJobStatus[] = ["PENDING", "SUBMITTED"];

export interface TxJob {
  id: string;
  network: string;
  service: string;
  /** Free-form tag for dashboards, e.g. "settleFillsSigned:BTC". */
  label: string;
  fromAddress: Address;
  toAddress: Address;
  nonce: number;
  data: Hex;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  rawTx: Hex;
  submittedHash: Hex;
  replacedByHash: Hex | null;
  status: TxJobStatus;
  gasUsed: bigint | null;
  effectiveGasPrice: bigint | null;
  blockNumber: bigint | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type TxJobPatch = Partial<
  Pick<
    TxJob,
    "status" | "replacedByHash" | "gasUsed" | "effectiveGasPrice" | "blockNumber" | "error"
  >
>;

export interface TxJobStore {
  insert(job: TxJob): Promise<void>;
  update(id: string, patch: TxJobPatch): Promise<void>;
  /** PENDING / SUBMITTED rows for one key, lowest nonce first. */
  openJobs(network: string, fromAddress: Address): Promise<TxJob[]>;
  /** Every attempt at one nonce, oldest first. */
  byNonce(network: string, fromAddress: Address, nonce: number): Promise<TxJob[]>;
}

export class MemoryTxJobStore implements TxJobStore {
  readonly jobs = new Map<string, TxJob>();

  async insert(job: TxJob): Promise<void> {
    if (this.jobs.has(job.id)) throw new Error(`TxJob ${job.id} already exists`);
    this.jobs.set(job.id, { ...job });
  }

  async update(id: string, patch: TxJobPatch): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`TxJob ${id} not found`);
    this.jobs.set(id, { ...job, ...patch, updatedAt: new Date() });
  }

  async openJobs(network: string, fromAddress: Address): Promise<TxJob[]> {
    return this.filter(
      (j) => j.network === network && sameAddress(j.fromAddress, fromAddress) && OPEN_TX_STATUSES.includes(j.status)
    ).sort((a, b) => a.nonce - b.nonce || a.createdAt.getTime() - b.createdAt.getTime());
  }

  async byNonce(network: string, fromAddress: Address, nonce: number): Promise<TxJob[]> {
    return this.filter(
      (j) => j.network === network && sameAddress(j.fromAddress, fromAddress) && j.nonce === nonce
    ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  private filter(pred: (j: TxJob) => boolean): TxJob[] {
    return [...this.jobs.values()].filter(pred).map((j) => ({ ...j }));
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
