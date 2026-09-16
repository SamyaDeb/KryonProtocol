#!/usr/bin/env tsx
import { neon } from "../lib/sql";

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const maxAgeMinutes = Number(process.env.SETTLEMENT_JOB_MAX_AGE_MINUTES ?? "15");
  const jobs = await sql`
    SELECT id, network, "unsignedXdr"
    FROM "TxJob"
    WHERE kind = 'settle_fill'
      AND status = 'QUEUED'
      AND "createdAt" < NOW() - (${maxAgeMinutes.toString()} || ' minutes')::interval
  `;

  let rolledBack = 0;
  for (const job of jobs) {
    let payload: {
      pendingTxHash?: string;
      makerAddress?: string;
      takerAddress?: string;
      makerNonce?: string;
      takerNonce?: string;
      fillSize?: string;
    } | null = null;

    try {
      payload = JSON.parse(String(job.unsignedXdr ?? "null"));
    } catch {
      payload = null;
    }

    if (payload?.pendingTxHash && payload?.makerAddress && payload?.takerAddress && payload?.fillSize) {
      await sql`DELETE FROM "Fill" WHERE network = ${job.network} AND "txHash" = ${payload.pendingTxHash}`;
      if (payload.makerNonce) {
        await sql`
          UPDATE "Order"
          SET "filledSize" = GREATEST(0::numeric, "filledSize"::numeric - ${payload.fillSize}::numeric)::text,
              "updatedAt" = NOW()
          WHERE owner = ${payload.makerAddress} AND nonce = ${payload.makerNonce}
        `;
      }
      if (payload.takerNonce) {
        await sql`
          UPDATE "Order"
          SET "filledSize" = GREATEST(0::numeric, "filledSize"::numeric - ${payload.fillSize}::numeric)::text,
              "updatedAt" = NOW()
          WHERE owner = ${payload.takerAddress} AND nonce = ${payload.takerNonce}
        `;
      }
      rolledBack++;
    }

    await sql`
      UPDATE "TxJob"
      SET status = 'FAILED', "lastError" = 'settlement auth expired', "updatedAt" = NOW()
      WHERE id = ${job.id}
    `;
  }

  console.log(`Expired ${jobs.length} stale TxJob(s), rolled back ${rolledBack} fill(s)`);
}

main().catch(console.error);
