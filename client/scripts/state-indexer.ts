#!/usr/bin/env tsx
/**
 * Protocol indexer service (plan §6.4). Streams every Kryon contract log on
 * Arc into Postgres; see lib/indexer/indexer.ts.
 *
 * Environment:
 *   KRYON_NETWORK            arc-mainnet | arc-testnet | arc-local
 *   DATABASE_URL             Postgres for that network (migrated baseline)
 *   KRYON_DEPLOYMENT_FILE    deployment record, or the CONTRACT_* variables
 *   INDEXER_START_BLOCK      deployment block; used only when no cursor exists
 *   ARC_RPC_URLS             paid providers, comma separated (public RPC last)
 *   INDEXER_POLL_MS          idle poll interval (default 2000)
 *   INDEXER_MAX_WINDOW       max blocks per getLogs (default 2000)
 *
 * Usage:
 *   npx tsx scripts/state-indexer.ts            # run forever
 *   npx tsx scripts/state-indexer.ts --rebuild  # recompute projections from stored events, then exit
 */

import { arcNetwork, serverNetworkId } from "../lib/chain/networks";
import { serverContracts } from "../lib/chain/contracts-env";
import { assertChainId, createArcPublicClient } from "../lib/chain/clients";
import { pgDb } from "../lib/indexer/db";
import { ContractRegistry } from "../lib/indexer/decode";
import { Indexer, publicClientSource } from "../lib/indexer/indexer";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function main() {
  const network = arcNetwork(serverNetworkId());
  const contracts = serverContracts(network);
  const db = pgDb(required("DATABASE_URL"));
  const client = createArcPublicClient(network);
  const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

  const indexer = new Indexer(db, publicClientSource(client), new ContractRegistry(contracts), {
    network: network.id,
    startBlock: BigInt(required("INDEXER_START_BLOCK")),
    maxWindow: BigInt(process.env.INDEXER_MAX_WINDOW ?? "2000"),
    log,
  });

  if (process.argv.includes("--rebuild")) {
    const applied = await indexer.rebuild();
    log(`rebuild complete: ${applied} events applied`);
    await db.end();
    return;
  }

  await assertChainId(client, network);
  log(`indexer starting on ${network.id}, cursor ${(await indexer.cursor()) ?? "none"}`);

  const pollMs = Number(process.env.INDEXER_POLL_MS ?? "2000");
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopping = true;
    });
  }

  let failures = 0;
  while (!stopping) {
    try {
      const res = await indexer.step();
      failures = 0;
      if (res) {
        if (res.logs > 0) log(`blocks ${res.fromBlock}-${res.toBlock}: ${res.logs} logs`);
        continue;
      }
    } catch (err) {
      failures += 1;
      log(`step failed (${failures}): ${(err as Error).message}`);
    }
    // Back off on repeated failures, up to 30s.
    await new Promise((r) => setTimeout(r, failures ? Math.min(30_000, pollMs * 2 ** failures) : pollMs));
  }
  log("stopping");
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
