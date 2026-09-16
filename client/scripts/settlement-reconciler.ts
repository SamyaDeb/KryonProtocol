#!/usr/bin/env tsx
/**
 * settlement-reconciler.ts  (M3)
 *
 * Runs as a long-lived sidecar alongside the matcher service. On every tick:
 *
 * 1. SUBMITTED jobs — the sign route submitted the tx and stored submittedHash
 *    but timed out before polling Horizon to completion. Resolve each by
 *    checking getTransaction; mark CONFIRMED or FAILED accordingly.
 *
 * 2. QUEUED jobs with both auth entries collected but no submission attempt —
 *    e.g. the sign-route request lost its connection between the jsonb-merge
 *    and the QUEUED→SUBMITTED claim. Re-submit those txs here.
 *
 * 3. QUEUED jobs stuck for > STALE_QUEUED_MINUTES with only one or zero auth
 *    entries — expire them and roll back the corresponding Fill records so the
 *    orders return to the book.
 *
 * Usage:
 *   DATABASE_URL=... MATCHER_OPERATOR_SECRET=... npx tsx scripts/settlement-reconciler.ts
 *   or via package.json: npm run dev:reconciler
 */

import { neon, neonConfig, type NeonQueryFunction } from "../lib/sql";
import {
  Keypair,
  TransactionBuilder,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { NETWORK } from "../config";
import { assertRequiredSecrets, assertNoPublicSecretLeak } from "../lib/secrets-check";
assertRequiredSecrets(["DATABASE_URL", "MATCHER_OPERATOR_SECRET"]);
assertNoPublicSecretLeak();

neonConfig.fetchConnectionCache = true;

/** The tagged-template query function this module passes around. */
type Sql = NeonQueryFunction<false, false>;

const TICK_INTERVAL_MS = 15_000;
const SUBMITTED_CHECK_AFTER_SECS = 30;
const STALE_QUEUED_MINUTES = Number(process.env.SETTLEMENT_JOB_MAX_AGE_MINUTES ?? "15");

type JobRow = {
  id: string;
  network: string;
  status: string;
  submittedHash: string | null;
  unsignedXdr: string;
  createdAt: Date;
  updatedAt: Date;
};

type JobPayload = {
  makerAddress?: string;
  takerAddress?: string;
  makerAuthXdr?: string;
  takerAuthXdr?: string;
  assembledTxXdr?: string;
  makerSignedEntry?: string;
  takerSignedEntry?: string;
  fillPrice?: string;
  fillSize?: string;
  pendingTxHash?: string;
  makerNonce?: string;
  takerNonce?: string;
};

function parsePayload(raw: string): JobPayload | null {
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Undo the off-chain effects of a fill that will never settle.
 *
 * Deletes the Fill row and returns the consumed size to both orders. Safe to
 * run more than once: the DELETE is keyed on the pending tx hash, and the
 * decrements clamp at zero.
 *
 * This has to happen on EVERY terminal failure, not just an auth-collection
 * timeout. A settlement that failed on-chain leaves the same wreckage: the
 * orders show size they never actually traded, so that depth is gone from the
 * book until they expire, and the Fill counts toward volume and the leaderboard
 * as a trade that did not happen.
 */
async function rollbackFill(sql: Sql, network: string, payload: JobPayload | null): Promise<void> {
  if (!payload?.pendingTxHash || !payload.makerAddress || !payload.takerAddress || !payload.fillSize) {
    return;
  }
  await sql`DELETE FROM "Fill" WHERE network = ${network} AND "txHash" = ${payload.pendingTxHash}`;
  for (const [owner, nonce] of [
    [payload.makerAddress, payload.makerNonce],
    [payload.takerAddress, payload.takerNonce],
  ] as [string, string | undefined][]) {
    if (!nonce) continue;
    await sql`
      UPDATE "Order"
      SET "filledSize" = GREATEST(0::numeric, "filledSize"::numeric - ${payload.fillSize}::numeric)::text,
          "updatedAt" = NOW()
      WHERE owner = ${owner} AND nonce = ${nonce}
    `;
  }
}

// ── Confirm a SUBMITTED job by checking Horizon ───────────────────────────────

async function reconcileSubmitted(
  sql: ReturnType<typeof neon>,
  server: sorobanRpc.Server,
  job: JobRow,
) {
  if (!job.submittedHash) return;

  let poll: sorobanRpc.Api.GetTransactionResponse;
  try {
    poll = await server.getTransaction(job.submittedHash);
  } catch (e) {
    process.stderr.write(`  [reconciler] getTransaction error for job ${job.id}: ${(e as Error).message?.slice(0, 80)}\n`);
    return;
  }

  if (poll.status === "SUCCESS") {
    const ledger = "ledger" in poll ? Number(poll.ledger) : 0;
    const payload = parsePayload(job.unsignedXdr);
    await sql`
      UPDATE "TxJob"
      SET status = 'CONFIRMED', "updatedAt" = NOW()
      WHERE id = ${job.id} AND status = 'SUBMITTED'
    `;
    if (payload?.pendingTxHash && payload.makerAddress && payload.takerAddress) {
      await sql`
        UPDATE "Fill"
        SET "txHash" = ${job.submittedHash}, ledger = ${ledger}
        WHERE network = ${job.network}
          AND "txHash" = ${payload.pendingTxHash}
          AND maker = ${payload.makerAddress}
          AND taker = ${payload.takerAddress}
          AND "makerNonce" = ${payload.makerNonce ?? ""}
          AND "takerNonce" = ${payload.takerNonce ?? ""}
      `;
    }
    console.log(`  [reconciler] CONFIRMED job ${job.id.slice(0, 8)} hash=${job.submittedHash.slice(0, 12)}...`);
    return;
  }

  if (poll.status === "FAILED") {
    // Roll back BEFORE marking terminal, so a crash between the two leaves the
    // job still SUBMITTED and the next tick retries rather than stranding a
    // fill that the chain rejected.
    await rollbackFill(sql, job.network, parsePayload(job.unsignedXdr));
    await sql`
      UPDATE "TxJob"
      SET status = 'FAILED', "lastError" = 'on-chain tx failed', "updatedAt" = NOW()
      WHERE id = ${job.id} AND status = 'SUBMITTED'
    `;
    console.log(
      `  [reconciler] FAILED job ${job.id.slice(0, 8)} (tx failed on-chain) — fill rolled back`
    );
    return;
  }

  // NOT_FOUND: tx fell off the network (expired). Re-submit if we can rebuild it.
  if (poll.status === "NOT_FOUND") {
    await resubmitJob(sql, server, job);
  }
}

// ── Re-submit a QUEUED job that has both signed entries ───────────────────────

async function resubmitJob(
  sql: ReturnType<typeof neon>,
  server: sorobanRpc.Server,
  job: JobRow,
) {
  // Key separation: settlement uses ONLY the dedicated operator key. No
  // fallback to the oracle key — one key must never serve two roles.
  const feePayerSecret = process.env.MATCHER_OPERATOR_SECRET;
  if (!feePayerSecret) return;

  const payload = parsePayload(job.unsignedXdr);
  if (
    !payload?.assembledTxXdr ||
    !payload.makerSignedEntry ||
    !payload.takerSignedEntry
  ) return;

  // Claim the job atomically to prevent concurrent reconciler runs from double-submitting
  const claim = await sql`
    UPDATE "TxJob"
    SET status = 'SUBMITTED', "updatedAt" = NOW()
    WHERE id = ${job.id} AND status IN ('QUEUED', 'SUBMITTED')
      AND (status = 'QUEUED' OR "submittedHash" IS NULL)
    RETURNING id
  `;
  if (!claim.length) return;

  try {
    const feeKp = Keypair.fromSecret(feePayerSecret);
    const storedEnvelope = xdr.TransactionEnvelope.fromXDR(payload.assembledTxXdr, "base64");
    const storedTxBody = storedEnvelope.v1().tx();
    const op = storedTxBody.operations()[0];
    const sorobanData = storedTxBody.ext().sorobanData();
    const freshAccount = await server.getAccount(feeKp.publicKey());

    const rebuilt = new TransactionBuilder(freshAccount, {
      fee: String(storedTxBody.fee()),
      networkPassphrase: NETWORK.passphrase,
    })
      .addOperation(op)
      .setSorobanData(sorobanData)
      .setTimeout(60)
      .build();

    const makerEntry = xdr.SorobanAuthorizationEntry.fromXDR(payload.makerSignedEntry!, "base64");
    const takerEntry = xdr.SorobanAuthorizationEntry.fromXDR(payload.takerSignedEntry!, "base64");
    rebuilt.toEnvelope().v1().tx().operations()[0]
      .body().invokeHostFunctionOp().auth([makerEntry, takerEntry]);
    rebuilt.sign(feeKp);

    const send = await server.sendTransaction(rebuilt);
    if (send.status === "ERROR") {
      throw new Error(send.errorResult?.toXDR("base64") ?? "submit error");
    }

    await sql`
      UPDATE "TxJob" SET "submittedHash" = ${send.hash}, "updatedAt" = NOW() WHERE id = ${job.id}
    `;

    // Brief poll — don't block the reconciler tick for too long
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      const poll = await server.getTransaction(send.hash);
      if (poll.status === "SUCCESS") {
        const ledger = "ledger" in poll ? Number(poll.ledger) : 0;
        await sql`
          UPDATE "TxJob" SET status = 'CONFIRMED', "updatedAt" = NOW() WHERE id = ${job.id}
        `;
        if (payload.pendingTxHash && payload.makerAddress && payload.takerAddress) {
          await sql`
            UPDATE "Fill"
            SET "txHash" = ${send.hash}, ledger = ${ledger}
            WHERE network = ${job.network}
              AND "txHash" = ${payload.pendingTxHash}
              AND maker = ${payload.makerAddress}
              AND taker = ${payload.takerAddress}
          `;
        }
        console.log(`  [reconciler] re-submitted + CONFIRMED job ${job.id.slice(0, 8)}`);
        return;
      }
      if (poll.status === "FAILED") {
        await sql`
          UPDATE "TxJob" SET status = 'FAILED', "lastError" = 'resubmit tx failed', "updatedAt" = NOW()
          WHERE id = ${job.id}
        `;
        return;
      }
    }
    // Still SUBMITTED — next tick will pick it up
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`  [reconciler] resubmit failed for job ${job.id.slice(0, 8)}: ${msg.slice(0, 100)}\n`);
    await sql`
      UPDATE "TxJob" SET status = 'FAILED', "lastError" = ${msg.slice(0, 500)}, "updatedAt" = NOW()
      WHERE id = ${job.id}
    `.catch(() => {});
  }
}

