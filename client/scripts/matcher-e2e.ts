#!/usr/bin/env tsx
/**
 * End-to-end: the real matcher, the real contracts, a real database (plan §4.3).
 *
 * Boots a local arc-anvil, deploys Kryon with the arc-local config, funds
 * traders, pushes an oracle price, signs real EIP-712 orders with the anvil
 * development keys, seeds them into Postgres, and runs the matcher's tick.
 * Then it checks that the chain and the database tell the same story.
 *
 * Scenarios: a simple cross, a partial fill, a rejected fill mixed with good
 * ones in one batch, a batch over the 40-fill cap, and an order outside the
 * oracle band.
 *
 * Local only, and it says so: the RPC must be a loopback address and the chain
 * must be a fresh anvil. It never touches Arc testnet or mainnet.
 *
 * Environment:
 *   KRYON_E2E_DATABASE_URL   a migrated, DISPOSABLE Postgres (required)
 *   KRYON_E2E_RPC_PORT       anvil port (default 8545)
 *   KRYON_E2E_KEEP_ANVIL     leave the node running for debugging
 *
 * Usage:
 *   KRYON_E2E_DATABASE_URL=postgresql://localhost:5432/kryon_matcher_e2e npm run test:e2e:matcher
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

import { engineAbi, oracleAdapterAbi, orderGatewayAbi, riskParamsAbi, vaultAbi } from "../lib/chain/contracts";
import { ARC_NETWORKS, contractsFromDeploymentJson, oracleId, type ProtocolContracts } from "../lib/chain/networks";
import { TxSender } from "../lib/chain/tx-sender";
import { MemoryTxJobStore } from "../lib/chain/tx-store";
import { hashOrder, orderTypedData, type Order } from "../lib/market/eip712";
import { PRECISION } from "../lib/market/matching-engine";
import { pgDb, type Db } from "../lib/matcher/db";
import { Matcher, type Logger } from "../lib/matcher/loop";

const run = promisify(execFile);

const E18 = PRECISION;
const NETWORK = ARC_NETWORKS["arc-local"];
const NET = NETWORK.id;
const MARKET_ID = 2;
const SYMBOL = "BTC-PERP";
const INDEX_PRICE = 100_000n * E18;
/** 0.001 BTC = $100 notional, comfortably over the $40 floor. */
const UNIT = 10n ** 15n;

const PORT = Number(process.env.KRYON_E2E_RPC_PORT ?? "8545");
const RPC = `http://127.0.0.1:${PORT}`;
const EVM_DIR = resolve(import.meta.dirname, "../../kryon-protocol/evm");
const DEPLOYMENT = resolve(EVM_DIR, "deployments/arc-local.json");

const MNEMONIC = "test test test test test test test test test test test junk";
const account = (index: number): HDAccount => mnemonicToAccount(MNEMONIC, { addressIndex: index });

// Indices fixed by infra/deploy/environments/arc-local.toml.
const DEPLOYER = account(0);
const OPERATOR = account(4);
const PUBLISHER = account(5);
const ALICE = account(8);
const BOB = account(9);
/** Deliberately unfunded: its fills are rejected for margin. */
const MALLORY = account(10);

