/**
 * Drives every open TxJob to a terminal state, for every service key.
 *
 * WHAT THE RECONCILER MAY AND MAY NOT DO
 * --------------------------------------
 * It does not hold the other services' private keys, and that constraint
 * shapes the whole design:
 *
 *   - **Rebroadcast** needs no key. `TxJob.rawTx` is already signed, so
 *     re-sending those exact bytes is safe for any key: same nonce, same
 *     payload, same hash. The node either accepts it or answers "already
 *     known". This is the only recovery the reconciler performs on a key it
 *     does not own.
 *   - **Fee-bump replacement** needs the key, because it is a new signature at
 *     the same nonce. Only the owning process can do that, through its own
 *     `TxSender.wait()`. When the reconciler finds a job stuck past the
 *     replacement window on a key it does not own, it reports it loudly and
 *     leaves it alone.
 *   - **Business intent is never re-sent.** A job that is DROPPED or REVERTED
 *     is recorded as such and handed back to the service that created it. The
 *     reconciler has no idea whether re-submitting a liquidation or a funding
 *     update is safe — the owning keeper does. See IDEMPOTENCY.md.
 *
 * Everything here is therefore either an observation (read a receipt, record
 * it) or a byte-identical rebroadcast. Neither can double-spend intent.
 */

import type { Address, Hex, TransactionReceipt } from "viem";

import type { SqlClient } from "@/lib/sql";
import { decodeRevert } from "@/lib/chain/settlement";
import { OPEN_TX_STATUSES, type TxJob, type TxJobStatus } from "@/lib/chain/tx-store";
import { errorMessage, type Logger, type Metrics } from "@/lib/keepers/runtime";

/** The RPC surface the reconciler uses. A fake chain in tests implements this. */
export interface ReconcilerChain {
  getTransactionCount(args: { address: Address; blockTag?: "latest" | "pending" }): Promise<number>;
  getTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceipt>;
  getTransaction(args: { hash: Hex }): Promise<unknown>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
  call(args: {
    to: Address;
    data: Hex;
    value?: bigint;
    account?: Address;
    blockNumber?: bigint;
  }): Promise<{ data?: Hex }>;
}

export type JobOutcome =
  | "confirmed"
  | "reverted"
  | "dropped"
  | "rebroadcast"
  | "stuck"
  | "pending";

export interface KeyReport {
  address: Address;
  service: string;
  /** Nonce of the next transaction the chain will accept. */
  minedNonce: number;
  outcomes: Record<JobOutcome, number>;
  /** Nonces below an in-flight job that nothing will ever fill. Blocks everything behind them. */
  nonceGaps: number[];
  stuck: Array<{ id: string; nonce: number; label: string; ageMs: number }>;
}

export interface ReconcileDeps {
  chain: ReconcilerChain;
  sql: SqlClient;
  network: string;
  log: Logger;
  metrics: Metrics;
  now?: () => number;
  /** A job open longer than this with no receipt is reported stuck. */
  stuckAfterMs?: number;
}

const DEFAULT_STUCK_AFTER_MS = 60_000;

// ─── discovery ──────────────────────────────────────────────────────────────

/**
 * Every (key, service) with open jobs. Discovered from the table rather than
 * configured, so a key the reconciler was never told about still gets drained.
 */
export async function openKeys(
  sql: SqlClient,
  network: string
): Promise<Array<{ address: Address; service: string }>> {
  const rows = await sql.query(
    `SELECT DISTINCT "fromAddress", "service" FROM "TxJob"
     WHERE "network" = $1 AND "status"::text = ANY($2::text[])
     ORDER BY "service" ASC, "fromAddress" ASC`,
    [network, [...OPEN_TX_STATUSES]]
  );
  return rows.map((r) => ({ address: r.fromAddress as Address, service: r.service as string }));
}

