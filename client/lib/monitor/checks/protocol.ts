/**
 * Protocol solvency and state: the on-chain facts that say whether the money
 * is there and whether the contracts are the ones we deployed.
 */

import type { ProtocolContracts } from "@/lib/chain/networks";

import type { InsuranceState, MarketState } from "../chain";
import type { MonitorConfig } from "../config";
import { reads, type Check } from "../context";
import {
  evaluateImplementations,
  evaluateRoles,
  type ExpectedImpl,
  type RoleMembership,
} from "../roles";
import type { GovernanceRow } from "../store";
import { fmtSecs, resultsFor, toFloat18, usd18, type CheckMeta, type CheckResult } from "../types";

const abs = (v: bigint) => (v < 0n ? -v : v);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

// ─── Vault.solvency ─────────────────────────────────────────────────────────

export const SOLVENCY: CheckMeta = {
  id: "vault.solvency",
  severity: "PAGE",
  runbook: "solvency.md",
  description: "Vault assets cover every account's claim, exactly",
  failAfter: 1,
};

/** Exact: a shortfall of one wei is a shortfall. */
export function evaluateSolvency(s: { assets: bigint; liabilities: bigint }): CheckResult[] {
  const r = resultsFor(SOLVENCY);
  const values = {
    assets: s.assets.toString(),
    liabilities: s.liabilities.toString(),
    assetsUsd: toFloat18(s.assets),
    liabilitiesUsd: toFloat18(s.liabilities),
    surplusUsd: toFloat18(s.assets - s.liabilities),
  };
  if (s.assets >= s.liabilities) return [r.pass(`assets ${usd18(s.assets)} ≥ liabilities ${usd18(s.liabilities)}`, values)];
  return [
    r.fail(
      `INSOLVENT: liabilities exceed assets by ${s.liabilities - s.assets} wei (${usd18(s.liabilities - s.assets)}); ` +
        `assets ${usd18(s.assets)}, liabilities ${usd18(s.liabilities)}`,
      values
    ),
  ];
}

// ─── Insurance ──────────────────────────────────────────────────────────────

export const SHORTFALL: CheckMeta = {
  id: "insurance.shortfall",
  severity: "PAGE",
  runbook: "insurance-shortfall.md",
  description: "Insurance.unfundedShortfall() is zero and can be priced",
};

export function evaluateShortfall(i: InsuranceState): CheckResult[] {
  const r = resultsFor(SHORTFALL);
  const values = {
    shortfallUsd: i.unfundedShortfall === null ? null : toFloat18(i.unfundedShortfall),
    markedOperatingUsd: toFloat18(i.marked),
    priced: i.priced,
    badDebtUsd: toFloat18(i.badDebt),
  };
  if (i.unfundedShortfall === null) {
    return [r.fail("unfundedShortfall() cannot be priced (StaleOracle): ADL is blocked and the shortfall is unknown", values)];
  }
  if (i.unfundedShortfall > 0n) {
    return [r.fail(`unfunded shortfall ${usd18(i.unfundedShortfall)}: the backstop is under water; ADL should be running`, values)];
  }
  return [r.pass(`no unfunded shortfall; operating balance ${usd18(i.marked)}, bad debt ${usd18(i.badDebt)}`, values)];
}

export const COVERAGE: CheckMeta = {
  id: "insurance.coverage",
  severity: "WARN",
  runbook: "insurance-shortfall.md",
  description: "Insurance operating balance against open-interest notional",
};

/** Notional of each market's open interest at its index price; the larger side counts. */
export function openInterestNotional(markets: readonly MarketState[]): { total: bigint; unpriced: string[] } {
  let total = 0n;
  const unpriced: string[] = [];
  for (const m of markets) {
    const oi = max(abs(m.longOi), abs(m.shortOi));
    if (oi === 0n) continue;
    if (m.indexPrice === null) {
      unpriced.push(m.symbol);
      continue;
    }
    total += (oi * m.indexPrice) / 10n ** 18n;
  }
  return { total, unpriced };
}

export function evaluateCoverage(i: InsuranceState, markets: readonly MarketState[], minBps: number): CheckResult[] {
  const r = resultsFor(COVERAGE);
  const { total, unpriced } = openInterestNotional(markets);
  if (total === 0n && unpriced.length === 0) return [r.skip("no open interest", { oiNotionalUsd: 0 })];
  if (total === 0n) return [r.error(`open interest cannot be priced: ${unpriced.join(", ")}`)];
  const bps = i.marked <= 0n ? 0 : Number((i.marked * 10_000n) / total);
  const values = { coverageBps: bps, minBps, oiNotionalUsd: toFloat18(total), markedOperatingUsd: toFloat18(i.marked) };
  const note = unpriced.length ? ` (unpriced: ${unpriced.join(", ")})` : "";
  if (bps < minBps) {
    return [r.fail(`insurance covers ${(bps / 100).toFixed(2)}% of ${usd18(total)} open interest (< ${minBps / 100}%)${note}`, values)];
  }
  return [r.pass(`insurance covers ${(bps / 100).toFixed(2)}% of ${usd18(total)} open interest${note}`, values)];
}