const chain = defineChain({
  id: NETWORK.chainId,
  name: NETWORK.label,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

let failures = 0;
const log = (msg: string) => process.stdout.write(`${msg}\n`);
const step = (msg: string) => log(`\n── ${msg} ${"─".repeat(Math.max(0, 66 - msg.length))}`);

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    log(`  ✓ ${name}`);
  } else {
    failures += 1;
    log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `expected ${expected}, got ${actual}`);
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** Every settled batch's size and gas, taken from the matcher's own log. */
const batchGas: { fills: number; gasUsed: bigint; gasPerFill: bigint }[] = [];

/** Records batch gas, and prints everything when KRYON_E2E_VERBOSE is set. */
function recordingLogger(inner: Logger): Logger {
  return {
    info: (e, f) => {
      if (e === "batch_applied" && f) {
        batchGas.push({
          fills: Number(f.fills),
          gasUsed: BigInt(String(f.gasUsed)),
          gasPerFill: BigInt(String(f.gasPerFill)),
        });
      }
      inner.info(e, f);
    },
    warn: inner.warn,
    error: inner.error,
  };
}

/** Every event printed, for when a scenario fails and the reason is in the logs. */
const verbose: Logger = {
  info: (e, f) => log(`    · ${e} ${f ? JSON.stringify(f, replacer) : ""}`),
  warn: (e, f) => log(`    ! ${e} ${f ? JSON.stringify(f, replacer) : ""}`),
  error: (e, f) => log(`    ✗ ${e} ${f ? JSON.stringify(f, replacer) : ""}`),
};

// ─── boot ────────────────────────────────────────────────────────────────────

/**
 * Refuse to run anywhere but a local node. The E2E funds accounts and signs
 * settlements; pointed at a public RPC by accident it would do that for real.
 */
function assertLocalOnly() {
  const host = new URL(RPC).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`the matcher E2E only runs against a local node; got ${RPC}`);
  }
}

