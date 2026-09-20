/**
 * The shape every Kryon keeper shares: config from the environment, a chain-id
 * assertion at startup, one TxSender over a PgTxJobStore, startup recovery of
 * whatever the previous process left in flight, a bounded tick loop, counters
 * and structured logs, and graceful shutdown.
 *
 * Division of responsibility (plan §9): keepers write *intent* — KeeperAction
 * rows and GasSpend roll-ups — and the indexer is the only writer of on-chain
 * truth. Nothing here ever invents a tx hash, a block number or a settled
 * status; a keeper records what it asked for and reads back what the chain and
 * the indexer say happened.
 *
 * One key per process. A TxSender owns its key's nonce, so two processes
 * sharing a key strand each other's transactions.
 */

import { writeFileSync } from "node:fs";
import type { Address } from "viem";

import type { SqlClient } from "@/lib/sql";
import { assertChainId, createArcPublicClient } from "@/lib/chain/clients";
import { loadServiceSigner } from "@/lib/chain/signer";
import { PgTxJobStore } from "@/lib/chain/tx-store-pg";
import { TxSender, type TxSenderOptions } from "@/lib/chain/tx-sender";
import { serverContracts } from "@/lib/chain/contracts-env";
import {
  arcNetwork,
  serverNetworkId,
  type ArcNetwork,
  type Env,
  type ProtocolContracts,
} from "@/lib/chain/networks";