export const BACKSTOP: CheckMeta = {
  id: "insurance.backstop",
  severity: "WARN",
  runbook: "insurance-shortfall.md",
  description: "Positions the insurance fund holds as backstop, at the index",
};

export function evaluateBackstop(
  positions: readonly { marketId: number; size: bigint; openNotional: bigint }[],
  markets: readonly MarketState[],
  warnAt: bigint
): CheckResult[] {
  const r = resultsFor(BACKSTOP);
  if (positions.length === 0) return [r.pass("the backstop holds no positions", { positions: 0, notionalUsd: 0 })];
  const byId = new Map(markets.map((m) => [m.marketId, m]));
  let notional = 0n;
  let upnl = 0n;
  const parts: string[] = [];
  for (const p of positions) {
    const m = byId.get(p.marketId);
    const px = m?.indexPrice ?? null;
    if (px === null) {
      parts.push(`market ${p.marketId} unpriced`);
      continue;
    }
    const n = (abs(p.size) * px) / 10n ** 18n;
    notional += n;
    upnl += (p.size > 0n ? n : -n) - p.openNotional;
    parts.push(`${m?.symbol ?? p.marketId} ${usd18(n)}`);
  }
  const values = { positions: positions.length, notionalUsd: toFloat18(notional), unrealizedPnlUsd: toFloat18(upnl) };
  const detail = `backstop holds ${usd18(notional)} (${parts.join(", ")}), unrealized ${usd18(upnl)}`;
  return [notional > warnAt ? r.fail(`${detail}; above ${usd18(warnAt)}`, values) : r.pass(detail, values)];
}

// ─── Vault deposit caps ─────────────────────────────────────────────────────

export const CAPS: CheckMeta = {
  id: "vault.deposit-caps",
  severity: "PAGE",
  runbook: "governance-drift.md",
  description: "Vault deposit caps equal the configured guarded-launch limits",
};

const usdc6 = (v: bigint) => `$${(Number(v) / 1e6).toLocaleString("en-US")}`;
const UNCAPPED_FROM = 1n << 255n;

export function evaluateCaps(
  caps: { totalCap: bigint; perAccountCap: bigint; totalDeposited: bigint },
  cfg: MonitorConfig["vault"]
): CheckResult[] {
  const r = resultsFor(CAPS);
  const values = {
    totalCapUsdc: Number(caps.totalCap) / 1e6,
    perAccountCapUsdc: Number(caps.perAccountCap) / 1e6,
    expectedTotalUsdc: cfg.expectedTotalCap === null ? null : Number(cfg.expectedTotalCap) / 1e6,
    expectedPerAccountUsdc: cfg.expectedAccountCap === null ? null : Number(cfg.expectedAccountCap) / 1e6,
  };
  if (cfg.expectedTotalCap === null && cfg.expectedAccountCap === null) {
    return [
      r.fail(
        `caps are total ${usdc6(caps.totalCap)} / per account ${usdc6(caps.perAccountCap)}, but no expected caps are configured ` +
          `(MONITOR_EXPECTED_DEPOSIT_CAP_USDC, MONITOR_EXPECTED_ACCOUNT_CAP_USDC): a cap change would go unnoticed`,
        values,
        { severity: "WARN" }
      ),
    ];
  }
  const drift: string[] = [];
  if (cfg.expectedTotalCap !== null && caps.totalCap !== cfg.expectedTotalCap) {
    drift.push(`total cap ${usdc6(caps.totalCap)}, expected ${usdc6(cfg.expectedTotalCap)}`);
  }
  if (cfg.expectedAccountCap !== null && caps.perAccountCap !== cfg.expectedAccountCap) {
    drift.push(`per-account cap ${usdc6(caps.perAccountCap)}, expected ${usdc6(cfg.expectedAccountCap)}`);
  }
  if (drift.length) return [r.fail(`deposit caps changed: ${drift.join("; ")}`, values)];
  return [r.pass(`caps as configured: total ${usdc6(caps.totalCap)}, per account ${usdc6(caps.perAccountCap)}`, values)];
}

