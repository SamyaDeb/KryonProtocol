#!/usr/bin/env tsx
/**
 * add-market.ts — register a perpetual market against the ALREADY-DEPLOYED
 * contracts. No redeploy, no new WASM, no upload fees.
 *
 * Adding a market is two admin calls per market:
 *
 *   1. oracle-adapter.set_feed(SYMBOL, publisher, source, guard, active)
 *        One per distinct BASE ASSET. Skipped automatically when a feed for
 *        the asset already exists (several markets can share a base asset).
 *
 *   2. engine.set_market(EngineMarketConfig)
 *        This internally calls vault.set_market_config (perp-engine/src/lib.rs:110),
 *        so — unlike mainnet-deploy.ts, which does both — there is deliberately
 *        NO separate vault call here. The second call was always redundant.
 *
 * On perp-risk.set_market: DELIBERATELY NOT CALLED. It exists
 * (perp-risk/src/lib.rs:52) but was never called for market 1 either, and its
 * MarketSnapshot carries a live `oracle_price` that would be stale the moment
 * it is written. Registering markets 2–8 there while market 1 is absent would
 * leave the risk contract holding a partial, half-stale view of the venue —
 * worse than the current consistent non-use. If it is ever adopted it must be
 * adopted for every market at once, with a keeper refreshing the snapshots.
 *
 * Every step checkpoints to infra/deploy/<network>-markets.json, so a run that
 * dies halfway resumes instead of re-submitting.
 *
 * Usage:
 *   npx tsx scripts/add-market.ts --market SOL-PERP --dry-run
 *   npx tsx scripts/add-market.ts --all --dry-run
 *   npx tsx scripts/add-market.ts --all --emit-governance   # write queue payloads
 *   GOVERNANCE_ADMIN_SECRET=S... npx tsx scripts/add-market.ts --all --queue
 *       Actually SUBMITS governance.queue for every planned call and starts the
 *       timelock. After min_delay elapses, run --execute to land them.
 *   GOVERNANCE_ADMIN_SECRET=S... npx tsx scripts/add-market.ts --all --execute
 *   MARKET_ADMIN_SECRET=S... npx tsx scripts/add-market.ts --market SOL-PERP
 *
 * IMPORTANT — admin is usually the governance contract, not a keypair.
 * Testnet and mainnet both transferred admin to perp-governance, which has a
 * min_delay timelock (48h on mainnet). Direct submission only works while a
 * keypair is still admin. `--emit-governance` writes the queue payloads
 * instead; `--check` reads back who the admin actually is before you assume.
 */