async function openJobsFor(sql: SqlClient, network: string, address: Address): Promise<TxJob[]> {
  const rows = await sql.query(
    `SELECT "id", "network", "service", "label", "fromAddress", "toAddress", "nonce", "data",
            "value", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "rawTx", "submittedHash",
            "replacedByHash", "status", "gasUsed", "effectiveGasPrice", "blockNumber", "error",
            "createdAt", "updatedAt"
     FROM "TxJob"
     WHERE "network" = $1 AND "fromAddress" = $2 AND "status"::text = ANY($3::text[])
     ORDER BY "nonce" ASC, "createdAt" ASC, "id" ASC`,
    [network, address.toLowerCase(), [...OPEN_TX_STATUSES]]
  );
  return rows.map(
    (r): TxJob => ({
      id: r.id,
      network: r.network,
      service: r.service,
      label: r.label,
      fromAddress: r.fromAddress as Address,
      toAddress: r.toAddress as Address,
      nonce: Number(r.nonce),
      data: r.data as Hex,
      value: BigInt(r.value),
      gasLimit: BigInt(r.gasLimit),
      maxFeePerGas: BigInt(r.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(r.maxPriorityFeePerGas),
      rawTx: r.rawTx as Hex,
      submittedHash: r.submittedHash as Hex,
      replacedByHash: (r.replacedByHash ?? null) as Hex | null,
      status: r.status as TxJobStatus,
      gasUsed: r.gasUsed === null ? null : BigInt(r.gasUsed),
      effectiveGasPrice: r.effectiveGasPrice === null ? null : BigInt(r.effectiveGasPrice),
      blockNumber: r.blockNumber === null ? null : BigInt(r.blockNumber),
      error: r.error ?? null,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt),
    })
  );
}

// ─── terminal transitions ───────────────────────────────────────────────────

/**
 * Move a job to a terminal state **only if it is still open**, and report
 * whether this call is the one that did it.
 *
 * Two reconcilers racing both land here and exactly one gets `true` back,
 * because the status predicate is evaluated inside the UPDATE; the winner is
 * the one that logs the transition. The owning service's `TxSender.wait()`
 * writes without this guard, which is harmless: both sides record the same
 * receipt, and GasSpend is derived from TxJob rather than counted here.
 */
export async function finalize(
  sql: SqlClient,
  id: string,
  patch: {
    status: Exclude<TxJobStatus, "PENDING" | "SUBMITTED">;
    gasUsed?: bigint | null;
    effectiveGasPrice?: bigint | null;
    blockNumber?: bigint | null;
    error?: string | null;
  }
): Promise<boolean> {
  const rows = await sql.query(
    `UPDATE "TxJob" SET
       "status" = $1::"TxJobStatus",
       "gasUsed" = COALESCE($2, "gasUsed"),
       "effectiveGasPrice" = COALESCE($3, "effectiveGasPrice"),
       "blockNumber" = COALESCE($4, "blockNumber"),
       "error" = COALESCE($5, "error"),
       "updatedAt" = now()
     WHERE "id" = $6 AND "status"::text = ANY($7::text[])
     RETURNING "id"`,
    [
      patch.status,
      patch.gasUsed?.toString() ?? null,
      patch.effectiveGasPrice?.toString() ?? null,
      patch.blockNumber?.toString() ?? null,
      patch.error ?? null,
      id,
      [...OPEN_TX_STATUSES],
    ]
  );
  return rows.length > 0;
}

// ─── revert decoding ────────────────────────────────────────────────────────