export const UTILIZATION: CheckMeta = {
  id: "vault.deposit-utilization",
  severity: "WARN",
  runbook: "governance-drift.md",
  description: "Deposits against the total cap (guarded launch headroom)",
};

export function evaluateUtilization(
  caps: { totalCap: bigint; totalDeposited: bigint },
  warnBps: number
): CheckResult[] {
  const r = resultsFor(UTILIZATION);
  if (caps.totalCap >= UNCAPPED_FROM) return [r.skip("deposits are uncapped", { totalDepositedUsdc: Number(caps.totalDeposited) / 1e6 })];
  if (caps.totalCap === 0n) return [r.skip("deposits are closed (total cap 0)", { totalDepositedUsdc: Number(caps.totalDeposited) / 1e6 })];
  const bps = Number((caps.totalDeposited * 10_000n) / caps.totalCap);
  const values = { utilizationBps: bps, warnBps, totalDepositedUsdc: Number(caps.totalDeposited) / 1e6, totalCapUsdc: Number(caps.totalCap) / 1e6 };
  const detail = `${usdc6(caps.totalDeposited)} of ${usdc6(caps.totalCap)} deposited (${(bps / 100).toFixed(1)}%)`;
  return [bps >= warnBps ? r.fail(`${detail}: deposits will start failing at the cap`, values) : r.pass(detail, values)];
}

// ─── pauses ─────────────────────────────────────────────────────────────────

export const PAUSED: CheckMeta = {
  id: "protocol.paused",
  severity: "WARN",
  runbook: "timelock-operations.md",
  description: "No protocol contract is paused",
};

export function evaluatePaused(paused: Record<string, boolean>): CheckResult[] {
  const r = resultsFor(PAUSED);
  const on = Object.entries(paused)
    .filter(([, p]) => p)
    .map(([k]) => k)
    .sort();
  const values = Object.fromEntries(Object.entries(paused).map(([k, v]) => [k, v]));
  if (on.length) return [r.fail(`paused: ${on.join(", ")}`, values)];
  return [r.pass("no contract paused", values)];
}

// ─── roles and implementations ──────────────────────────────────────────────

export const ROLES: CheckMeta = {
  id: "governance.roles",
  severity: "PAGE",
  runbook: "governance-drift.md",
  description: "Role holders match the deployment invariants and the recorded baseline",
};

export function evaluateRoleCheck(
  actual: RoleMembership,
  contracts: ProtocolContracts,
  baseline: RoleMembership | null
): CheckResult[] {
  const r = resultsFor(ROLES);
  const v = evaluateRoles(actual, contracts, baseline);
  const values = { drift: v.drift.length, unverified: v.unverified.length, checkedRoles: v.checkedRoles, baseline: baseline !== null };
  if (v.drift.length) {
    const parts = v.drift.map(
      (d) =>
        `${d.contract}.${d.role}: expected [${d.expected.join(", ")}] got [${d.actual.join(", ")}] (${d.source})`
    );
    return [r.fail(`ROLE DRIFT — a grant or revoke happened: ${parts.join("; ")}`, values)];
  }
  if (v.unverified.length) {
    return [
      r.fail(
        `invariants hold, but ${v.unverified.length} service role(s) are unverified: no MONITOR_ROLE_BASELINE_FILE ` +
          `(write one with \`monitor.ts --print-role-baseline\` after 99_VerifyDeployment passes)`,
        values,
        { severity: "WARN" }
      ),
    ];
  }
  return [r.pass(`${v.checkedRoles} role(s) as expected`, values)];
}

export const IMPLEMENTATIONS: CheckMeta = {
  id: "governance.implementations",
  severity: "PAGE",
  runbook: "governance-drift.md",
  description: "Every proxy points at the recorded implementation (and code hash)",
};

export function evaluateImplCheck(
  contracts: ProtocolContracts,
  actual: Map<string, { implementation: string; codeHash: string | null }>,
  artifacts: Map<string, ExpectedImpl>,
  record: Map<string, ExpectedImpl>
): CheckResult[] {
  const r = resultsFor(IMPLEMENTATIONS);
  const expected = artifacts.size > 0 ? artifacts : record;
  const source = artifacts.size > 0 ? "DeploymentArtifact" : record.size > 0 ? "deployment record" : null;
  if (!source) {
    return [
      r.fail(
        "no expected implementations: DeploymentArtifact has no active rows and KRYON_DEPLOYMENT_FILE has no `implementations`",
        { proxies: actual.size },
        { severity: "WARN" }
      ),
    ];
  }
  const drift = evaluateImplementations(contracts, actual, expected);
  const real = drift.filter((d) => d.reason !== "no-record");
  const values = { proxies: actual.size, drift: real.length, unrecorded: drift.length - real.length, source };
  if (real.length) {
    const parts = real.map((d) =>
      d.reason === "code-hash"
        ? `${d.contract}: code hash ${d.actual} ≠ recorded ${d.expected}`
        : `${d.contract}: implementation ${d.actual} ≠ recorded ${d.expected}`
    );
    return [r.fail(`IMPLEMENTATION DRIFT — an upgrade happened: ${parts.join("; ")}`, values)];
  }
  if (drift.length) {
    return [
      r.fail(`no ${source} entry for: ${drift.map((d) => d.contract).join(", ")}`, values, { severity: "WARN" }),
    ];
  }
  return [r.pass(`${actual.size} proxies match the ${source}`, values)];
}

