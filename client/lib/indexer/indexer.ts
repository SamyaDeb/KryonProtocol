/**
 * Protocol indexer (plan §6.4, roadmap Phase 3).
 *
 * Pulls every log of the Kryon contracts in block windows, stores each one in
 * `ProtocolEvent`, projects it into the typed tables and advances
 * `BlockCursor`, all in one database transaction per window. A crash therefore
 * loses at most the window in flight, which is simply re-read on restart.
 * Arc finality is deterministic on inclusion, so there are no reorgs to undo.
 *
 * `rebuild()` recomputes every projection from `ProtocolEvent` alone; the
 * replay test asserts it reproduces the live result exactly.
 */

import type { Address, Hex } from "viem";

import type { Db, Query } from "./db";
import { ContractRegistry, type RawLog, type StoredEvent } from "./decode";
import { applyEvent, resetProjections } from "./projections";

export const CURSOR_STREAM = "protocol";

/** The chain reads the indexer needs; `publicClientSource` adapts a viem client. */
export interface LogSource {
  getBlockNumber(): Promise<bigint>;
  getBlock(blockNumber: bigint): Promise<{ hash: Hex; timestamp: bigint }>;
  getLogs(args: { address: Address[]; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]>;
}

export interface IndexerOptions {
  network: string;
  /** First block to read when no cursor exists (the deployment block). */
  startBlock: bigint;
  /** Largest block range per getLogs call. */
  maxWindow?: bigint;
  log?: (msg: string) => void;
}

export interface WindowResult {
  fromBlock: bigint;
  toBlock: bigint;
  logs: number;
}

export class Indexer {
  private window: bigint;
  private readonly maxWindow: bigint;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly db: Db,
    private readonly source: LogSource,
    private readonly registry: ContractRegistry,
    private readonly opts: IndexerOptions
  ) {
    this.maxWindow = opts.maxWindow ?? 2_000n;
    this.window = this.maxWindow;
    this.log = opts.log ?? (() => {});
  }

  async cursor(): Promise<bigint | null> {
    const rows = await this.db.query<{ blockNumber: string }>(
      `SELECT "blockNumber" FROM "BlockCursor" WHERE "network" = $1 AND "stream" = $2`,
      [this.opts.network, CURSOR_STREAM]
    );
    return rows.length ? BigInt(rows[0].blockNumber) : null;
  }

  /** Index one window up to the head. Returns null when already caught up. */
  async step(): Promise<WindowResult | null> {
    const last = await this.cursor();
    const fromBlock = last === null ? this.opts.startBlock : last + 1n;
    const head = await this.source.getBlockNumber();
    if (fromBlock > head) return null;

    for (;;) {
      const toBlock = min(head, fromBlock + this.window - 1n);
      let logs: RawLog[];
      try {
        logs = await this.source.getLogs({ address: this.registry.addresses(), fromBlock, toBlock });
      } catch (err) {
        if (this.window > 1n && isRangeError(err)) {
          this.window = this.window / 2n;
          this.log(`getLogs ${fromBlock}-${toBlock} too large; window now ${this.window}`);
          continue;
        }
        throw err;
      }
      await this.commit(fromBlock, toBlock, logs);
      // Grow back gradually after a provider-imposed shrink.
      if (this.window < this.maxWindow) this.window = min(this.maxWindow, this.window * 2n);
      return { fromBlock, toBlock, logs: logs.length };
    }
  }

  /** Index until caught up with the head. */
  async catchUp(): Promise<number> {
    let windows = 0;
    while (await this.step()) windows += 1;
    return windows;
  }