import {
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { ACTIVE_MARKETS, MARKETS, CONTRACTS, NETWORK, type MarketConfig } from "../config";

const PRECISION = BigInt("1000000000000000000"); // 1e18
const FEE = "2000000"; // 0.2 XLM max inclusion

// Must match the on-chain OracleGuard the keeper publishes against. Do NOT
// raise max_age_secs to accommodate a slower feed — see MULTI-MARKET-PLAN §12.
const MAX_ORACLE_AGE_SECS = BigInt(process.env.MARKET_MAX_ORACLE_AGE_SECS ?? "120");
const MAX_ORACLE_CONFIDENCE_BPS = Number(process.env.MARKET_MAX_ORACLE_CONFIDENCE_BPS ?? "1000");
const MAX_EXECUTION_DEVIATION_BPS = Number(process.env.MARKET_MAX_EXECUTION_DEVIATION_BPS ?? "1000");

// Overridable, because the default is one file per NETWORK — not per
// deployment. Registering markets against a second deployment on the same
// network reads the first one's checkpoints, decides every market is already
// registered, and exits reporting success having done nothing. Same failure the
// deploy scripts had with their own state and secrets paths.
const STATE_PATH = process.env.MARKETS_STATE_PATH
  ? path.resolve(process.env.MARKETS_STATE_PATH)
  : path.resolve(
      __dirname,
      `../../kryon-protocol/infra/deploy/${NETWORK.name}-markets.json`
    );

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const ALL = argv.includes("--all");
const EMIT_GOV = argv.includes("--emit-governance");
// --queue actually SUBMITS governance.queue for every planned call. It starts
// the timelock; it is not a rehearsal. Requires GOVERNANCE_ADMIN_SECRET.
const QUEUE_GOV = argv.includes("--queue");
const EXEC_GOV = argv.includes("--execute");
const CHECK = argv.includes("--check");
const marketArgs = argv.reduce<string[]>((acc, a, i) => {
  if (a === "--market" && argv[i + 1]) acc.push(argv[i + 1].toUpperCase());
  return acc;
}, []);

// ── ScVal helpers (shapes proven in mainnet-deploy.ts) ────────────────────────
const addr = (a: string) => new Address(a).toScVal();
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const u64 = (n: bigint) => nativeToScVal(n, { type: "u64" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const boolv = (b: boolean) => xdr.ScVal.scvBool(b);
const entry = (k: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(k), val });

function oracleGuard(): xdr.ScVal {
  return xdr.ScVal.scvMap([
    entry("max_age_secs", u64(MAX_ORACLE_AGE_SECS)),
    entry("max_confidence_bps", u32(MAX_ORACLE_CONFIDENCE_BPS)),
  ]);
}

/**
 * protocol_core::MarketConfig. Map keys MUST be in the Soroban-canonical
 * (lexicographic by symbol) order the contract expects — same ordering as
 * mainnet-deploy.ts:437.
 */
function coreMarketConfig(m: MarketConfig): xdr.ScVal {
  return xdr.ScVal.scvMap([
    entry("active", boolv(true)),
    entry("base_asset", sym(m.oracleSymbol)),
    entry("initial_margin_bps", u32(m.initialMarginBps)),
    entry("liquidation_fee_bps", u32(m.liquidationFeeBps)),
    entry("maintenance_margin_bps", u32(m.maintenanceMarginBps)),
    entry("market_id", u32(m.marketId)),
    entry("max_leverage_bps", u32(m.maxLeverageBps)),
    entry("max_open_interest", i128(PRECISION * BigInt(m.maxOpenInterestBase))),
    entry("max_oracle_age_secs", u64(MAX_ORACLE_AGE_SECS)),
    entry("max_oracle_confidence_bps", u32(MAX_ORACLE_CONFIDENCE_BPS)),
    entry("settlement_asset", addr(m.settlementAsset)),
  ]);
}

function engineMarketConfig(m: MarketConfig): xdr.ScVal {
  return xdr.ScVal.scvMap([
    entry("market", coreMarketConfig(m)),
    entry("max_execution_deviation_bps", u32(MAX_EXECUTION_DEVIATION_BPS)),
  ]);
}

// ── checkpoint ledger ─────────────────────────────────────────────────────────
type State = { steps?: Record<string, boolean>; eta?: number };
function loadState(): State {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}
function saveState(s: State) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── chain I/O ─────────────────────────────────────────────────────────────────
//
// Neither perp-engine nor perp-oracle-adapter exposes an `admin` / `market` /
// `feed` getter, so existence and ownership are read from the ledger entries
// themselves. This is what the runbook means by "verify the actual current
// admin before assuming anything" — a getter could not be trusted here even if
// one existed, because the governance ceremony completed unevenly across
// contracts.

/** Persistent contract-data entry for a DataKey, or null when absent. */
async function readPersistent(
  server: sorobanRpc.Server,
  contractId: string,
  key: xdr.ScVal
): Promise<unknown | null> {
  try {
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contractId).toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent(),
      })
    );
    const res = await server.getLedgerEntries(ledgerKey);
    const entry = res.entries?.[0];
    if (!entry) return null;
    return scValToNative(entry.val.contractData().val());
  } catch {
    return null;
  }
}

/**
 * A contract's instance storage map, keyed by DataKey variant name. Returns
 * null when the instance entry itself cannot be read (archived, or bad id).
 */