// ─── timelock queue ─────────────────────────────────────────────────────────

export const TIMELOCK: CheckMeta = {
  id: "governance.timelock",
  severity: "WARN",
  runbook: "timelock-operations.md",
  description: "Queued timelock operations, each with its eta",
};

/** One result per queued operation, so each new one notifies on its own. */
export function evaluateTimelock(ops: readonly GovernanceRow[], nowMs: number): CheckResult[] {
  const r = resultsFor(TIMELOCK);
  if (ops.length === 0) return [r.pass("no operations queued", { queued: 0 })];
  return ops.map((op) => {
    const secs = (op.readyAt.getTime() - nowMs) / 1000;
    const when = secs > 0 ? `executable in ${fmtSecs(secs)}` : `executable since ${fmtSecs(-secs)}`;
    return r.fail(
      `operation ${op.operationId.slice(0, 18)}… queued, ${when} (eta ${op.readyAt.toISOString()})` +
        (op.description ? `: ${op.description}` : ""),
      { readyAt: op.readyAt.toISOString(), secondsToReady: Math.round(secs), delaySeconds: Number(op.delaySeconds) },
      { subject: op.operationId.slice(0, 18) }
    );
  });
}

// ─── the checks ─────────────────────────────────────────────────────────────

export const protocolChecks: Check[] = [
  {
    ...SOLVENCY,
    threshold: () => "assets ≥ liabilities (exact, wei)",
    run: async (c) => evaluateSolvency(await c.chain.solvency()),
  },
  {
    ...SHORTFALL,
    threshold: () => "unfundedShortfall == 0 and priceable",
    run: async (c) => evaluateShortfall(await reads.insurance(c)),
  },
  {
    ...COVERAGE,
    threshold: (cfg) => `coverage < ${cfg.insurance.coverageMinBps / 100}% of OI notional`,
    run: async (c) => evaluateCoverage(await reads.insurance(c), await reads.markets(c), c.cfg.insurance.coverageMinBps),
  },
  {
    ...BACKSTOP,
    threshold: (cfg) => `backstop notional > ${usd18(cfg.backstopWarn)}`,
    run: async (c) =>
      evaluateBackstop(await c.store.positionsOf(c.contracts.insurance), await reads.markets(c), c.cfg.backstopWarn),
  },
  {
    ...CAPS,
    threshold: () => "caps ≠ MONITOR_EXPECTED_* (WARN when unset)",
    run: async (c) => evaluateCaps(await c.once("caps", () => c.chain.depositCaps()), c.cfg.vault),
  },
  {
    ...UTILIZATION,
    threshold: (cfg) => `deposits ≥ ${cfg.vault.utilizationWarnBps / 100}% of total cap`,
    run: async (c) => evaluateUtilization(await c.once("caps", () => c.chain.depositCaps()), c.cfg.vault.utilizationWarnBps),
  },
  {
    ...PAUSED,
    threshold: () => "any contract paused",
    run: async (c) => evaluatePaused(await c.chain.paused()),
  },
  {
    ...ROLES,
    threshold: () => "any holder ≠ invariant/baseline (WARN when no baseline)",
    run: async (c) => evaluateRoleCheck(await c.chain.roleMembers(), c.contracts, c.roleBaseline),
  },
  {
    ...IMPLEMENTATIONS,
    threshold: () => "implementation or code hash ≠ DeploymentArtifact / deployment record",
    run: async (c) =>
      evaluateImplCheck(c.contracts, await c.chain.implementations(), await c.store.deploymentArtifacts(), c.deploymentRecord),
  },
  {
    ...TIMELOCK,
    threshold: () => "any SCHEDULED operation (one alert per operation)",
    run: async (c) => evaluateTimelock(await c.store.pendingGovernance(), c.now()),
  },
];
