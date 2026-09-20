/**
 * Go-live checks for a whole venue: is this deployment consistent with itself?
 *
 * The contracts are verified by `99_VerifyDeployment` (roles, wiring, fees,
 * risk parameters, implementation drift) and the running venue is watched by
 * the monitor (oracle freshness, indexer lag, settlement, gas, solvency…).
 * Neither answers the question this module asks: do the deployment record,
 * the chain, the app's own API and the indexed database describe the SAME
 * venue?
 *
 * That is where a testnet goes quietly wrong: an app pointed at yesterday's
 * addresses, a database indexed from a different deployment, or markets the
 * database calls inactive while the chain has them live — which rejects every
 * order with `market_inactive` and looks like a UI bug.
 *
 * Pure: every check takes what was read and returns a verdict, so the
 * comparisons are tested without a chain, a database or a server.
 */

import type { Address } from "viem";

import type { ProtocolContracts } from "@/lib/chain/networks";

/**
 * `warn` is for a check that could not run: not configured, or not applicable
 * to an empty venue. It does not fail the gate by itself, because a venue with
 * no open interest legitimately has no oracle staleness to measure — but at
 * go-live most warnings mean "the monitor is not configured yet", so they are
 * printed as loudly as failures.
 */
export type GateStatus = "ok" | "warn" | "fail";

export interface GateCheck {
  id: string;
  status: GateStatus;
  /** One line, for a person reading a terminal. */
  detail: string;
}

const verdict = (ok: boolean): GateStatus => (ok ? "ok" : "fail");

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const CONTRACT_KEYS = [
  "vault",
  "engine",
  "orderGateway",
  "oracleAdapter",
  "liquidation",
  "insurance",
  "riskParams",
  "feeRouter",
  "timelock",
] as const;

/** Every contract in the deployment record has code on the chain. */
export function checkDeploymentCode(contracts: ProtocolContracts, hasCode: (a: Address) => boolean): GateCheck {
  const missing = CONTRACT_KEYS.filter((k) => !hasCode(contracts[k]));
  return {
    id: "deployment.code",
    status: verdict(missing.length === 0),
    detail: missing.length === 0 ? `${CONTRACT_KEYS.length} contracts have code` : `no code at: ${missing.join(", ")}`,
  };
}

export interface ApiConfigShape {
  network: string;
  chain_id: number;
  contracts: Record<string, string>;
}

/**
 * The app serves the same addresses and chain the services use. A mismatch
 * means the UI signs orders against a different gateway than the one the
 * matcher settles on, and every signature is rejected.
 */
export function checkApiConfig(api: ApiConfigShape, contracts: ProtocolContracts, chainId: number, network: string): GateCheck {
  const problems: string[] = [];
  if (api.chain_id !== chainId) problems.push(`chain id ${api.chain_id} != ${chainId}`);
  if (api.network !== network) problems.push(`network ${api.network} != ${network}`);
  const pairs: [keyof ProtocolContracts, string][] = [
    ["vault", "vault"],
    ["orderGateway", "order_gateway"],
    ["engine", "engine"],
    ["feeRouter", "fee_router"],
    ["insurance", "insurance"],
    ["oracleAdapter", "oracle_adapter"],
    ["liquidation", "liquidation"],
    ["riskParams", "risk_params"],
    ["timelock", "timelock"],
  ];
  for (const [key, json] of pairs) {
    const served = api.contracts[json];
    if (!served || !eq(served, contracts[key])) problems.push(`${json} ${served ?? "missing"} != ${contracts[key]}`);
  }
  return {
    id: "api.config",
    status: verdict(problems.length === 0),
    detail: problems.length === 0 ? "the app serves the deployment's addresses" : problems.join("; "),
  };
}

export interface MarketRow {
  id: number;
  active: boolean;
}

/**
 * The indexed markets match the chain's listings, ids and active flags alike.
 *
 * An inactive flag on a market the chain has live is not cosmetic: order
 * intake rejects every order for it. This is the shape of the bug that made
 * `Market.active` false for a whole deployment.
 */
export function checkMarketParity(indexed: MarketRow[], onChain: MarketRow[]): GateCheck {
  const byId = new Map(indexed.map((m) => [m.id, m]));
  const problems: string[] = [];
  for (const c of onChain) {
    const row = byId.get(c.id);
    if (!row) problems.push(`market ${c.id} is not indexed`);
    else if (row.active !== c.active) problems.push(`market ${c.id}: indexed active=${row.active}, chain says ${c.active}`);
  }
  for (const row of indexed) {
    if (!onChain.some((c) => c.id === row.id)) problems.push(`market ${row.id} is indexed but not listed on chain`);
  }
  const live = onChain.filter((m) => m.active).length;
  return {
    id: "markets.parity",
    status: verdict(problems.length === 0),
    detail: problems.length === 0 ? `${onChain.length} markets indexed, ${live} active, matching the chain` : problems.join("; "),
  };
}

/** `/api/markets` agrees with the chain too (the app's own read path). */
export function checkApiMarkets(served: MarketRow[], onChain: MarketRow[]): GateCheck {
  const base = checkMarketParity(served, onChain);
  return { ...base, id: "api.markets", detail: base.status === "ok" ? `the API lists ${served.length} markets, matching the chain` : base.detail };
}

/** `/api/ready`: 200 and no configuration problems. */
export function checkReady(status: number, body: { ok?: boolean; error?: string; problems?: number }): GateCheck {
  const ok = status === 200 && body.ok !== false;
  return {
    id: "api.ready",
    status: verdict(ok),
    detail: ok
      ? "the app reports ready"
      : `HTTP ${status}${body.error ? ` ${body.error}` : ""}${body.problems ? ` (${body.problems} config problem(s); see the app's log)` : ""}`,
  };
}

/** Deposits are open, or deliberately closed. Reported, never failed. */
export function describeCaps(total: bigint, perAccount: bigint, deposited: bigint): GateCheck {
  const usdc = (v: bigint) => `$${(v / 1_000_000n).toLocaleString("en-US")}`;
  return {
    id: "vault.caps",
    status: "ok",
    detail:
      total === 0n
        ? "deposits are CLOSED (cap 0): raise the cap through the timelock to open the venue"
        : `deposits open: ${usdc(deposited)} of ${usdc(total)} used, ${usdc(perAccount)} per account`,
  };
}

export function summarise(checks: GateCheck[], opts: { strict?: boolean } = {}): {
  ok: boolean;
  failed: GateCheck[];
  warned: GateCheck[];
} {
  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  return { ok: failed.length === 0 && (!opts.strict || warned.length === 0), failed, warned };
}

/** A fixed-width table, so a terminal shows what passed and what did not. */
export function renderChecks(checks: GateCheck[]): string {
  const width = Math.max(...checks.map((c) => c.id.length));
  const label = { ok: "ok  ", warn: "WARN", fail: "FAIL" } as const;
  return checks.map((c) => `${label[c.status]}  ${c.id.padEnd(width)}  ${c.detail}`).join("\n");
}