async function readInstanceStorage(
  server: sorobanRpc.Server,
  contractId: string
): Promise<Record<string, unknown> | null> {
  try {
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );
    const res = await server.getLedgerEntries(ledgerKey);
    const entry = res.entries?.[0];
    if (!entry) return null;
    const instance = entry.val.contractData().val().instance();
    const storage = instance.storage();
    if (!storage) return null;
    const out: Record<string, unknown> = {};
    for (const e of storage) {
      // Unit DataKey variants (Admin, Vault, …) encode as a 1-element vec.
      const k = e.key();
      let name: string | null = null;
      if (k.switch().name === "scvVec") {
        const first = k.vec()?.[0];
        if (first && first.switch().name === "scvSymbol") name = first.sym().toString();
      } else if (k.switch().name === "scvSymbol") {
        name = k.sym().toString();
      }
      if (name) out[name] = scValToNative(e.val());
    }
    return out;
  } catch {
    return null;
  }
}

/** DataKey::Market(u32) — a 2-element vec of [variant symbol, payload]. */
const dkMarket = (marketId: number) => xdr.ScVal.scvVec([sym("Market"), u32(marketId)]);
/** DataKey::Config(Symbol) on the oracle adapter. */
const dkFeedConfig = (asset: string) => xdr.ScVal.scvVec([sym("Config"), sym(asset)]);

async function submit(
  server: sorobanRpc.Server,
  kp: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  label: string,
  /**
   * Contract error codes to treat as success rather than failure.
   *
   * Call sites were already passing this — `[1]` for AlreadyInitialized when a
   * proposal id is re-queued — but the parameter did not exist, so the argument
   * was silently discarded and the script aborted on a re-run instead of
   * continuing past work it had already done. `scripts/` being excluded from
   * tsconfig is why the arity mismatch was never reported.
   */
  tolerateErrorCodes: number[] = []
): Promise<void> {
  process.stdout.write(`  [${label}] `);

  // A dry run still SIMULATES. That is the whole point: simulation is what
  // validates the ScVal shapes against the deployed contract's expected types.
  // Since the admin is the governance contract, the best possible outcome here
  // is Unauthorized (#2) — which means the arguments decoded cleanly and only
  // the auth check stopped it. An InvalidConfig (#5) or an XDR/type error
  // means the payload itself is wrong and would fail 48h later at execute().
  const source = DRY ? Keypair.random().publicKey() : kp.publicKey();
  const account = DRY
    ? new (await import("@stellar/stellar-sdk")).Account(source, "1")
    : await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    const err = (sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error ?? "";
    // #2 = Unauthorized: the args decoded, only the admin check refused.
    const unauthorized = err.includes("Error(Contract, #2)");
    const tolerated = tolerateErrorCodes.find((code) =>
      err.includes(`Error(Contract, #${code})`)
    );
    if (tolerated !== undefined) {
      console.log(`✓ already done (contract error #${tolerated}, tolerated)`);
      return;
    }
    if (DRY && unauthorized) {
      console.log("✓ args valid (rejected only by admin check, as expected)");
      return;
    }
    if (DRY) {
      throw new Error(
        `${label} PAYLOAD INVALID — simulation failed for a reason other than auth. ` +
        `Fix this now; queued as-is it would fail at execute() after the timelock.\n    ${err.slice(0, 300)}`
      );
    }
    if (unauthorized) {
      throw new Error(
        `${label} rejected as Unauthorized. The admin is the governance contract, ` +
        `not this keypair — rerun with --emit-governance and queue it.`
      );
    }
    throw new Error(`${label} simulation failed: ${err.slice(0, 300)}`);
  }

  if (DRY) { console.log("✓ args valid (simulation succeeded — not submitted)"); return; }

  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") {
    throw new Error(`${label} submit error: ${send.errorResult?.toXDR("base64")?.slice(0, 120)}`);
  }
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") { console.log(`✓ ${send.hash.slice(0, 12)}`); return; }
    if (poll.status === "FAILED") throw new Error(`${label} FAILED on-chain: ${send.hash}`);
  }
  throw new Error(`${label}: confirmation timeout (hash ${send.hash})`);
}

