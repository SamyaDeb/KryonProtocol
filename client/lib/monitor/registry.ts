/**
 * Every check, in one list, and the pass that runs them.
 *
 * One check's failure never hides another's: each runs in its own try/catch
 * with its own timeout, and a check that throws reports `error` for itself
 * while the rest of the tick completes.
 */

import { infraChecks } from "./checks/infra";
import { keeperChecks } from "./checks/keepers";
import { oracleChecks } from "./checks/oracle";
import { protocolChecks } from "./checks/protocol";
import type { Check, CheckContext } from "./context";
import { resultsFor, type CheckResult } from "./types";

export const CHECKS: Check[] = [...protocolChecks, ...oracleChecks, ...keeperChecks, ...infraChecks];

export function checkById(id: string): Check | undefined {
  return CHECKS.find((c) => c.id === id);
}

const DEFAULT_TIMEOUT_MS = 20_000;

export interface RunOptions {
  timeoutMs?: number;
  /** Ids to run; everything when omitted. */
  only?: readonly string[];
}

export interface TickOutcome {
  results: CheckResult[];
  /** Checks that ran to completion, error included: used to resolve subjects that disappeared. */
  ran: Set<string>;
  durationMs: number;
}

export async function runChecks(ctx: CheckContext, o: RunOptions = {}): Promise<TickOutcome> {
  const started = ctx.now();
  const checks = o.only ? CHECKS.filter((c) => o.only!.includes(c.id)) : CHECKS;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const results = await Promise.all(
    checks.map(async (check): Promise<CheckResult[]> => {
      const r = resultsFor(check);
      try {
        return await withTimeout(check.run(ctx), timeoutMs, check.id);
      } catch (err) {
        return [r.error(`check failed to run: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))];
      }
    })
  );
  return { results: results.flat(), ran: new Set(checks.map((c) => c.id)), durationMs: ctx.now() - started };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
