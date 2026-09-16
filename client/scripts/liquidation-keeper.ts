#!/usr/bin/env tsx
/**
 * Liquidation Keeper — scans trader accounts, detects liquidatable positions,
 * and calls perp-liquidation.liquidate() with the dedicated liquidator key.
 *
 * Without this service running 24/7, underwater positions sit unliquidated and
 * accrue bad debt until the protocol is insolvent. Treat it with the same
 * operational priority as the matcher.
 *
 * Policy per liquidatable account:
 *   - pick the position with the largest notional
 *   - try closing 100% of it; on LiquidationWouldNotImproveHealth or partial
 *     caps, retry at 50% then 25%
 *   - execution price = current on-chain oracle price for the market
 *
 * Also performs a daily instance-TTL keepalive (extend_instance_ttl) on the
 * core contracts so none of them can be archived out from under the protocol.
 *
 * Usage:
 *   DATABASE_URL=... LIQUIDATOR_SECRET=S... npx tsx scripts/liquidation-keeper.ts
 *   or via package.json: npm run dev:liquidator
 */

import {
  Keypair,
  Account,
  Contract,
  TransactionBuilder,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { StrKey } from "@stellar/stellar-sdk";
import { neon, type NeonQueryFunction } from "../lib/sql";
import { ACTIVE_MARKETS, ASSETS, CONTRACTS, NETWORK } from "../config";
import { closeSizeLadder } from "../lib/market/liquidation-sizing";
import { assertNoPublicSecretLeak, assertRequiredSecrets } from "../lib/secrets-check";

assertRequiredSecrets(["DATABASE_URL", "LIQUIDATOR_SECRET"]);
assertNoPublicSecretLeak();

type Sql = NeonQueryFunction<false, false>;

const TICK_INTERVAL_MS = Number(process.env.LIQUIDATION_INTERVAL_MS ?? "5000");
const MAX_ACCOUNTS_PER_TICK = Number(process.env.LIQUIDATION_MAX_ACCOUNTS ?? "500");
const TTL_BUMP_INTERVAL_MS = 24 * 3600 * 1000; // daily
// Opt-in because `settle_deficit` only exists on vaults deployed with
// multi-collateral support; against an older vault every call would fail and
// spam the log. Turn it on in the same release that deploys that vault.
const SETTLE_DEFICITS = (process.env.VAULT_SETTLE_DEFICITS ?? "false") === "true";
const FEE = "1000000";

const ORACLE_SYMBOL_BY_MARKET = new Map<number, string>(
  Object.values(ACTIVE_MARKETS).map((m) => [m.marketId, m.oracleSymbol])
);

// ── Read-only simulation helper (synthetic source account) ───────────────────

const simKp = Keypair.random();
let simSeq = 100;

async function simulateRead(
  server: sorobanRpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<unknown | null> {
  const account = new Account(simKp.publicKey(), (simSeq++).toString());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: FEE,
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) return null;
  const retval = (sim as sorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) return null;
  try {
    return scValToNative(retval);
  } catch {
    return null;
  }
}

// ── On-chain reads ────────────────────────────────────────────────────────────

interface HealthView {
  liquidatable: boolean;
  equity: bigint;
  maintenance_margin_required: bigint;
}

async function accountHealth(server: sorobanRpc.Server, user: string): Promise<HealthView | null> {
  const res = (await simulateRead(server, CONTRACTS.vault, "account_health", [
    new Address(user).toScVal(),
    new Address(ASSETS.usdc).toScVal(),
  ])) as Record<string, unknown> | null;
  if (!res || typeof res !== "object") return null;
  return {
    liquidatable: Boolean(res["liquidatable"]),
    equity: BigInt((res["equity"] as bigint | string | number) ?? 0),
    maintenance_margin_required: BigInt(
      (res["maintenance_margin_required"] as bigint | string | number) ?? 0
    ),
  };
}

interface PositionView {
  position_id: bigint;
  market_id: number;
  size: bigint;
  entry_price: bigint;
  is_long: boolean;
}

async function positionsOf(server: sorobanRpc.Server, user: string): Promise<PositionView[]> {
  const res = (await simulateRead(server, CONTRACTS.engine, "positions", [
    new Address(user).toScVal(),
  ])) as Array<Record<string, unknown>> | null;
  if (!Array.isArray(res)) return [];
  return res.map((p) => ({
    position_id: BigInt((p["position_id"] as bigint | string | number) ?? 0),
    market_id: Number(p["market_id"] ?? 0),
    size: BigInt((p["size"] as bigint | string | number) ?? 0),
    entry_price: BigInt((p["entry_price"] as bigint | string | number) ?? 0),
    is_long: Boolean(p["is_long"]),
  }));
}

async function oraclePrice(server: sorobanRpc.Server, symbol: string): Promise<bigint | null> {
  // get_price(asset, Option<OracleGuard>) — None (scvVoid) skips the guard;
  // execution-price banding is enforced by the engine at liquidation time.
  const res = (await simulateRead(server, CONTRACTS.oracleAdapter, "get_price", [
    nativeToScVal(symbol, { type: "symbol" }),
    xdr.ScVal.scvVoid(),
  ])) as Record<string, unknown> | null;
  if (!res || typeof res !== "object") return null;
  const price = res["price"];
  if (price === undefined || price === null) return null;
  return BigInt(price as bigint | string | number);
}

// ── Liquidation submission ────────────────────────────────────────────────────

/** The account's settlement-asset balance. Negative means the vault is owed. */
async function settlementBalance(
  server: sorobanRpc.Server,
  user: string
): Promise<bigint | null> {
  const val = await simulateRead(server, CONTRACTS.vault, "balance_of", [
    new Address(user).toScVal(),
    new Address(ASSETS.usdc).toScVal(),
  ]);
  // simulateRead already returns a native value, not an ScVal.
  if (val === null || val === undefined) return null;
  try {
    return BigInt(val as string | number | bigint);
  } catch {
    return null;
  }
}

/**
 * Clears a negative settlement balance by seizing the account's other
 * collateral at haircut value.
 *
 * Losses debit the settlement asset on every fill and funding application, so
 * an account margined in another collateral (USDT0) runs a negative settlement
 * balance while staying perfectly healthy. That balance is reserves the vault
 * has already paid to the winning side, so it should not wait for a
 * liquidation that may never come.
 */
async function settleDeficit(
  server: sorobanRpc.Server,
  liquidatorKp: Keypair,
  user: string
): Promise<string | null> {
  const account = await server.getAccount(liquidatorKp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: FEE,
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(
      new Contract(CONTRACTS.vault).call(
        "settle_deficit",
        new Address(liquidatorKp.publicKey()).toScVal(),
        new Address(user).toScVal(),
        new Address(ASSETS.usdc).toScVal()
      )
    )
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    const err = (sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error ?? "";
    console.error(`  settle_deficit sim error (${user.slice(0, 8)}): ${err.slice(0, 160)}`);
    return null;
  }
  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(liquidatorKp);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") return null;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") return send.hash;
    if (poll.status === "FAILED") return null;
  }
  return null;
}

