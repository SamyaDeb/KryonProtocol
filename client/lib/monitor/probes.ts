/**
 * The out-of-band probes: one RPC endpoint at a time (so "which endpoint is
 * serving" is answerable at all), the API's health route, the WS server, and
 * a read replica's replication lag.
 *
 * These deliberately bypass the fallback transport the rest of the monitor
 * reads through: a fallback that silently covers for a dead primary is
 * exactly what this is here to notice.
 */

import { Pool } from "pg";
import { WebSocket } from "ws";

import type { Probes } from "./context";
import { replicaLagSecs } from "./store";

export interface RealProbeOptions {
  replicaUrl: string | null;
  timeoutMs?: number;
  now?: () => number;
}

export function realProbes(o: RealProbeOptions): Probes & { close(): Promise<void> } {
  const timeout = o.timeoutMs ?? 5_000;
  const now = o.now ?? Date.now;
  let replicaPool: Pool | null = null;

  return {
    async rpc(url) {
      const t0 = now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: string; error?: { message?: string } };
      if (!body.result) throw new Error(body.error?.message ?? "no result");
      return { latencyMs: now() - t0, blockNumber: BigInt(body.result) };
    },

    async http(url) {
      const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeout) });
      return res.status;
    },

    /**
     * Open, send `{"type":"ping"}` and wait for `{"type":"pong"}`. A socket
     * that accepts a connection and then answers nothing is a WS server that
     * is up and useless, so the protocol round trip is the check.
     */
    ws(url) {
      return new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        const done = (err?: Error) => {
          clearTimeout(timer);
          socket.removeAllListeners();
          try {
            socket.close();
          } catch {
            // already closing
          }
          if (err) reject(err);
          else resolve();
        };
        const timer = setTimeout(() => done(new Error(`no pong within ${timeout}ms`)), timeout);
        socket.on("open", () => socket.send(JSON.stringify({ type: "ping" })));
        socket.on("message", (data) => {
          try {
            if ((JSON.parse(String(data)) as { type?: string }).type === "pong") done();
          } catch {
            // Not our frame (a snapshot or a trade); keep waiting for the pong.
          }
        });
        socket.on("error", (e: Error) => done(e));
        socket.on("close", () => done(new Error("closed before answering the ping")));
      });
    },

    async replicaLag() {
      if (!o.replicaUrl) return null;
      replicaPool ??= new Pool({ connectionString: o.replicaUrl, max: 1 });
      const pool = replicaPool;
      return replicaLagSecs({
        query: async (text, params = []) => (await pool.query(text, params as never[])).rows,
      });
    },

    async close() {
      await replicaPool?.end();
      replicaPool = null;
    },
  };
}
