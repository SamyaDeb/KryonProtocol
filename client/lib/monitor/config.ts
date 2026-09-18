/**
 * Monitor configuration from the environment. Every threshold has a default
 * that is safe on its own; the variables that have none (the addresses to
 * watch, the expected deposit caps, the role baseline) leave their check
 * reporting "not configured" at WARN rather than passing silently.
 */

import type { Address } from "viem";

import type { Env } from "@/lib/chain/networks";
import { envInt } from "@/lib/keepers/runtime";

export interface GasTarget {
  name: string;
  address: Address;
}

export interface MonitorConfig {
  intervalMs: number;

  alerting: {
    failAfter: number;
    resolveAfter: number;
    renotifyMs: number;
    startupGraceMs: number;
  };

  http: { host: string; port: number } | null;
  snapshot: boolean;

  oracle: {
    /** Alert once a feed is this fraction of its max age old. */
    staleFraction: number;
    /** Alert once divergence reaches this fraction of the on-chain halt bound. */
    divergenceFraction: number;
    /** A price that has not changed for this long is implausible. */
    flatlineSecs: number;
  };

  insurance: { coverageMinBps: number };

  vault: {
    /** 1e6 USDC, as `depositCaps()` returns them. Null: not configured. */
    expectedTotalCap: bigint | null;
    expectedAccountCap: bigint | null;
    utilizationWarnBps: number;
  };

  roleBaselineFile: string | null;
  deploymentFile: string | null;

  indexer: { lagSecs: number; lagBlocks: number };
  matcher: { crossedBookSecs: number; pendingFillSecs: number };
  txJobStuckSecs: number;
  rejections: { windowSecs: number; maxRateBps: number; minSample: number };
  fundingStaleSecs: number;
  liquidationBatch: number;

  gas: {
    targets: GasTarget[];
    /** 1e18 native USDC. Below this, keeper-refill should already have acted. */
    warnBelow: bigint;
    /** 1e18. A floor under the per-key "next transaction fails" estimate. */
    pageBelow: bigint;
    funder: Address | null;
    funderWarnBelow: bigint;
  };

  fees: { minGasUsd: bigint };
  backstopWarn: bigint;

  infra: {
    rpcUrls: string[];
    rpcLatencyWarnMs: number;
    dbLatencyWarnMs: number;
    replicaUrl: string | null;
    replicaLagSecs: number;
    apiUrl: string | null;
    wsUrl: string | null;
  };
}

export const E18 = 10n ** 18n;

/** Whole or fractional USDC → 1e18. */
export function usdcTo18(v: number): bigint {
  return BigInt(Math.round(v * 1e6)) * 10n ** 12n;
}

/** "name:0xaddress,..." — the same format as REFILL_TARGETS. */
export function parseGasTargets(raw: string | undefined): GasTarget[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, address] = entry.split(":").map((x) => x.trim());
      if (!name || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new Error(`gas target "${entry}" is not name:0xaddress`);
      }
      return { name, address: address as Address };
    });
}