async function submitLiquidate(
  server: sorobanRpc.Server,
  liquidatorKp: Keypair,
  user: string,
  positionId: bigint,
  closeSize: bigint,
  executionPrice: bigint
): Promise<string | null> {
  const account = await server.getAccount(liquidatorKp.publicKey());
  const contract = new Contract(CONTRACTS.liquidation);
  const tx = new TransactionBuilder(account, {
    fee: FEE,
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(
      contract.call(
        "liquidate",
        new Address(liquidatorKp.publicKey()).toScVal(),
        new Address(user).toScVal(),
        nativeToScVal(positionId, { type: "u64" }),
        nativeToScVal(closeSize, { type: "i128" }),
        nativeToScVal(executionPrice, { type: "i128" })
      )
    )
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    const err = (sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error ?? "";
    // Expected, non-actionable outcomes at smaller/larger close sizes.
    if (/NotLiquidatable|WouldNotImproveHealth/i.test(err)) return null;
    console.error(`  liquidate sim error (${user.slice(0, 8)}): ${err.slice(0, 160)}`);
    return null;
  }

  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(liquidatorKp);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") {
    console.error(`  liquidate submit error for ${user.slice(0, 8)}`);
    return null;
  }
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") return send.hash;
    if (poll.status === "FAILED") return null;
  }
  return null;
}

async function liquidateAccount(
  server: sorobanRpc.Server,
  liquidatorKp: Keypair,
  user: string,
  health: HealthView
): Promise<boolean> {
  const positions = await positionsOf(server, user);
  if (positions.length === 0) return false;

  // Largest-notional position first: closing it moves health the most.
  const ranked = [...positions].sort((a, b) => {
    const na = a.size * a.entry_price;
    const nb = b.size * b.entry_price;
    return nb > na ? 1 : nb < na ? -1 : 0;
  });

  for (const pos of ranked) {
    const symbol = ORACLE_SYMBOL_BY_MARKET.get(pos.market_id);
    if (!symbol) {
      // Correct to skip — we have no price for a market we do not track — but
      // NEVER silently. An unliquidated position in a de-listed market is bad
      // debt accruing with nothing watching it.
      console.error(
        `  ⚠ position ${pos.position_id} (${user.slice(0, 8)}…) is in market ${pos.market_id}, ` +
        `which is NOT in ACTIVE_MARKETS — cannot liquidate, skipping. ` +
        `If this market was de-listed, its open positions are unmanaged bad-debt risk.`
      );
      continue;
    }
    const price = await oraclePrice(server, symbol);
    if (!price || price <= 0n) {
      console.error(`  no fresh oracle price for market ${pos.market_id} — skipping`);
      continue;
    }
    // Smallest viable close FIRST, escalating only if the contract refuses.
    //
    // This used to try a full close first and step down to 1/2 and 1/4. Because
    // closing 100% always improves health, the first attempt always succeeded —
    // so every liquidatable account was fully liquidated, even one that dipped a
    // fraction below maintenance and would have been restored by closing a
    // tenth of its position. The contract cannot catch this: it enforces that
    // health improved, not that the close was minimal.
    //
    // The sizing is the same arithmetic as `risk_engine::plan_liquidation`,
    // which computes exactly this and which nothing ever called.
    const ladder = closeSizeLadder(pos, price, health);
    for (const closeSize of ladder) {
      if (closeSize <= 0n) continue;
      const hash = await submitLiquidate(
        server,
        liquidatorKp,
        user,
        pos.position_id,
        closeSize,
        price
      );
      if (hash) {
        console.log(
          `  ✓ liquidated ${user.slice(0, 8)} pos=${pos.position_id} size=${closeSize} tx=${hash.slice(0, 12)}...`
        );
        return true;
      }
    }
  }
  return false;
}