  private async commit(fromBlock: bigint, toBlock: bigint, logs: RawLog[]): Promise<void> {
    const ordered = [...logs].sort((x, y) =>
      x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1
    );
    const blocks = new Map<bigint, { hash: Hex; timestamp: bigint }>();
    for (const b of new Set([...ordered.map((l) => l.blockNumber), toBlock])) {
      blocks.set(b, await this.source.getBlock(b));
    }

    await this.db.transaction(async (q) => {
      for (const raw of ordered) {
        if (raw.blockNumber < fromBlock || raw.blockNumber > toBlock) {
          throw new Error(`log at block ${raw.blockNumber} outside requested ${fromBlock}-${toBlock}`);
        }
        const block = blocks.get(raw.blockNumber)!;
        const { eventName, args } = this.registry.decode(raw);
        const ev: StoredEvent = {
          network: this.opts.network,
          blockNumber: raw.blockNumber,
          blockTimestamp: new Date(Number(block.timestamp) * 1000),
          txHash: raw.transactionHash.toLowerCase(),
          logIndex: raw.logIndex,
          contract: raw.address.toLowerCase(),
          eventName,
          args,
        };
        const inserted = await q.query(
          `INSERT INTO "ProtocolEvent" ("network", "blockNumber", "blockHash", "blockTimestamp", "txHash", "logIndex",
             "contract", "eventName", "topic0", "args")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           ON CONFLICT ("network", "txHash", "logIndex") DO NOTHING RETURNING 1`,
          [
            ev.network,
            ev.blockNumber.toString(),
            block.hash.toLowerCase(),
            ev.blockTimestamp,
            ev.txHash,
            ev.logIndex,
            ev.contract,
            eventName,
            (raw.topics[0] ?? `0x${"0".repeat(64)}`).toLowerCase(),
            JSON.stringify(args),
          ]
        );
        // Already stored means already projected (same transaction as the cursor).
        if (inserted.length === 0) continue;
        await applyEvent(q, this.registry.nameOf(ev.contract), ev);
      }
      await setCursor(q, this.opts.network, toBlock, blocks.get(toBlock)!.hash);
    });
  }

  /**
   * Recompute every projection from ProtocolEvent, in one transaction, without
   * touching the chain. Used after a projection bug fix and by the replay test.
   */
  async rebuild(batchSize = 5_000): Promise<number> {
    return this.db.transaction(async (q) => {
      await resetProjections(q, this.opts.network);
      let applied = 0;
      let after: [string, number] = ["-1", 0];
      for (;;) {
        const rows = await q.query<{
          blockNumber: string;
          blockTimestamp: Date;
          txHash: string;
          logIndex: number;
          contract: string;
          eventName: string;
          args: StoredEvent["args"];
        }>(
          `SELECT "blockNumber", "blockTimestamp", "txHash", "logIndex", "contract", "eventName", "args"
           FROM "ProtocolEvent"
           WHERE "network" = $1 AND ("blockNumber", "logIndex") > ($2::bigint, $3::int)
           ORDER BY "blockNumber", "logIndex" LIMIT $4`,
          [this.opts.network, after[0], after[1], batchSize]
        );
        for (const r of rows) {
          const ev: StoredEvent = { ...r, network: this.opts.network, blockNumber: BigInt(r.blockNumber) };
          if (await applyEvent(q, this.registry.nameOf(r.contract), ev)) applied += 1;
        }
        if (rows.length < batchSize) return applied;
        const lastRow = rows[rows.length - 1];
        after = [lastRow.blockNumber, lastRow.logIndex];
      }
    });
  }
}

async function setCursor(q: Query, network: string, blockNumber: bigint, blockHash: Hex): Promise<void> {
  await q.query(
    `INSERT INTO "BlockCursor" ("network", "stream", "blockNumber", "blockHash", "updatedAt") VALUES ($1, $2, $3, $4, now())
     ON CONFLICT ("network", "stream") DO UPDATE SET "blockNumber" = EXCLUDED."blockNumber",
       "blockHash" = EXCLUDED."blockHash", "updatedAt" = now()`,
    [network, CURSOR_STREAM, blockNumber.toString(), blockHash.toLowerCase()]
  );
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Provider errors that mean "ask for a smaller range". */
export function isRangeError(err: unknown): boolean {
  const msg = String((err as { details?: string; message?: string })?.details ?? (err as Error)?.message ?? err);
  return /block range|too many|limit exceeded|query returned more than|response size|range is too large|exceed/i.test(msg);
}

/** Adapt a viem PublicClient. */
export function publicClientSource(client: {
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex | null; timestamp: bigint }>;
  getLogs(args: { address: Address[]; fromBlock: bigint; toBlock: bigint }): Promise<
    { address: Address; blockNumber: bigint | null; transactionHash: Hex | null; logIndex: number | null; topics: Hex[]; data: Hex }[]
  >;
}): LogSource {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    async getBlock(blockNumber) {
      const b = await client.getBlock({ blockNumber });
      if (!b.hash) throw new Error(`block ${blockNumber} has no hash`);
      return { hash: b.hash, timestamp: b.timestamp };
    },
    async getLogs(args) {
      const logs = await client.getLogs(args);
      return logs.map((l) => {
        if (l.blockNumber === null || l.transactionHash === null || l.logIndex === null) {
          throw new Error("getLogs returned a pending log");
        }
        return { ...l, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex };
      });
    },
  };
}
