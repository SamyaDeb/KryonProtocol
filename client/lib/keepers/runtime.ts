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

import type { Address } from "viem";

import type { SqlClient } from "@/lib/sql";
import { assertChainId, createArcPublicClient, serviceAccount } from "@/lib/chain/clients";
import { PgTxJobStore } from "@/lib/chain/tx-store-pg";
import { TxSender, type TxSenderOptions } from "@/lib/chain/tx-sender";
import {
  arcNetwork,
  serverContracts,
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
 * Keyed on (network, day, service, fromAddress) and applied as an upsert that
 * adds, so a reconciler that processes the same receipt twice would
 * double-count. Callers must only roll up a job on the transition into a
 * terminal state — `TxJob.status` is that guard.
 */
export class GasSpendRollup {
  constructor(
    private readonly sql: SqlClient,
    private readonly network: string
  ) {}

  async add(entry: {
    day: Date;
    service: string;
    fromAddress: Address;
    gasUsed: bigint;
    effectiveGasPrice: bigint;
  }): Promise<void> {
    const cost = entry.gasUsed * entry.effectiveGasPrice;
    await this.sql.query(
      `INSERT INTO "GasSpend" ("network", "day", "service", "fromAddress", "txCount", "gasUsed", "costWei", "updatedAt")
       VALUES ($1, $2::date, $3, $4, 1, $5, $6, now())
       ON CONFLICT ("network", "day", "service", "fromAddress") DO UPDATE SET
         "txCount" = "GasSpend"."txCount" + 1,
         "gasUsed" = "GasSpend"."gasUsed" + EXCLUDED."gasUsed",
         "costWei" = "GasSpend"."costWei" + EXCLUDED."costWei",
         "updatedAt" = now()`,
      [
        this.network,
        utcDay(entry.day),
        entry.service,
        entry.fromAddress.toLowerCase(),
        entry.gasUsed.toString(),
        cost.toString(),
      ]
    );
  }
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
  const log = createLogger(o.service, o.logLevel ?? (env.LOG_LEVEL as LogLevel) ?? "info", {
    network: network.id,
  });
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
  /** Environment variable holding this process's private key. */
  keyEnvVar: string;
  env?: Env;
  overrides?: Partial<TxSenderOptions>;
}

/** One TxSender for this process's single key, over the Postgres job store. */
export function createSender(o: SenderOptions): TxSender {
  const account = serviceAccount(o.keyEnvVar, o.env ?? process.env);
  return new TxSender({
    network: o.ctx.network,
    service: o.service,
    chain: o.ctx.client,
    signer: account,
    store: new PgTxJobStore(o.ctx.sql),
    ...o.overrides,
  });
}

// ─── env helpers ────────────────────────────────────────────────────────────

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