// ── Instance TTL keepalive ────────────────────────────────────────────────────

async function bumpInstanceTtls(server: sorobanRpc.Server, liquidatorKp: Keypair) {
  const targets: Array<[string, string]> = [
    ["gateway", CONTRACTS.orderGateway],
    ["engine", CONTRACTS.engine],
    ["vault", CONTRACTS.vault],
    ["oracle", CONTRACTS.oracleAdapter],
  ];
  for (const [name, contractId] of targets) {
    try {
      const account = await server.getAccount(liquidatorKp.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: FEE,
        networkPassphrase: NETWORK.passphrase,
      })
        .addOperation(new Contract(contractId).call("extend_instance_ttl"))
        .setTimeout(60)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (sorobanRpc.Api.isSimulationError(sim)) {
        console.error(`  ttl bump sim failed for ${name}`);
        continue;
      }
      const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
      prepared.sign(liquidatorKp);
      await server.sendTransaction(prepared);
      console.log(`  ✓ instance TTL extended: ${name}`);
    } catch (e) {
      console.error(`  ttl bump error for ${name}: ${(e as Error).message?.slice(0, 80)}`);
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  const sql = neon(process.env.DATABASE_URL!) as Sql;
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const liquidatorKp = Keypair.fromSecret(process.env.LIQUIDATOR_SECRET!);

  console.log("✓ Liquidation keeper starting");
  console.log(`  Network    : ${NETWORK.name}`);
  console.log(`  Liquidator : ${liquidatorKp.publicKey()}`);
  console.log(`  Interval   : ${TICK_INTERVAL_MS / 1000}s`);
  console.log(`  Deficits   : ${SETTLE_DEFICITS ? "settling (vault operator)" : "off"}`);

  let lastTtlBump = 0;

  while (true) {
    const started = Date.now();
    try {
      // Candidate set: every known trader account. Fine at current scale;
      // switch to an indexer-maintained "has open positions" set before the
      // account table grows past ~10k rows.
      const rows = (await sql`
        SELECT address FROM "Account"
        ORDER BY "updatedAt" DESC
        LIMIT ${MAX_ACCOUNTS_PER_TICK}
      `) as Array<{ address: string }>;

      let flagged = 0;
      for (const { address } of rows) {
        // Skip malformed/non-account rows; one bad address must not kill the scan.
        if (!StrKey.isValidEd25519PublicKey(address)) continue;
        try {
          // Deficits are settled for HEALTHY accounts too — that is the whole
          // point, since a liquidation may never come for them.
          if (SETTLE_DEFICITS) {
            const settlement = await settlementBalance(server, address);
            if (settlement !== null && settlement < 0n) {
              const hash = await settleDeficit(server, liquidatorKp, address);
              if (hash) {
                console.log(
                  `[${new Date().toISOString().slice(11, 19)}] settled deficit for ${address.slice(0, 8)} — ${hash}`
                );
              }
            }
          }

          const health = await accountHealth(server, address);
          if (!health?.liquidatable) continue;
          flagged++;
          console.log(
            `[${new Date().toISOString().slice(11, 19)}] liquidatable: ${address.slice(0, 8)} equity=${health.equity}`
          );
          await liquidateAccount(server, liquidatorKp, address, health);
        } catch (e) {
          console.error(`  account ${address.slice(0, 8)}: ${(e as Error).message?.slice(0, 100)}`);
        }
      }
      if (flagged === 0) {
        process.stdout.write(
          `\r  [${new Date().toISOString().slice(11, 19)}] scanned ${rows.length} accounts — none liquidatable`
        );
      }

      if (Date.now() - lastTtlBump > TTL_BUMP_INTERVAL_MS) {
        console.log("\n  running daily instance-TTL keepalive...");
        await bumpInstanceTtls(server, liquidatorKp);
        lastTtlBump = Date.now();
      }
    } catch (e) {
      console.error(`tick error: ${(e as Error).message?.slice(0, 120)}`);
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(500, TICK_INTERVAL_MS - elapsed));
  }
}

run().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