// ── Expire stale QUEUED jobs (auth never collected) ───────────────────────────

async function expireStaleQueued(sql: ReturnType<typeof neon>) {
  const jobs = await sql<JobRow[]>`
    SELECT id, network, status, "submittedHash", "unsignedXdr", "createdAt", "updatedAt"
    FROM "TxJob"
    WHERE kind = 'settle_fill'
      AND status = 'QUEUED'
      AND "createdAt" < NOW() - (${String(STALE_QUEUED_MINUTES)} || ' minutes')::interval
  `;

  for (const job of jobs) {
    const payload = parsePayload(job.unsignedXdr);
    // Skip jobs with both auth entries — resubmit logic handles those
    if (payload?.makerSignedEntry && payload?.takerSignedEntry) continue;

    await rollbackFill(sql, job.network, payload);

    await sql`
      UPDATE "TxJob"
      SET status = 'FAILED', "lastError" = 'auth collection timeout', "updatedAt" = NOW()
      WHERE id = ${job.id} AND status = 'QUEUED'
    `;
  }

  if (jobs.length > 0) {
    console.log(`  [reconciler] expired ${jobs.length} stale QUEUED job(s)`);
  }
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function tick(
  sql: ReturnType<typeof neon>,
  server: sorobanRpc.Server,
) {
  // 1. SUBMITTED jobs: check Horizon for resolution
  const submitted = await sql<JobRow[]>`
    SELECT id, network, status, "submittedHash", "unsignedXdr", "createdAt", "updatedAt"
    FROM "TxJob"
    WHERE kind = 'settle_fill'
      AND status = 'SUBMITTED'
      AND "updatedAt" < NOW() - (${String(SUBMITTED_CHECK_AFTER_SECS)} || ' seconds')::interval
    LIMIT 50
  `;
  for (const job of submitted) {
    await reconcileSubmitted(sql, server, job);
  }

  // 2. QUEUED jobs with both auth entries: re-submit
  const readyQueued = await sql<JobRow[]>`
    SELECT id, network, status, "submittedHash", "unsignedXdr", "createdAt", "updatedAt"
    FROM "TxJob"
    WHERE kind = 'settle_fill'
      AND status = 'QUEUED'
      AND ("unsignedXdr"::jsonb ? 'makerSignedEntry')
      AND ("unsignedXdr"::jsonb ? 'takerSignedEntry')
      AND "updatedAt" < NOW() - '30 seconds'::interval
    LIMIT 20
  `;
  for (const job of readyQueued) {
    await resubmitJob(sql, server, job);
  }

  // 3. Expire stale QUEUED jobs with no/partial auth
  await expireStaleQueued(sql);
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function run() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("❌  DATABASE_URL is not set");
    process.exit(1);
  }

  const sql = neon(dbUrl);
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);

  console.log("✓ Settlement reconciler starting");
  console.log(`  Tick interval   : ${TICK_INTERVAL_MS / 1000}s`);
  console.log(`  SUBMITTED check : after ${SUBMITTED_CHECK_AFTER_SECS}s`);
  console.log(`  QUEUED expire   : after ${STALE_QUEUED_MINUTES}m`);
  console.log("");

  let errors = 0;
  while (true) {
    try {
      await tick(sql, server);
      errors = 0;
    } catch (e) {
      errors++;
      process.stderr.write(`  [reconciler] tick error: ${(e as Error).message?.slice(0, 100)}\n`);
      if (errors >= 5) {
        process.stderr.write(`  [reconciler] too many errors, exiting\n`);
        process.exit(1);
      }
    }
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
  }
}

run().catch(console.error);
