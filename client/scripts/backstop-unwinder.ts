#!/usr/bin/env tsx
/**
 * backstop-unwinder — sells down the positions the Insurance backstop took over
 * in liquidations, through the order book. See lib/keepers/backstop.ts.
 *
 * Sends no transactions and needs no gas: it signs reduce-only orders owned by
 * the Insurance contract with a BACKSTOP_SIGNER_ROLE key (ERC-1271) and submits
 * them through the POST /api/orders validation path. Idle, and says why, until
 * governance sets unwind limits (`Insurance.setUnwindLimits`) and grants the
 * key its role; also idle while the protocol is paused.
 *
 * Environment:
 *   KRYON_NETWORK                  arc-mainnet | arc-testnet | arc-local
 *   DATABASE_URL                   Postgres (Order, Market, KeeperAction)
 *   ARC_RPC_URLS                   comma-separated, paid providers first (optional)
 *   KRYON_DEPLOYMENT_FILE          deployment record, or all CONTRACT_* variables
 *   KRYON_SIGNER_BACKSTOP_SIGNER   where the BACKSTOP_SIGNER_ROLE key lives (kms:<keyId> | keystore;
 *                                  env with BACKSTOP_SIGNER_PRIVATE_KEY on arc-local); lib/chain/signer.ts
 *   BACKSTOP_INTERVAL_MS           tick period (default 15000)
 *   BACKSTOP_ORDER_TTL_SECONDS     order lifetime, ≤ 3600 (Insurance.MAX_UNWIND_ORDER_TTL) (default 1800)
 *   BACKSTOP_PRICE_OFFSET_BPS      limit price distance from the index, clamped to the unwind band (default 25)
 *   BACKSTOP_MAX_ORDERS_PER_TICK   new orders per tick, one per market at most (default 4)
 *   LOG_LEVEL                      debug | info | warn | error (default info)
 */

import { neon } from "@/lib/sql";
import { loadServiceSigner } from "@/lib/chain/signer";
import { BackstopUnwinder, pgBackstopBook, viemBackstopChain } from "@/lib/keepers/backstop";
import { bootstrap, envInt, runLoop } from "@/lib/keepers/runtime";
import { erc1271CheckerFor } from "@/lib/validation";
import { assertServiceConfig } from "@/lib/config-check";

const SERVICE = "backstop-unwinder";

async function main() {
  // Every configuration problem at once, before anything connects or signs.
  assertServiceConfig("backstop-unwinder");
  const env = process.env;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = neon(databaseUrl);

  const ctx = await bootstrap({ service: SERVICE, sql, env });
  const signer = await loadServiceSigner({ keyEnvVar: "BACKSTOP_SIGNER_PRIVATE_KEY", network: ctx.network.id, env });
  ctx.log.info("signer loaded", { role: signer.role, mode: signer.mode, address: signer.account.address });
  const { engine, orderGateway, insurance } = ctx.contracts;

  const keeper = new BackstopUnwinder({
    chain: viemBackstopChain({ client: ctx.client, engine, orderGateway, insurance }),
    book: pgBackstopBook({
      q: sql,
      network: ctx.network.id,
      chainId: ctx.network.chainId,
      gateway: orderGateway,
      erc1271: erc1271CheckerFor(ctx.network.id),
    }),
    signer: signer.account,
    chainId: ctx.network.chainId,
    gateway: orderGateway,
    insurance,
    log: ctx.log,
    metrics: ctx.metrics,
    actions: ctx.actions,
    ttlSeconds: BigInt(envInt(env, "BACKSTOP_ORDER_TTL_SECONDS", 1_800)),
    priceOffsetBps: BigInt(envInt(env, "BACKSTOP_PRICE_OFFSET_BPS", 25)),
    maxOrdersPerTick: envInt(env, "BACKSTOP_MAX_ORDERS_PER_TICK", 4),
  });

  const tickMs = envInt(env, "BACKSTOP_INTERVAL_MS", 15_000);
  ctx.log.info("backstop unwinder starting", { signer: signer.account.address, insurance, tickMs });
  await runLoop({ tickMs, signal: ctx.shutdown.signal, log: ctx.log, metrics: ctx.metrics }, async () => {
    await keeper.tick();
  });

  ctx.log.info("backstop unwinder stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), level: "error", service: SERVICE, msg: "fatal", error: String(err) })
  );
  process.exit(1);
});