// ─── logging ────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON lines on stdout, so pm2 and any log shipper can parse them. */
export function createLogger(
  service: string,
  minLevel: LogLevel = "info",
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`)
): Logger {
  const at = (level: LogLevel) => (msg: string, fields: Record<string, unknown> = {}) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, service, msg, ...base, ...fields }, replacer));
  };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (fields) => createLogger(service, minLevel, { ...base, ...fields }, sink),
  };
}

/** bigints are routine here (wei, 1e18 sizes) and JSON.stringify throws on them. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// ─── counters ───────────────────────────────────────────────────────────────

/**
 * Monotonic counters and last-value gauges. The monitor session scrapes these;
 * `snapshot()` is also logged at the end of every tick so a crashed process
 * still leaves its last numbers in the log.
 */
export class Metrics {
  private readonly counters = new Map<string, bigint>();
  private readonly gauges = new Map<string, number>();

  inc(name: string, by: bigint | number = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0n) + BigInt(by));
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  snapshot(): { counters: Record<string, string>; gauges: Record<string, number> } {
    return {
      counters: Object.fromEntries([...this.counters].map(([k, v]) => [k, v.toString()])),
      gauges: Object.fromEntries(this.gauges),
    };
  }
}

// ─── clock and shutdown ─────────────────────────────────────────────────────

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      const onAbort = () => done();
      signal?.addEventListener("abort", onAbort, { once: true });
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }
    }),
};

/** SIGINT/SIGTERM → abort, so a tick in flight finishes before the process exits. */
export function shutdownSignal(log: Logger): AbortController {
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      if (controller.signal.aborted) return;
      log.info("shutdown requested, finishing the tick in flight", { signal: sig });
      controller.abort();
    });
  }
  return controller;
}

// ─── tick loop ──────────────────────────────────────────────────────────────

export interface LoopOptions {
  tickMs: number;
  signal: AbortSignal;
  log: Logger;
  metrics: Metrics;
  clock?: Clock;
  /** A tick that overruns this is logged loudly; it is never cancelled mid-flight. */
  warnAfterMs?: number;
  /** Written after every successful tick (default: $KRYON_HEARTBEAT_FILE). */
  heartbeatFile?: string;
}

/**
 * Liveness for container healthchecks: the time of the last successful tick,
 * in a file the orchestrator can stat. A process that is up but failing every
 * tick stops refreshing it and is restarted. Never throws.
 */
export function writeHeartbeat(file: string | undefined = process.env.KRYON_HEARTBEAT_FILE): void {
  if (!file) return;
  try {
    writeFileSync(file, `${Date.now()}\n`);
  } catch {
    // A read-only or missing directory must not take the service down.
  }
}

/**
 * Run `tick` every `tickMs` until aborted. Ticks never overlap: the next one is
 * scheduled after the previous returns, so a slow tick delays rather than
 * doubles up. A throwing tick is logged and the loop continues — a keeper that
 * exits on the first RPC blip is worse than one that retries.
 */
export async function runLoop(o: LoopOptions, tick: () => Promise<void>): Promise<void> {
  const clock = o.clock ?? systemClock;
  const warnAfter = o.warnAfterMs ?? o.tickMs * 3;
  while (!o.signal.aborted) {
    const started = clock.now();
    try {
      await tick();
      o.metrics.inc("ticks_total");
      writeHeartbeat(o.heartbeatFile);
    } catch (err) {
      o.metrics.inc("tick_errors_total");
      o.log.error("tick failed", { error: errorMessage(err) });
    }
    const elapsed = clock.now() - started;
    o.metrics.gauge("tick_duration_ms", elapsed);
    if (elapsed > warnAfter) o.log.warn("tick overran", { elapsedMs: elapsed, tickMs: o.tickMs });
    o.log.debug("tick complete", { elapsedMs: elapsed, ...o.metrics.snapshot() });
    if (o.signal.aborted) break;
    await clock.sleep(Math.max(0, o.tickMs - elapsed), o.signal);
  }
  o.log.info("loop stopped", o.metrics.snapshot());
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const details = (err as { details?: string; shortMessage?: string }).shortMessage;
    return details ? `${err.message} (${details})` : err.message;
  }
  return String(err);
}

// ─── KeeperAction ───────────────────────────────────────────────────────────

export type KeeperActionStatus = "PLANNED" | "SUBMITTED" | "CONFIRMED" | "FAILED" | "SKIPPED";

export interface KeeperActionInput {
  kind: string;
  marketId?: number | null;
  account?: Address | string | null;
  payload: Record<string, unknown>;
  status?: KeeperActionStatus;
  txJobId?: string | null;
}

export interface KeeperActionPatch {
  status?: KeeperActionStatus;
  txJobId?: string | null;
  /** Only ever set from a receipt the process actually read. */
  blockNumber?: bigint | null;
  payload?: Record<string, unknown>;
}

/**
 * KeeperAction rows: what a keeper decided to do, and how that intent ended.
 *
 * `blockNumber` is written only from a receipt this process read; it is never
 * inferred. The authoritative record of what happened on-chain stays with the
 * indexer's event tables, which these rows are reconciled *against*, not
 * substituted for.
 */
export class KeeperActions {
  constructor(
    private readonly sql: SqlClient,
    private readonly network: string
  ) {}

  async record(input: KeeperActionInput): Promise<bigint> {
    const rows = await this.sql.query(
      `INSERT INTO "KeeperAction" ("network", "kind", "marketId", "account", "payload", "status", "txJobId", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::"KeeperActionStatus", $7, now()) RETURNING "id"`,
      [
        this.network,
        input.kind,
        input.marketId ?? null,
        input.account ? String(input.account).toLowerCase() : null,
        JSON.stringify(input.payload, replacer),
        input.status ?? "PLANNED",
        input.txJobId ?? null,
      ]
    );
    return BigInt(rows[0].id);
  }

  async update(id: bigint, patch: KeeperActionPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown, cast = "") => {
      params.push(value);
      sets.push(`"${column}" = $${params.length}${cast}`);
    };
    if (patch.status !== undefined) set("status", patch.status, `::"KeeperActionStatus"`);
    if (patch.txJobId !== undefined) set("txJobId", patch.txJobId);
    if (patch.blockNumber !== undefined)
      set("blockNumber", patch.blockNumber === null ? null : patch.blockNumber.toString());
    if (patch.payload !== undefined) set("payload", JSON.stringify(patch.payload, replacer), "::jsonb");
    if (sets.length === 0) return;
    params.push(id.toString());
    await this.sql.query(
      `UPDATE "KeeperAction" SET ${sets.join(", ")}, "updatedAt" = now() WHERE "id" = $${params.length}`,
      params
    );
  }

  /** Open intents for a kind, so a restarted keeper can finish or fail them. */
  async open(kind: string): Promise<
    Array<{ id: bigint; kind: string; marketId: number | null; account: string | null; payload: Record<string, unknown>; status: KeeperActionStatus; txJobId: string | null }>
  > {
    const rows = await this.sql.query(
      `SELECT "id", "kind", "marketId", "account", "payload", "status", "txJobId"
       FROM "KeeperAction"
       WHERE "network" = $1 AND "kind" = $2 AND "status"::text IN ('PLANNED', 'SUBMITTED')
       ORDER BY "id" ASC`,
      [this.network, kind]
    );
    return rows.map((r) => ({
      id: BigInt(r.id),
      kind: r.kind,
      marketId: r.marketId === null ? null : Number(r.marketId),
      account: r.account ?? null,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      status: r.status as KeeperActionStatus,
      txJobId: r.txJobId ?? null,
    }));
  }
}

// ─── GasSpend ───────────────────────────────────────────────────────────────

/**
 * Daily gas roll-up per service key. Arc's gas token is USDC, so `costWei` is
 * wei of the 18-decimal native USDC and divides by 1e18 to read as dollars.
 *
 * Derived, not accumulated: each call recomputes whole days from `TxJob`,
 * which already carries `gasUsed` and `effectiveGasPrice` for every mined
 * attempt. That matters because most jobs are confirmed by the owning
 * service's own `TxSender.wait()` and never pass through the reconciler, so
 * an "add on my transition" counter would miss nearly all of them. A
 * recompute is also idempotent, so repeated ticks and racing processes
 * cannot double-count.
 *
 * Only CONFIRMED and REVERTED attempts are counted: those are the ones that
 * were mined and paid for. A REPLACED or DROPPED attempt never landed. The
 * day is the job's UTC `createdAt`, which never changes after insert, so a
 * job cannot move between days.
 */
export class GasSpendRollup {
  constructor(
    private readonly sql: SqlClient,
    private readonly network: string
  ) {}

  /** Recompute the given days (default: yesterday, today and tomorrow, UTC). */
  async recompute(days: string[] = recentUtcDays(new Date())): Promise<void> {
    await this.sql.query(
      `INSERT INTO "GasSpend" ("network", "day", "service", "fromAddress", "txCount", "gasUsed", "costWei", "updatedAt")
       SELECT "network", "createdAt"::date, "service", lower("fromAddress"),
              COUNT(*), SUM("gasUsed"), SUM("gasUsed" * "effectiveGasPrice"), now()
       FROM "TxJob"
       WHERE "network" = $1
         AND "createdAt"::date = ANY($2::date[])
         AND "status"::text IN ('CONFIRMED', 'REVERTED')
         AND "gasUsed" IS NOT NULL AND "effectiveGasPrice" IS NOT NULL
       GROUP BY 1, 2, 3, 4
       ON CONFLICT ("network", "day", "service", "fromAddress") DO UPDATE SET
         "txCount" = EXCLUDED."txCount",
         "gasUsed" = EXCLUDED."gasUsed",
         "costWei" = EXCLUDED."costWei",
         "updatedAt" = now()`,
      [this.network, days]
    );
  }
}

/**
 * The days a tick recomputes. Yesterday covers a job created before midnight
 * and mined after it. Tomorrow covers the host's clock: node-postgres writes a
 * `Date` into a `timestamp` column as host-local wall time, so on a host not
 * running in UTC a job's `createdAt::date` can sit a day ahead. With the
 * window at ±1 day that shifts which bucket a job lands in, never whether it
 * is counted. Services should still run with TZ=UTC.
 */
export function recentUtcDays(now: Date): string[] {
  const day = 86_400_000;
  return [-day, 0, day].map((d) => utcDay(new Date(now.getTime() + d)));
}

/** YYYY-MM-DD in UTC. Local dates would split a day differently per host. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── service bootstrap ──────────────────────────────────────────────────────

export interface KeeperContext {
  network: ArcNetwork;
  contracts: ProtocolContracts;
  client: ReturnType<typeof createArcPublicClient>;
  sql: SqlClient;
  log: Logger;
  metrics: Metrics;
  actions: KeeperActions;
  gas: GasSpendRollup;
  shutdown: AbortController;
}

export interface BootstrapOptions {
  service: string;
  sql: SqlClient;
  env?: Env;
  logLevel?: LogLevel;
  /** Where log lines go. Default stdout; a tool printing data there passes stderr. */
  logSink?: (line: string) => void;
}

/**
 * Resolve the network and contracts, open a public client, and refuse to start
 * unless the RPC reports the expected chain id. A keeper pointed at the wrong
 * chain is worse than a keeper that is down.
 */
export async function bootstrap(o: BootstrapOptions): Promise<KeeperContext> {
  const env = o.env ?? process.env;
  const network = arcNetwork(serverNetworkId(env));
  const contracts = serverContracts(network, env);
  const client = createArcPublicClient(network);
  const log = createLogger(
    o.service,
    o.logLevel ?? (env.LOG_LEVEL as LogLevel) ?? "info",
    { network: network.id },
    o.logSink
  );
  // node-postgres writes a Date into a `timestamp` column as host-local wall
  // time. Pin UTC so TxJob.createdAt and the GasSpend day agree on every host.
  if (process.env.TZ !== "UTC") {
    if (process.env.TZ) log.warn("overriding TZ to UTC", { was: process.env.TZ });
    process.env.TZ = "UTC";
  }
  await assertChainId(client, network);
  log.info("chain id verified", { chainId: network.chainId });
  return {
    network,
    contracts,
    client,
    sql: o.sql,
    log,
    metrics: new Metrics(),
    actions: new KeeperActions(o.sql, network.id),
    gas: new GasSpendRollup(o.sql, network.id),
    shutdown: shutdownSignal(log),
  };
}

export interface SenderOptions {
  ctx: KeeperContext;
  service: string;
  /**
   * This process's key role, named by its key variable (e.g.
   * "LIQUIDATOR_PRIVATE_KEY"). Where the key lives is set by
   * KRYON_SIGNER_<ROLE>; see lib/chain/signer.ts.
   */
  keyEnvVar: string;
  env?: Env;
  overrides?: Partial<TxSenderOptions>;
}

/** One TxSender for this process's single key, over the Postgres job store. */
export async function createSender(o: SenderOptions): Promise<TxSender> {
  const signer = await loadServiceSigner({ keyEnvVar: o.keyEnvVar, network: o.ctx.network.id, env: o.env ?? process.env });
  o.ctx.log.info("signer loaded", { role: signer.role, mode: signer.mode, address: signer.account.address });
  return new TxSender({
    network: o.ctx.network,
    service: o.service,
    chain: o.ctx.client,
    signer: signer.account,
    store: new PgTxJobStore(o.ctx.sql),
    ...o.overrides,
  });
}

// ─── env helpers ────────────────────────────────────────────────────────────

/**
 * Startup recovery: before a keeper signs anything new, drive every job this
 * key left open (a crash between broadcast and receipt) to a mined outcome.
 * Only `wait()`: the same signed bytes, or the owner's own fee bump at the
 * same nonce. Nothing is re-decided, so nothing can be sent twice. A job that
 * still will not resolve is left for the reconciler and reported.
 */
export async function recoverOpenJobs(
  sender: Pick<TxSender, "openJobs" | "wait">,
  log: Logger
): Promise<{ recovered: number; unresolved: number }> {
  const jobs = await sender.openJobs();
  const newest = new Map<number, (typeof jobs)[number]>();
  for (const j of jobs) {
    const prev = newest.get(j.nonce);
    if (!prev || j.createdAt.getTime() >= prev.createdAt.getTime()) newest.set(j.nonce, j);
  }
  let recovered = 0;
  let unresolved = 0;
  for (const job of [...newest.values()].sort((a, b) => a.nonce - b.nonce)) {
    try {
      const out = await sender.wait(job);
      recovered += 1;
      log.info("recovered open job", { id: job.id, label: job.label, nonce: job.nonce, status: out.receipt.status });
    } catch (err) {
      unresolved += 1;
      log.warn("open job unresolved at startup; left for the reconciler", {
        id: job.id,
        nonce: job.nonce,
        error: errorMessage(err),
      });
    }
  }
  if (jobs.length > 0) log.info("startup recovery complete", { open: jobs.length, recovered, unresolved });
  return { recovered, unresolved };
}

/**
 * In-flight guard for keepers whose sends are not idempotent. A job whose
 * `wait()` timed out may still land; deciding again from chain state while it
 * is pending would read the *pre*-transaction state and send a second one
 * (a second liquidation of the same account, a second funding update). So:
 * resolve this key's open jobs first, and report whether any remain. Callers
 * send nothing new while this returns true.
 */
export async function stillInFlight(sender: Pick<TxSender, "openJobs" | "wait">, log: Logger): Promise<boolean> {
  const open = await sender.openJobs();
  if (open.length === 0) return false;
  const { unresolved } = await recoverOpenJobs(sender, log);
  if (unresolved > 0) log.warn("transactions still in flight for this key; not deciding anything new this tick", { unresolved });
  return unresolved > 0;
}

export function envInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number; got "${raw}"`);
  return n;
}

export function envBool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function envList(env: Env, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