// ── governance payload emission ───────────────────────────────────────────────
interface GovCall {
  key: string;
  target: string;
  targetName: string;
  action: string;
  args: xdr.ScVal[];
}

/**
 * governance.queue(id, target, action, args, wasm_hash, eta).
 * `id` is a deterministic BytesN<32> derived from the call so re-emitting the
 * same proposal produces the same id — queue() rejects a duplicate id, which
 * is the desired guard against accidentally queueing a market twice.
 */
function emitGovernance(calls: GovCall[], minDelaySecs: number) {
  const eta = Math.floor(Date.now() / 1000) + minDelaySecs + 600; // +10min margin
  const out = calls.map((c) => {
    const id = crypto.createHash("sha256")
      .update(`${NETWORK.name}|${c.target}|${c.action}|${c.key}`)
      .digest("hex");
    return {
      key: c.key,
      proposal_id_hex: id,
      target: c.target,
      target_name: c.targetName,
      action: c.action,
      args_xdr: c.args.map((a) => a.toXDR("base64")),
      wasm_hash_hex: "00".repeat(32), // not an upgrade proposal
      eta,
      eta_iso: new Date(eta * 1000).toISOString(),
    };
  });

  const file = path.resolve(
    __dirname,
    `../../kryon-protocol/infra/deploy/${NETWORK.name}-market-proposals.json`
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    network: NETWORK.name,
    governance: CONTRACTS.governance,
    min_delay_secs: minDelaySecs,
    generated_at: new Date().toISOString(),
    note:
      "Queue each proposal against the governance contract, wait for min_delay, " +
      "then call governance.execute(id). Verify the current admin of every target " +
      "contract BEFORE queueing — the governance ceremony has a history of " +
      "partial completion across contracts.",
    proposals: out,
  }, null, 2));

  console.log(`\n  ✓ wrote ${out.length} governance proposal(s) → ${path.relative(process.cwd(), file)}`);
  console.log(`    earliest execute: ${new Date(eta * 1000).toISOString()} (min_delay ${minDelaySecs}s)`);
  for (const p of out) {
    console.log(`      · ${p.key.padEnd(28)} ${p.target_name}.${p.action}  id=${p.proposal_id_hex.slice(0, 16)}…`);
  }
}

/** 32-byte proposal id, deterministic in the call — re-emitting is idempotent. */
function proposalId(c: GovCall): Buffer {
  return crypto.createHash("sha256").update(`${NETWORK.name}|${c.target}|${c.action}|${c.key}`).digest();
}

const bytesN = (b: Buffer) => xdr.ScVal.scvBytes(b);

/**
 * Submit governance.queue(id, target, action, args, wasm_hash, eta) per call.
 *
 * A duplicate id is rejected by the contract with AlreadyInitialized (#1),
 * which is exactly the guard we want against queueing a market twice — so it
 * is tolerated and reported as "already queued" rather than failing the run.
 */
async function queueProposals(
  server: sorobanRpc.Server,
  kp: Keypair,
  calls: GovCall[],
  minDelaySecs: number,
  state: State,
  mark: (k: string) => void,
  done: (k: string) => boolean
) {
  // queue() requires eta >= now + min_delay. Add a margin so the ledger's clock
  // advancing between build and apply cannot push us under the floor.
  const eta = BigInt(Math.floor(Date.now() / 1000) + minDelaySecs + 900);
  console.log(`\n  eta: ${new Date(Number(eta) * 1000).toISOString()} (min_delay ${minDelaySecs}s + 15min margin)\n`);

  for (const c of calls) {
    const key = `queued:${c.key}`;
    if (done(key)) { console.log(`  [${key}] ✓ already queued (checkpoint)`); continue; }
    const id = proposalId(c);
    await submit(
      server, kp, CONTRACTS.governance, "queue",
      [
        bytesN(id),
        addr(c.target),
        sym(c.action),
        xdr.ScVal.scvVec(c.args),
        bytesN(Buffer.alloc(32)), // not an upgrade proposal
        u64(eta),
      ],
      key,
      [1] // AlreadyInitialized — this proposal id is already queued
    );
    // NEVER checkpoint a dry run: submit() returns without submitting, so
    // marking here would make the subsequent REAL run skip every proposal.
    if (!DRY) mark(key);
  }

  if (DRY) {
    console.log(`\n  (dry run — ${calls.length} proposal(s) validated, nothing queued, no checkpoints written)`);
    return;
  }

  state.eta = Number(eta);
  saveState(state);
  console.log(`\n  ✓ ${calls.length} proposal(s) queued.`);
  console.log(`    Execute after ${new Date(Number(eta) * 1000).toISOString()} with:`);
  console.log(`      GOVERNANCE_ADMIN_SECRET=S... npx tsx scripts/add-market.ts --all --execute`);
}