function optionalUsdc6(env: Env, name: string): bigint | null {
  const raw = env[name];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number; got "${raw}"`);
  return BigInt(Math.round(n * 1e6));
}

function optionalAddress(env: Env, name: string): Address | null {
  const raw = env[name];
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error(`${name} is not an address`);
  return raw as Address;
}

export function loadMonitorConfig(env: Env, rpcUrls: string[]): MonitorConfig {
  const port = envInt(env, "MONITOR_HTTP_PORT", 9464);
  // The monitor's gas floor defaults to keeper-refill's, so the two can never
  // disagree about what "low" means: below the floor, refill should already
  // have topped the key up, and a key still below it means refill did not.
  const refillFloor = envInt(env, "REFILL_FLOOR_USDC", 5);
  const cfg: MonitorConfig = {
    intervalMs: envInt(env, "MONITOR_INTERVAL_MS", 30_000),
    alerting: {
      failAfter: envInt(env, "MONITOR_FAIL_AFTER", 2),
      resolveAfter: envInt(env, "MONITOR_RESOLVE_AFTER", 2),
      renotifyMs: envInt(env, "MONITOR_RENOTIFY_MS", 3_600_000),
      startupGraceMs: envInt(env, "MONITOR_STARTUP_GRACE_MS", 120_000),
    },
    http: port > 0 ? { host: env.MONITOR_HTTP_HOST || "127.0.0.1", port } : null,
    snapshot: (env.MONITOR_SNAPSHOT ?? "true") !== "false",
    oracle: {
      staleFraction: envInt(env, "MONITOR_ORACLE_STALE_FRACTION", 0.5),
      divergenceFraction: envInt(env, "MONITOR_ORACLE_DIVERGENCE_FRACTION", 0.75),
      flatlineSecs: envInt(env, "MONITOR_ORACLE_FLATLINE_SECS", 3_600),
    },
    insurance: { coverageMinBps: envInt(env, "MONITOR_INSURANCE_COVERAGE_MIN_BPS", 2_000) },
    vault: {
      expectedTotalCap: optionalUsdc6(env, "MONITOR_EXPECTED_DEPOSIT_CAP_USDC"),
      expectedAccountCap: optionalUsdc6(env, "MONITOR_EXPECTED_ACCOUNT_CAP_USDC"),
      utilizationWarnBps: envInt(env, "MONITOR_DEPOSIT_UTILIZATION_WARN_BPS", 9_000),
    },
    roleBaselineFile: env.MONITOR_ROLE_BASELINE_FILE || null,
    deploymentFile: env.KRYON_DEPLOYMENT_FILE || null,
    indexer: {
      lagSecs: envInt(env, "MONITOR_INDEXER_LAG_SECS", 60),
      lagBlocks: envInt(env, "MONITOR_INDEXER_LAG_BLOCKS", 120),
    },
    matcher: {
      crossedBookSecs: envInt(env, "MONITOR_CROSSED_BOOK_SECS", 60),
      pendingFillSecs: envInt(env, "MONITOR_PENDING_FILL_SECS", 120),
    },
    txJobStuckSecs: envInt(env, "MONITOR_TXJOB_STUCK_SECS", 300),
    rejections: {
      windowSecs: envInt(env, "MONITOR_REJECTION_WINDOW_SECS", 900),
      maxRateBps: envInt(env, "MONITOR_REJECTION_RATE_MAX_BPS", 2_000),
      minSample: envInt(env, "MONITOR_REJECTION_MIN_SAMPLE", 10),
    },
    fundingStaleSecs: envInt(env, "MONITOR_FUNDING_STALE_SECS", 3_600),
    liquidationBatch: envInt(env, "MONITOR_LIQUIDATION_BATCH", 200),
    gas: {
      targets: parseGasTargets(env.MONITOR_GAS_TARGETS || env.REFILL_TARGETS),
      warnBelow: usdcTo18(envInt(env, "MONITOR_GAS_WARN_USDC", refillFloor)),
      pageBelow: usdcTo18(envInt(env, "MONITOR_GAS_PAGE_USDC", 1)),
      funder: optionalAddress(env, "MONITOR_REFILL_FUNDER_ADDRESS"),
      funderWarnBelow: usdcTo18(envInt(env, "REFILL_FUNDER_ALERT_USDC", 100)),
    },
    fees: { minGasUsd: usdcTo18(envInt(env, "MONITOR_FEES_GAS_MIN_USDC", 1)) },
    backstopWarn: usdcTo18(envInt(env, "MONITOR_BACKSTOP_WARN_USDC", 10_000)),
    infra: {
      rpcUrls,
      rpcLatencyWarnMs: envInt(env, "MONITOR_RPC_LATENCY_WARN_MS", 2_000),
      dbLatencyWarnMs: envInt(env, "MONITOR_DB_LATENCY_WARN_MS", 2_000),
      replicaUrl: env.MONITOR_REPLICA_DATABASE_URL || null,
      replicaLagSecs: envInt(env, "MONITOR_REPLICA_LAG_SECS", 30),
      apiUrl: env.MONITOR_API_URL || null,
      wsUrl: env.MONITOR_WS_URL || null,
    },
  };
  validate(cfg);
  return cfg;
}

function validate(c: MonitorConfig): void {
  if (c.alerting.failAfter < 1 || c.alerting.resolveAfter < 1) throw new Error("MONITOR_FAIL_AFTER and MONITOR_RESOLVE_AFTER must be >= 1");
  if (c.oracle.staleFraction <= 0 || c.oracle.staleFraction > 1) throw new Error("MONITOR_ORACLE_STALE_FRACTION must be in (0, 1]");
  if (c.oracle.divergenceFraction <= 0 || c.oracle.divergenceFraction > 1) {
    throw new Error("MONITOR_ORACLE_DIVERGENCE_FRACTION must be in (0, 1]");
  }
  if (c.gas.pageBelow >= c.gas.warnBelow) {
    throw new Error("MONITOR_GAS_PAGE_USDC must be below MONITOR_GAS_WARN_USDC (default: REFILL_FLOOR_USDC)");
  }
  if (c.fundingStaleSecs > 3_600) {
    // Engine accrues at most one hour per updateFunding call; past that,
    // funding is silently lost, so alerting any later is alerting too late.
    throw new Error("MONITOR_FUNDING_STALE_SECS must be <= 3600 (the contract's maximum accrual per update)");
  }
}