async function startAnvil(): Promise<ChildProcess> {
  step(`starting arc-anvil on ${RPC}`);
  const proc = spawn("arc-anvil", ["--chain-id", String(NETWORK.chainId), "--port", String(PORT), "--silent"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  proc.stderr?.on("data", (d) => process.stderr.write(`anvil: ${d}`));
  const client = createPublicClient({ chain, transport: http(RPC) });
  for (let i = 0; i < 60; i++) {
    try {
      const id = await client.getChainId();
      if (id !== NETWORK.chainId) throw new Error(`anvil reports chain ${id}`);
      log(`  anvil up, chain ${id}`);
      return proc;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("arc-anvil did not come up");
}

async function deploy(): Promise<ProtocolContracts> {
  step("deploying Kryon with the arc-local config");
  await run(
    "arc-forge",
    [
      "script",
      "script/DeployAll.s.sol:DeployAll",
      "--rpc-url",
      RPC,
      "--broadcast",
      "--skip-simulation",
      // Arc prices above a 20 gwei floor; forge's own estimate can land under
      // the node's base fee, so the price is set explicitly.
      "--with-gas-price",
      "100gwei",
      "--private-key",
      DEPLOYER.getHdKey().privateKey ? toHex32(DEPLOYER) : "",
    ],
    { cwd: EVM_DIR, env: { ...process.env, KRYON_NETWORK: NET }, maxBuffer: 64 * 1024 * 1024 }
  );
  const contracts = contractsFromDeploymentJson(readFileSync(DEPLOYMENT, "utf8"), NETWORK.chainId);
  log(`  gateway ${contracts.orderGateway}`);
  log(`  vault   ${contracts.vault}`);
  return contracts;
}

function toHex32(a: HDAccount): Hex {
  const key = a.getHdKey().privateKey;
  if (!key) throw new Error("account has no private key");
  return `0x${Buffer.from(key).toString("hex")}`;
}

function wallet(a: HDAccount) {
  return createWalletClient({ account: a, chain, transport: http(RPC) });
}

// ─── on-chain setup ──────────────────────────────────────────────────────────

const FEES = { maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

/**
 * Publish an index price.
 *
 * `pushPrices` has three timing rules, all measured against `block.timestamp`
 * rather than the wall clock: the publish time may not be in the future, may
 * not be older than the feed's 15s max age, and must be strictly newer than
 * this publisher's last observation. Anvil only mines when a transaction
 * arrives, so wall clock and chain time drift apart during the seeding work
 * and a fixed offset from either is wrong about half the time.
 *
 * So: push chain time forward by two seconds, mine an empty block, and publish
 * at exactly its timestamp. That satisfies all three — the two seconds keep it
 * ahead of the previous push, and the push itself lands in the very next block.
 */
async function pushPrice(client: PublicClient, contracts: ProtocolContracts, price: bigint) {
  await client.request({ method: "evm_increaseTime", params: [2] } as never);
  await client.request({ method: "evm_mine" } as never);
  const publishTime = (await client.getBlock({ blockTag: "latest" })).timestamp;
  const hash = await wallet(PUBLISHER).writeContract({
    address: contracts.oracleAdapter,
    abi: oracleAdapterAbi,
    functionName: "pushPrices",
    args: [[oracleId("BTC")], [price], [0n], publishTime],
    chain,
    account: PUBLISHER,
    ...FEES,
  });
  await client.waitForTransactionReceipt({ hash });
}

async function fund(client: PublicClient, contracts: ProtocolContracts, who: HDAccount, usdc6: bigint) {
  const approve = await wallet(who).writeContract({
    address: NETWORK.usdc,
    abi: [
      {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint256" }],
        outputs: [{ type: "bool" }],
      },
    ] as const,
    functionName: "approve",
    args: [contracts.vault, usdc6],
    chain,
    account: who,
    ...FEES,
  });
  await client.waitForTransactionReceipt({ hash: approve });
  const deposit = await wallet(who).writeContract({
    address: contracts.vault,
    abi: vaultAbi,
    functionName: "deposit",
    args: [usdc6],
    chain,
    account: who,
    ...FEES,
  });
  await client.waitForTransactionReceipt({ hash: deposit });
}

// ─── database setup ──────────────────────────────────────────────────────────

/**
 * Seed `Market` from the chain, exactly as the indexer's `MarketParamsSet`
 * handler would. The matcher reads its floor and band from this row, so taking
 * it from `RiskParams` keeps the E2E honest about where the numbers come from.
 */
async function seedMarket(db: Db, client: PublicClient, contracts: ProtocolContracts) {
  const p = await client.readContract({
    address: contracts.riskParams,
    abi: riskParamsAbi,
    functionName: "market",
    args: [MARKET_ID],
  });
  await db.query(
    `INSERT INTO "Market" ("network", "id", "symbol", "oracleId", "active", "params", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT ("network", "id") DO UPDATE SET "params" = EXCLUDED."params", "active" = EXCLUDED."active"`,
    [
      NET,
      MARKET_ID,
      SYMBOL,
      (p.oracleId as string).toLowerCase(),
      p.active,
      JSON.stringify({
        oracleId: (p.oracleId as string).toLowerCase(),
        minFillNotional: p.minFillNotional.toString(),
        maxExecutionDeviationBps: p.maxExecutionDeviationBps,
        maxOracleAge: p.maxOracleAge,
        maxOracleConfidenceBps: p.maxOracleConfidenceBps,
      }),
    ]
  );
  return p;
}

let nextNonce = 1n;

async function placeOrder(
  db: Db,
  contracts: ProtocolContracts,
  who: HDAccount,
  isLong: boolean,
  size: bigint,
  limitPrice: bigint,
  createdAt: Date
): Promise<Hex> {
  const order: Order = {
    owner: getAddress(who.address),
    marketId: MARKET_ID,
    isLong,
    size,
    limitPrice,
    reduceOnly: false,
    nonce: nextNonce++,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    referrer: zeroAddress,
  };
  const orderHash = hashOrder(NETWORK.chainId, contracts.orderGateway, order);
  const signature = await who.signTypedData(orderTypedData(NETWORK.chainId, contracts.orderGateway, order));

  await db.query(
    `INSERT INTO "Account" ("network", "address", "updatedAt") VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
    [NET, order.owner.toLowerCase()]
  );
  await db.query(
    `INSERT INTO "Order" ("orderHash", "network", "owner", "marketId", "isLong", "size", "limitPrice",
                          "reduceOnly", "nonce", "expiry", "referrer", "signature", "status",
                          "filledSize", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, $11, 'OPEN', 0, $12, now())`,
    [
      orderHash.toLowerCase(),
      NET,
      order.owner.toLowerCase(),
      MARKET_ID,
      isLong,
      size.toString(),
      limitPrice.toString(),
      order.nonce.toString(),
      order.expiry.toString(),
      zeroAddress,
      signature.toLowerCase(),
      createdAt,
    ]
  );
  return orderHash.toLowerCase() as Hex;
}

/** Ask first, bid second, so the ask is the maker and sets the price. */
let arrival = 0;
async function cross(
  db: Db,
  contracts: ProtocolContracts,
  opts: { askSize: bigint; bidSize: bigint; price: bigint; seller?: HDAccount; buyer?: HDAccount }
) {
  const base = Date.now() - 3_600_000;
  const ask = await placeOrder(
    db,
    contracts,
    opts.seller ?? ALICE,
    false,
    opts.askSize,
    opts.price,
    new Date(base + arrival++ * 1000)
  );
  const bid = await placeOrder(
    db,
    contracts,
    opts.buyer ?? BOB,
    true,
    opts.bidSize,
    opts.price,
    new Date(base + 1_800_000 + arrival++ * 1000)
  );
  return { ask, bid };
}

// ─── assertions ──────────────────────────────────────────────────────────────

async function positionOf(client: PublicClient, contracts: ProtocolContracts, who: Address): Promise<bigint> {
  const p = await client.readContract({
    address: contracts.engine,
    abi: engineAbi,
    functionName: "getPosition",
    args: [who, MARKET_ID],
  });
  return (p as { size: bigint }).size;
}

async function settledFills(db: Db) {
  return db.query(
    `SELECT "fillId", "status", "rejectReason", "size"::text AS size, "price"::text AS price,
            "maker", "taker", "txJobId"
     FROM "Fill" WHERE "network" = $1 ORDER BY "id"`,
    [NET]
  );
}

/** What the gateway's own logs say settled, for the same batch. */
async function onChainFilled(
  client: PublicClient,
  contracts: ProtocolContracts,
  who: HDAccount,
  nonce: bigint
): Promise<bigint> {
  return client.readContract({
    address: contracts.orderGateway,
    abi: orderGatewayAbi,
    functionName: "filled",
    args: [getAddress(who.address), nonce],
  });
}

// ─── the run ─────────────────────────────────────────────────────────────────

async function main() {
  assertLocalOnly();
  const dbUrl = process.env.KRYON_E2E_DATABASE_URL;
  if (!dbUrl) throw new Error("KRYON_E2E_DATABASE_URL is not set (a migrated, disposable database)");

  const anvil = await startAnvil();
  const client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
  const db = pgDb(dbUrl);

  try {
    const contracts = await deploy();

    step("funding traders and pushing the index price");
    // 5,000 of each account's 10,000 USDC: the per-account deposit cap is the
    // whole balance, and the approve transaction spends a little of it on gas.
    await fund(client, contracts, ALICE, 5_000_000_000n);
    await fund(client, contracts, BOB, 5_000_000_000n);
    await pushPrice(client, contracts, INDEX_PRICE);
    log(`  index $${formatUnits(INDEX_PRICE, 18)}, Alice and Bob funded with 5,000 USDC each`);

    await db.query(`TRUNCATE "Fill", "Order", "Position", "Account", "Market" CASCADE`);
    const params = await seedMarket(db, client, contracts);
    log(`  minFillNotional ${formatUnits(params.minFillNotional, 18)}, band ${params.maxExecutionDeviationBps} bps`);

    const sender = new TxSender({
      network: NETWORK,
      service: "matcher",
      chain: client,
      signer: OPERATOR,
      store: new MemoryTxJobStore(),
      pollMs: 100,
    });
    const newMatcher = (logger: Logger = recordingLogger(process.env.KRYON_E2E_VERBOSE ? verbose : silent)) =>
      new Matcher({
        db,
        network: NETWORK,
        contracts,
        chain: client,
        sender,
        marketIds: [MARKET_ID],
        log: logger,
        pollMs: 100,
      });

    // ── 1. a simple cross ───────────────────────────────────────────────────
    step("scenario 1: a simple cross");
    await cross(db, contracts, { askSize: UNIT, bidSize: UNIT, price: INDEX_PRICE });
    await pushPrice(client, contracts, INDEX_PRICE);
    let matcher = newMatcher();
    await matcher.tick();

    let rows = await settledFills(db);
    eq("one fill was written", rows.length, 1);
    eq("the matcher left it PENDING for the indexer", rows[0]?.status, "PENDING");
    eq("no reject reason", rows[0]?.rejectReason, null);
    check("the fill is linked to its TxJob", Boolean(rows[0]?.txJobId));
    eq("the fill size matches the match", rows[0]?.size, UNIT.toString());
    eq("Alice is short one unit on-chain", await positionOf(client, contracts, getAddress(ALICE.address)), -UNIT);
    eq("Bob is long one unit on-chain", await positionOf(client, contracts, getAddress(BOB.address)), UNIT);
    eq("the gateway agrees the ask is filled", await onChainFilled(client, contracts, ALICE, 1n), UNIT);
    eq("the settled batch used one fill", matcher.metrics.fillsSettled, 1);
    log(`  gas ${matcher.metrics.lastBatchGasUsed} for ${matcher.metrics.lastBatchFills} fill(s), ` +
        `${matcher.metrics.lastGasPerFill} per fill`);

    // ── 2. a partial fill ───────────────────────────────────────────────────
    step("scenario 2: a partial fill");
    const two = await cross(db, contracts, { askSize: 5n * UNIT, bidSize: 2n * UNIT, price: INDEX_PRICE });
    await pushPrice(client, contracts, INDEX_PRICE);
    matcher = newMatcher();
    await matcher.tick();

    rows = await settledFills(db);
    eq("a second fill was written", rows.length, 2);
    eq("it is the smaller of the two sizes", rows[1]?.size, (2n * UNIT).toString());
    eq("the gateway filled 2 of the ask's 5", await onChainFilled(client, contracts, ALICE, 3n), 2n * UNIT);
    const remainder = await db.query(
      `SELECT "size"::text AS size, "filledSize"::text AS "filledSize" FROM "Order" WHERE "orderHash" = $1`,
      [two.ask]
    );
    check(
      "the remainder is still on the book",
      BigInt(String(remainder[0].size)) > BigInt(String(remainder[0].filledSize)) + 0n
    );

    // ── 3. a rejected fill among good ones ──────────────────────────────────
    step("scenario 3: a rejected fill in the same batch as a good one");
    await db.query(`DELETE FROM "Fill" WHERE "network" = $1 AND "status" = 'PENDING'`, [NET]);
    await db.query(`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "network" = $1 AND "status" = 'OPEN'`, [NET]);
    await cross(db, contracts, { askSize: UNIT, bidSize: UNIT, price: INDEX_PRICE });
    // Mallory has no collateral, so her fill reverts InsufficientCollateral
    // inside the gateway's try/catch while the good fill still settles.
    await cross(db, contracts, {
      askSize: UNIT,
      bidSize: UNIT,
      price: INDEX_PRICE,
      seller: MALLORY,
      buyer: BOB,
    });
    await pushPrice(client, contracts, INDEX_PRICE);
    matcher = newMatcher();
    await matcher.tick();

    const batch = await db.query(
      `SELECT "fillId", "rejectReason" FROM "Fill" WHERE "network" = $1 AND "status" = 'PENDING' ORDER BY "id"`,
      [NET]
    );
    eq("both fills went into one batch", matcher.metrics.lastBatchFills, 2);
    eq("one settled", matcher.metrics.fillsSettled, 1);
    eq("one was rejected", matcher.metrics.fillsRejected, 1);
    check(
      "the rejection is recorded with its decoded reason",
      batch.some((r) => typeof r.rejectReason === "string" && r.rejectReason.length > 0),
      JSON.stringify(batch.map((r) => r.rejectReason))
    );
    check(
      "the matcher never wrote a SETTLED or REJECTED status",
      (await db.query(`SELECT COUNT(*)::int AS n FROM "Fill" WHERE "network" = $1 AND "status" <> 'PENDING'`, [NET]))[0]
        .n === 0
    );
    check("Mallory has no position", (await positionOf(client, contracts, getAddress(MALLORY.address))) === 0n);

    // ── 4. a batch above the 40-fill cap ────────────────────────────────────
    step("scenario 4: 45 matches, split at the 40-fill cap");
    await db.query(`DELETE FROM "Fill" WHERE "network" = $1 AND "status" = 'PENDING'`, [NET]);
    await db.query(`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "network" = $1 AND "status" = 'OPEN'`, [NET]);
    for (let i = 0; i < 45; i++) {
      await cross(db, contracts, { askSize: UNIT, bidSize: UNIT, price: INDEX_PRICE });
    }
    await pushPrice(client, contracts, INDEX_PRICE);
    matcher = newMatcher();
    const gasBefore = batchGas.length;
    await matcher.tick();

    eq("45 fills were submitted", matcher.metrics.fillsSubmitted, 45);
    eq("45 fills settled", matcher.metrics.fillsSettled, 45);
    eq("in two batches", matcher.metrics.batches, 2);
    check(
      "the larger batch was the 40-fill cap",
      matcher.metrics.maxSettledBatchFills === 40,
      `max batch was ${matcher.metrics.maxSettledBatchFills}`
    );
    check("no batch reverted", matcher.metrics.batchReverts === 0);
    for (const b of batchGas.slice(gasBefore)) {
      log(`  batch of ${String(b.fills).padStart(2)} fills: ${b.gasUsed} gas, ${b.gasPerFill} per fill`);
    }

    // ── 5. an order outside the oracle band ─────────────────────────────────
    step("scenario 5: a cross outside the execution band");
    await db.query(`DELETE FROM "Fill" WHERE "network" = $1 AND "status" = 'PENDING'`, [NET]);
    await db.query(`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "network" = $1 AND "status" = 'OPEN'`, [NET]);
    // 5% above the index: far outside BTC-PERP's 75 bps band.
    await cross(db, contracts, { askSize: UNIT, bidSize: UNIT, price: (INDEX_PRICE * 105n) / 100n });
    await pushPrice(client, contracts, INDEX_PRICE);
    matcher = newMatcher();
    await matcher.tick();

    eq("nothing was submitted", matcher.metrics.fillsSubmitted, 0);
    eq(
      "no fill row was written",
      (await db.query(`SELECT COUNT(*)::int AS n FROM "Fill" WHERE "network" = $1`, [NET]))[0].n,
      0
    );
    eq(
      "and both orders are still open",
      (
        await db.query(`SELECT COUNT(*)::int AS n FROM "Order" WHERE "network" = $1 AND "status" = 'OPEN'`, [NET])
      )[0].n,
      2
    );

    // ── invariants ──────────────────────────────────────────────────────────
    step("invariants");
    const [assets, liabilities] = await client.readContract({
      address: contracts.vault,
      abi: vaultAbi,
      functionName: "solvency",
    });
    check(
      "Vault.solvency() holds: assets >= liabilities",
      assets >= liabilities,
      `assets ${assets} < liabilities ${liabilities}`
    );

    const alice = await positionOf(client, contracts, getAddress(ALICE.address));
    const bob = await positionOf(client, contracts, getAddress(BOB.address));
    check("Alice's and Bob's positions net to zero", alice + bob === 0n, `${alice} + ${bob}`);

    const dbSizes = await db.query(
      `SELECT COALESCE(SUM("size"), 0)::text AS total FROM "Fill" WHERE "network" = $1 AND "status" = 'PENDING'`,
      [NET]
    );
    log(`  pending fill size in the database: ${dbSizes[0].total}`);

    step("measured gas");
    for (const b of batchGas) {
      log(`  ${String(b.fills).padStart(2)} fill(s): ${String(b.gasUsed).padStart(9)} gas, ${b.gasPerFill} per fill`);
    }
  } finally {
    await db.end().catch(() => undefined);
    if (!process.env.KRYON_E2E_KEEP_ANVIL) anvil.kill("SIGTERM");
  }

  step(failures === 0 ? "PASS" : `FAIL (${failures} check${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