/** Execute every matured proposal. */
async function executeProposals(
  server: sorobanRpc.Server,
  kp: Keypair,
  calls: GovCall[],
  state: State,
  mark: (k: string) => void,
  done: (k: string) => boolean
) {
  const eta = state.eta;
  if (eta && Date.now() / 1000 < eta) {
    const remaining = Math.ceil((eta - Date.now() / 1000) / 3600);
    throw new Error(
      `timelock has not elapsed — earliest execute is ${new Date(eta * 1000).toISOString()} ` +
      `(~${remaining}h away). governance.execute would revert with Unauthorized.`
    );
  }
  for (const c of calls) {
    const key = `executed:${c.key}`;
    if (done(key)) { console.log(`  [${key}] ✓ already executed (checkpoint)`); continue; }
    await submit(server, kp, CONTRACTS.governance, "execute", [bytesN(proposalId(c))], key);
    if (!DRY) mark(key);
  }
  if (DRY) {
    console.log(`\n  (dry run — nothing executed, no checkpoints written)`);
    return;
  }
  console.log(`\n  ✓ executed. Verify with: npx tsx scripts/add-market.ts --all --check`);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const selected: MarketConfig[] = ALL
    ? Object.values(ACTIVE_MARKETS)
    : marketArgs.map((s) => {
        const m = MARKETS[s];
        if (!m) throw new Error(`Unknown market "${s}". Known: ${Object.keys(MARKETS).join(", ")}`);
        return m;
      });

  if (!CHECK && selected.length === 0) {
    console.error("Nothing to do. Pass --all or --market <SYMBOL> (repeatable), or --check.");
    process.exit(1);
  }

  const server = new sorobanRpc.Server(NETWORK.rpcUrl);

  console.log("════════════════════════════════════════════════");
  console.log("  KRYON — MARKET REGISTRATION");
  console.log(`  network : ${NETWORK.name}`);
  console.log(`  engine  : ${CONTRACTS.engine}`);
  console.log(`  oracle  : ${CONTRACTS.oracleAdapter}`);
  console.log(`  mode    : ${DRY ? "DRY RUN" : QUEUE_GOV ? "QUEUE GOVERNANCE (submits!)" : EMIT_GOV ? "EMIT GOVERNANCE" : CHECK ? "CHECK" : "SUBMIT"}`);
  console.log("════════════════════════════════════════════════\n");

  // ── who is actually admin? Read instance storage; never trust the runbook. ─
  console.log("Admin (read from instance storage, not a getter):");
  let adminIsGovernance = false;
  for (const [name, id] of [["oracle-adapter", CONTRACTS.oracleAdapter], ["engine", CONTRACTS.engine]] as const) {
    const storage = await readInstanceStorage(server, id);
    const a = storage?.["Admin"];
    if (!a) {
      console.log(`  ${name.padEnd(15)} unreadable (instance archived, or RPC failure)`);
      continue;
    }
    const viaGov = String(a) === CONTRACTS.governance;
    adminIsGovernance ||= viaGov;
    console.log(`  ${name.padEnd(15)} ${String(a)}${viaGov ? "   ← governance (TIMELOCKED)" : "   ← keypair"}`);
    const pending = storage?.["PendingAdmin"];
    if (pending) console.log(`  ${"".padEnd(15)} pending: ${String(pending)} (nominated, not yet accepted)`);
  }
  if (adminIsGovernance && !EMIT_GOV && !DRY && !CHECK) {
    console.log("\n  ⚠ admin is the governance contract — direct submission will be rejected.");
    console.log("    Use --emit-governance to produce queue payloads instead.");
  }
  console.log("");

  // ── existing on-chain state ───────────────────────────────────────────────
  console.log("Current on-chain registration:");
  const feedExists = new Map<string, boolean>();
  const marketExists = new Map<number, boolean>();
  for (const m of selected) {
    if (!feedExists.has(m.oracleSymbol)) {
      const feed = await readPersistent(server, CONTRACTS.oracleAdapter, dkFeedConfig(m.oracleSymbol));
      feedExists.set(m.oracleSymbol, feed !== null);
    }
    const mk = await readPersistent(server, CONTRACTS.engine, dkMarket(m.marketId));
    marketExists.set(m.marketId, mk !== null);
    console.log(
      `  ${m.symbol.padEnd(9)} id=${String(m.marketId).padEnd(2)} ` +
      `feed(${m.oracleSymbol.padEnd(3)})=${feedExists.get(m.oracleSymbol) ? "present" : "MISSING"}  ` +
      `engine.market=${marketExists.get(m.marketId) ? "present" : "MISSING"}`
    );
  }
  if (CHECK) return;

  // ── build the call list ───────────────────────────────────────────────────
  const state = loadState();
  state.steps ??= {};
  const done = (k: string) => !!state.steps![k];
  const mark = (k: string) => { state.steps![k] = true; saveState(state); };

  // The feed's publisher must be exactly the account oracle-keeper.ts signs
  // write_price with, so accept either form and derive from the secret when
  // that is all that is configured.
  const publisher =
    process.env.ORACLE_PUBLISHER_ADDRESS ||
    (process.env.ORACLE_PUBLISHER_SECRET
      ? Keypair.fromSecret(process.env.ORACLE_PUBLISHER_SECRET).publicKey()
      : undefined);
  const calls: GovCall[] = [];
  const seenFeeds = new Set<string>();

  for (const m of selected) {
    // 1. oracle feed — one per base asset, shared across markets on that asset
    const feedKey = `feed:${m.oracleSymbol}`;
    if (!seenFeeds.has(m.oracleSymbol) && !feedExists.get(m.oracleSymbol) && !done(feedKey)) {
      seenFeeds.add(m.oracleSymbol);
      if (!publisher) {
        throw new Error(
          `ORACLE_PUBLISHER_ADDRESS is not set — required to register the ${m.oracleSymbol} feed. ` +
          `It must be the same account the oracle keeper signs write_price with.`
        );
      }
      calls.push({
        key: feedKey,
        target: CONTRACTS.oracleAdapter,
        targetName: "oracle-adapter",
        action: "set_feed",
        args: [
          sym(m.oracleSymbol),
          addr(publisher),
          // Single-source under a RedStone label, matching every existing feed.
          // The Reflector cross-check is enforced OFF-chain by the keeper (it
          // simply stops publishing on divergence), so no quorum feed here.
          xdr.ScVal.scvVec([sym("RedStone")]),
          oracleGuard(),
          boolv(true),
        ],
      });
    }

    // 2. engine market — also writes the vault's copy (engine calls
    //    vault.set_market_config internally), so there is no vault call.
    const marketKey = `market:${m.symbol}`;
    if (!marketExists.get(m.marketId) && !done(marketKey)) {
      calls.push({
        key: marketKey,
        target: CONTRACTS.engine,
        targetName: "engine",
        action: "set_market",
        args: [engineMarketConfig(m)],
      });
    }
  }

  if (calls.length === 0) {
    console.log("\n  ✓ nothing to do — every selected market is already registered.");
    return;
  }

  console.log(`\nPlanned calls (${calls.length}):`);
  for (const c of calls) console.log(`  · ${c.key.padEnd(28)} ${c.targetName}.${c.action}`);

  // ── governance path ───────────────────────────────────────────────────────
  if (QUEUE_GOV || EXEC_GOV) {
    const secret = process.env.GOVERNANCE_ADMIN_SECRET;
    if (!secret) {
      throw new Error(
        "GOVERNANCE_ADMIN_SECRET is not set — required to submit governance.queue/execute. " +
        "It must be the governance contract's own Admin (shown above)."
      );
    }
    const govKp = Keypair.fromSecret(secret);
    const govStorage = await readInstanceStorage(server, CONTRACTS.governance);
    const govAdmin = govStorage?.["Admin"];
    if (govAdmin && String(govAdmin) !== govKp.publicKey()) {
      throw new Error(
        `GOVERNANCE_ADMIN_SECRET is ${govKp.publicKey()} but the governance Admin is ${String(govAdmin)} — refusing to submit.`
      );
    }
    if (govStorage?.["Paused"] === true) {
      console.log("\n  ⚠ governance is PAUSED — execute() will be vetoed by the guardian.");
    }
    const minDelay = Number(
      process.env.GOVERNANCE_MIN_DELAY_SECS ?? govStorage?.["MinDelay"] ?? 0
    );
    if (!minDelay) throw new Error("could not read governance MinDelay from chain");

    console.log(`\n  governance : ${CONTRACTS.governance}`);
    console.log(`  admin      : ${govKp.publicKey()}`);
    console.log(`  min_delay  : ${minDelay}s (${(minDelay / 3600).toFixed(0)}h, read from chain)`);

    if (QUEUE_GOV) await queueProposals(server, govKp, calls, minDelay, state, mark, done);
    else await executeProposals(server, govKp, calls, state, mark, done);
    return;
  }

  if (EMIT_GOV) {
    // Read min_delay from the governance contract, not from a toml or a
    // runbook. environments/testnet.toml claimed 3600 while the deployed
    // contract actually holds 172800 — an eta computed from the stale value
    // is below `earliest`, and queue() rejects it as InvalidConfig.
    const govStorage = await readInstanceStorage(server, CONTRACTS.governance);
    const onChainDelay = govStorage?.["MinDelay"];
    const minDelay = Number(process.env.GOVERNANCE_MIN_DELAY_SECS ?? onChainDelay ?? 0);
    if (!minDelay) {
      throw new Error(
        "could not read governance MinDelay from chain — set GOVERNANCE_MIN_DELAY_SECS explicitly"
      );
    }
    if (govStorage?.["Paused"] === true) {
      console.log("\n  ⚠ governance is PAUSED — proposals can be queued but execute() will be vetoed.");
    }
    console.log(`\n  governance admin     : ${String(govStorage?.["Admin"] ?? "unreadable")}`);
    console.log(`  governance min_delay : ${minDelay}s (${(minDelay / 3600).toFixed(0)}h, read from chain)`);
    emitGovernance(calls, minDelay);
    return;
  }

  // ── direct submission ─────────────────────────────────────────────────────
  const secret = process.env.MARKET_ADMIN_SECRET;
  if (!secret && !DRY) {
    console.error(
      "\n❌  MARKET_ADMIN_SECRET is not set.\n" +
      "    Direct submission only works while a KEYPAIR is still admin.\n" +
      "    If the admin check above shows the governance contract, use --emit-governance."
    );
    process.exit(1);
  }
  const kp = secret ? Keypair.fromSecret(secret) : Keypair.random();

  console.log("");
  for (const c of calls) {
    await submit(server, kp, c.target, c.action, c.args, c.key);
    if (!DRY) mark(c.key);
  }

  if (DRY) {
    console.log("\n  (dry run — nothing was submitted; no checkpoints written)");
  } else {
    console.log(`\n  ✓ done. Checkpoints → ${path.relative(process.cwd(), STATE_PATH)}`);
    console.log("    Next: npm run db:seed-markets, then restart the keepers.");
  }
}

main().catch((e) => {
  console.error(`\n❌  ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
