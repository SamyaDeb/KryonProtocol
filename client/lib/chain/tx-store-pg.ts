/**
 * Postgres `TxJobStore` over the `TxJob` table of the Arc baseline schema
 * (kryon-protocol/prisma). Same contract as `MemoryTxJobStore`.
 *
 * Addresses and hex are lowercased on write: the table's CHECK constraints
 * reject mixed case, and lookups compare lowercase. uint256 columns are
 * NUMERIC(78,0); they cross the driver as decimal strings.
 */

import { getAddress, type Address, type Hex } from "viem";

import type { SqlClient, Row } from "@/lib/sql";
import { OPEN_TX_STATUSES, type TxJob, type TxJobPatch, type TxJobStore } from "./tx-store";

const COLUMNS = [
  "id",
  "network",
  "service",
  "label",
  "fromAddress",
  "toAddress",
  "nonce",
  "data",
  "value",
  "gasLimit",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "rawTx",
  "submittedHash",
  "replacedByHash",
  "status",
  "gasUsed",
  "effectiveGasPrice",
  "blockNumber",
  "error",
  "createdAt",
  "updatedAt",
] as const;

const SELECT = COLUMNS.map((c) => `"${c}"`).join(", ");

export class PgTxJobStore implements TxJobStore {
  constructor(private readonly sql: SqlClient) {}

  async insert(job: TxJob): Promise<void> {
    const values: unknown[] = [
      job.id,
      job.network,
      job.service,
      job.label,
      lower(job.fromAddress),
      lower(job.toAddress),
      job.nonce,
      lower(job.data),
      job.value.toString(),
      job.gasLimit.toString(),
      job.maxFeePerGas.toString(),
      job.maxPriorityFeePerGas.toString(),
      lower(job.rawTx),
      lower(job.submittedHash),
      job.replacedByHash === null ? null : lower(job.replacedByHash),
      job.status,
      optBig(job.gasUsed),
      optBig(job.effectiveGasPrice),
      optBig(job.blockNumber),
      job.error,
      job.createdAt,
      job.updatedAt,
    ];
    const placeholders = values.map((_, i) => (COLUMNS[i] === "status" ? `$${i + 1}::"TxJobStatus"` : `$${i + 1}`));
    const rows = await this.sql.query(
      `INSERT INTO "TxJob" (${SELECT}) VALUES (${placeholders.join(", ")})
       ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
      values
    );
    if (rows.length === 0) throw new Error(`TxJob ${job.id} already exists`);
  }

  async update(id: string, patch: TxJobPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown, cast = "") => {
      params.push(value);
      sets.push(`"${column}" = $${params.length}${cast}`);
    };
    if (patch.status !== undefined) set("status", patch.status, `::"TxJobStatus"`);
    if (patch.replacedByHash !== undefined)
      set("replacedByHash", patch.replacedByHash === null ? null : lower(patch.replacedByHash));
    if (patch.gasUsed !== undefined) set("gasUsed", optBig(patch.gasUsed));
    if (patch.effectiveGasPrice !== undefined) set("effectiveGasPrice", optBig(patch.effectiveGasPrice));
    if (patch.blockNumber !== undefined) set("blockNumber", optBig(patch.blockNumber));
    if (patch.error !== undefined) set("error", patch.error);
    set("updatedAt", new Date());
    params.push(id);
    const rows = await this.sql.query(
      `UPDATE "TxJob" SET ${sets.join(", ")} WHERE "id" = $${params.length} RETURNING "id"`,
      params
    );
    if (rows.length === 0) throw new Error(`TxJob ${id} not found`);
  }

  async openJobs(network: string, fromAddress: Address): Promise<TxJob[]> {
    const rows = await this.sql.query(
      `SELECT ${SELECT} FROM "TxJob"
       WHERE "network" = $1 AND "fromAddress" = $2 AND "status"::text = ANY($3::text[])
       ORDER BY "nonce" ASC, "createdAt" ASC, "id" ASC`,
      [network, lower(fromAddress), [...OPEN_TX_STATUSES]]
    );
    return rows.map(toJob);
  }

  async byNonce(network: string, fromAddress: Address, nonce: number): Promise<TxJob[]> {
    const rows = await this.sql.query(
      `SELECT ${SELECT} FROM "TxJob"
       WHERE "network" = $1 AND "fromAddress" = $2 AND "nonce" = $3
       ORDER BY "createdAt" ASC, "id" ASC`,
      [network, lower(fromAddress), nonce]
    );
    return rows.map(toJob);
  }
}

function toJob(r: Row): TxJob {
  return {
    id: r.id,
    network: r.network,
    service: r.service,
    label: r.label,
    fromAddress: getAddress(r.fromAddress),
    toAddress: getAddress(r.toAddress),
    nonce: Number(r.nonce),
    data: r.data as Hex,
    value: BigInt(r.value),
    gasLimit: BigInt(r.gasLimit),
    maxFeePerGas: BigInt(r.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(r.maxPriorityFeePerGas),
    rawTx: r.rawTx as Hex,
    submittedHash: r.submittedHash as Hex,
    replacedByHash: (r.replacedByHash ?? null) as Hex | null,
    status: r.status,
    gasUsed: r.gasUsed === null ? null : BigInt(r.gasUsed),
    effectiveGasPrice: r.effectiveGasPrice === null ? null : BigInt(r.effectiveGasPrice),
    blockNumber: r.blockNumber === null ? null : BigInt(r.blockNumber),
    error: r.error ?? null,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
}

function lower<T extends string>(v: T): T {
  return v.toLowerCase() as T;
}

function optBig(v: bigint | null): string | null {
  return v === null ? null : v.toString();
}