/** viem nests the revert payload; find the first 4-byte-or-longer hex `data`. */
export function extractRevertData(err: unknown): Hex | null {
  const seen = new Set<unknown>();
  let node: unknown = err;
  while (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const data = (node as { data?: unknown }).data;
    if (typeof data === "string" && /^0x([0-9a-fA-F]{8,})?$/.test(data)) return data as Hex;
    if (typeof data === "object" && data !== null) {
      const inner = (data as { data?: unknown }).data;
      if (typeof inner === "string" && /^0x[0-9a-fA-F]{8,}$/.test(inner)) return inner as Hex;
    }
    node = (node as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Why a mined transaction reverted. Receipts carry no reason, so the call is
 * replayed with `eth_call` **at the block it was mined in**, which reproduces
 * the state it saw. A node without archive state answers for a recent block
 * only; a failure to replay is reported as an unknown reason rather than
 * guessed at.
 */
export async function revertReasonFor(
  chain: ReconcilerChain,
  job: TxJob,
  blockNumber: bigint
): Promise<{ errorName: string | null; errorArgs: readonly unknown[]; raw: Hex | null }> {
  try {
    await chain.call({
      to: job.toAddress,
      data: job.data,
      value: job.value,
      account: job.fromAddress,
      blockNumber,
    });
    // Replaying succeeded, so the revert was state- or gas-dependent (for
    // example an out-of-gas, which leaves no reason to decode).
    return { errorName: null, errorArgs: [], raw: null };
  } catch (err) {
    const raw = extractRevertData(err);
    if (!raw || raw === "0x") return { errorName: null, errorArgs: [], raw };
    return { ...decodeRevert(raw), raw };
  }
}

// ─── the per-key pass ───────────────────────────────────────────────────────

export async function reconcileKey(
  deps: ReconcileDeps,
  key: { address: Address; service: string }
): Promise<KeyReport> {
  const now = deps.now ?? Date.now;
  const stuckAfter = deps.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
  const report: KeyReport = {
    address: key.address,
    service: key.service,
    minedNonce: 0,
    outcomes: { confirmed: 0, reverted: 0, dropped: 0, rebroadcast: 0, stuck: 0, pending: 0 },
    nonceGaps: [],
    stuck: [],
  };

  const jobs = await openJobsFor(deps.sql, deps.network, key.address);
  if (jobs.length === 0) return report;

  const minedNonce = await deps.chain.getTransactionCount({ address: key.address, blockTag: "latest" });
  report.minedNonce = minedNonce;

  // Group attempts by nonce: a fee-bump chain is several rows at one nonce, of
  // which at most one can ever mine.
  const byNonce = new Map<number, TxJob[]>();
  for (const job of jobs) {
    const list = byNonce.get(job.nonce);
    if (list) list.push(job);
    else byNonce.set(job.nonce, [job]);
  }

  for (const [nonce, attempts] of [...byNonce].sort((a, b) => a[0] - b[0])) {
    const outcome = await resolveNonce(deps, key, nonce, attempts, minedNonce, now(), stuckAfter, report);
    report.outcomes[outcome] += 1;
    deps.metrics.inc(`reconciler_job_${outcome}_total`);
  }

  report.nonceGaps = detectNonceGaps(minedNonce, [...byNonce.keys()]);
  if (report.nonceGaps.length > 0) {
    deps.metrics.inc("reconciler_nonce_gaps_total", report.nonceGaps.length);
    deps.log.error("NONCE GAP: nothing this key sends will mine until it is filled", {
      address: key.address,
      service: key.service,
      minedNonce,
      gaps: report.nonceGaps,
      blockedJobs: jobs.filter((j) => j.nonce > Math.min(...report.nonceGaps)).length,
    });
  }
  return report;
}

async function resolveNonce(
  deps: ReconcileDeps,
  key: { address: Address; service: string },
  nonce: number,
  attempts: TxJob[],
  minedNonce: number,
  nowMs: number,
  stuckAfterMs: number,
  report: KeyReport
): Promise<JobOutcome> {
  const log = deps.log.child({ service: key.service, address: key.address, nonce });

  // 1. Did any attempt at this nonce mine?
  for (const attempt of attempts) {
    const receipt = await receiptOf(deps.chain, attempt.submittedHash);
    if (!receipt) continue;

    const confirmed = receipt.status === "success";
    let error: string | null = null;
    if (!confirmed) {
      const reason = await revertReasonFor(deps.chain, attempt, receipt.blockNumber);
      error = reason.errorName
        ? `${reason.errorName}(${reason.errorArgs.map(String).join(", ")})`
        : `reverted, reason undecodable${reason.raw ? ` (${reason.raw.slice(0, 74)})` : ""}`;
      log.error("job reverted", {
        id: attempt.id,
        label: attempt.label,
        txHash: attempt.submittedHash,
        blockNumber: receipt.blockNumber,
        errorName: reason.errorName,
        errorArgs: reason.errorArgs.map(String),
      });
    }

    const transitioned = await finalize(deps.sql, attempt.id, {
      status: confirmed ? "CONFIRMED" : "REVERTED",
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      blockNumber: receipt.blockNumber,
      error,
    });

    // Gas is not rolled up here: `GasSpendRollup.recompute` derives it from
    // TxJob once per tick, which also covers jobs the owning service confirmed.
    if (transitioned) {
      if (confirmed) {
        log.info("job confirmed", {
          id: attempt.id,
          label: attempt.label,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
        });
      }
    }

    // Every other attempt at this nonce lost the race.
    for (const other of attempts) {
      if (other.id !== attempt.id) {
        await finalize(deps.sql, other.id, { status: "DROPPED", error: "superseded at the same nonce" });
      }
    }
    return confirmed ? "confirmed" : "reverted";
  }

  // 2. Nothing of ours mined, but the chain has moved past this nonce, so a
  //    transaction we did not record consumed it.
  if (minedNonce > nonce) {
    for (const attempt of attempts) {
      await finalize(deps.sql, attempt.id, {
        status: "DROPPED",
        error: "nonce consumed by a transaction this key did not record",
      });
    }
    log.warn("nonce consumed by an unrecorded transaction", {
      minedNonce,
      labels: attempts.map((a) => a.label),
    });
    return "dropped";
  }

  // 3. Still open. The newest attempt is the one that should be in the mempool.
  const newest = attempts[attempts.length - 1];
  const ageMs = nowMs - newest.createdAt.getTime();
  if (await inMempool(deps.chain, newest.submittedHash)) {
    return "pending";
  }

  // Not mined and not in any mempool we can see: re-send the same signed bytes.
  // Byte-identical, so it cannot duplicate intent — it is the same transaction.
  try {
    await deps.chain.sendRawTransaction({ serializedTransaction: newest.rawTx });
    log.info("rebroadcast", { id: newest.id, label: newest.label, ageMs });
    return "rebroadcast";
  } catch (err) {
    // Past the replacement window with a rebroadcast the node will not take
    // (usually underpriced). Only the key's owner can fee-bump it.
    if (ageMs >= stuckAfterMs) {
      report.stuck.push({ id: newest.id, nonce, label: newest.label, ageMs });
      log.error("job stuck: needs a fee bump from the key's owning process", {
        id: newest.id,
        label: newest.label,
        ageMs,
        rebroadcastError: errorMessage(err),
      });
      return "stuck";
    }
    log.warn("rebroadcast refused", { id: newest.id, error: errorMessage(err) });
    return "pending";
  }
}

/**
 * Nonces below an in-flight job that no open job covers. The account nonce
 * cannot advance past one, so every job above it is blocked indefinitely.
 *
 * Reported, never filled. Filling a gap means signing a no-op with the stranded
 * key, which the reconciler does not hold; and even for its own key, a gap
 * usually means another process shares the key, in which case a filler would
 * race that process rather than unblock it. The fix is operational: find the
 * second writer, stop it, and let the owning service fill its own gap.
 */
export function detectNonceGaps(minedNonce: number, openNonces: readonly number[]): number[] {
  if (openNonces.length === 0) return [];
  const open = new Set(openNonces);
  const highest = Math.max(...openNonces);
  const gaps: number[] = [];
  for (let n = minedNonce; n < highest; n++) {
    if (!open.has(n)) gaps.push(n);
  }
  return gaps;
}

// ─── RPC helpers ────────────────────────────────────────────────────────────

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  if (name === "TransactionReceiptNotFoundError" || name === "TransactionNotFoundError") return true;
  return /could not be found|not found/i.test(errorMessage(err));
}

async function receiptOf(chain: ReconcilerChain, hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await chain.getTransactionReceipt({ hash });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function inMempool(chain: ReconcilerChain, hash: Hex): Promise<boolean> {
  try {
    await chain.getTransaction({ hash });
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}
