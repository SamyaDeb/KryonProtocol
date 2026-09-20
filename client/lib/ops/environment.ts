/**
 * Read `infra/deploy/environments/arc-*.toml`: the reviewed configuration a
 * deployment was built from.
 *
 * The ops CLI applies a market's parameters from this file rather than from
 * numbers typed at a prompt, so what governance schedules is what was
 * reviewed and committed — and `99_VerifyDeployment` compares the chain
 * against the same file.
 *
 * A deliberately small parser for the subset these files use: `[section]` and
 * `[section.sub]` headers, `key = value` with strings, integers, booleans and
 * arrays of strings, and `#` comments. No dependency, and it fails loudly on
 * anything it does not understand rather than guessing. `ConfigLoader.sol`
 * reads the same files with forge's own TOML support.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { toHex, type Hex } from "viem";

import type { MarketParamsInput } from "./operations";

export type TomlValue = string | number | boolean | string[];
export type TomlTable = Record<string, TomlValue>;
/** Sections by dotted name: "vault", "markets.btc". */
export type TomlDocument = Record<string, TomlTable>;

export function parseToml(text: string): TomlDocument {
  const doc: TomlDocument = { "": {} };
  let section = "";
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim();
    if (line === "") return;
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      doc[section] ??= {};
      return;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) throw new Error(`environment file: cannot read line ${i + 1}: ${raw.trim()}`);
    doc[section][pair[1]] = parseValue(pair[2].trim(), i + 1);
  });
  return doc;
}

function parseValue(raw: string, line: number): TomlValue {
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) throw new Error(`environment file: multi-line arrays are not supported (line ${line})`);
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((part) => {
      const s = part.trim();
      const str = /^"(.*)"$/.exec(s);
      if (!str) throw new Error(`environment file: array entries must be quoted strings (line ${line})`);
      return str[1];
    });
  }
  const str = /^"(.*)"$/.exec(raw);
  if (str) return str[1];
  if (raw === "true" || raw === "false") return raw === "true";
  if (/^-?\d+$/.test(raw)) return Number(raw);
  throw new Error(`environment file: cannot read value on line ${line}: ${raw}`);
}

/** The environment file for a network, from the repository. */
export function readEnvironmentToml(network: string, root?: string): TomlDocument {
  const base = root ?? resolve(import.meta.dirname, "../../../kryon-protocol/infra/deploy/environments");
  return parseToml(readFileSync(resolve(base, `${network}.toml`), "utf8"));
}

const str = (t: TomlTable, k: string, where: string): string => {
  const v = t[k];
  if (typeof v !== "string") throw new Error(`${where}: ${k} is missing or not a string`);
  return v;
};
const num = (t: TomlTable, k: string, where: string): number => {
  const v = t[k];
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  throw new Error(`${where}: ${k} is missing or not a number`);
};
const bool = (t: TomlTable, k: string, where: string): boolean => {
  const v = t[k];
  if (typeof v !== "boolean") throw new Error(`${where}: ${k} is missing or not a boolean`);
  return v;
};

/** `bytes32("BTC")`, as `oracleId` is stored on chain. */
export function oracleIdFor(symbol: string): Hex {
  return toHex(symbol, { size: 32 });
}

/**
 * One market's on-chain parameters, from its `[markets.<key>]` table.
 *
 * Sizes in the file are whole base units and whole USD (`max_open_interest =
 * "25"`, `min_fill_notional_usd = 40`); the chain wants 1e18, exactly as
 * `ConfigLoader.sol` scales them.
 */
export function marketParamsFromToml(doc: TomlDocument, key: string): { marketId: number; params: MarketParamsInput } {
  const t = doc[`markets.${key.toLowerCase()}`];
  if (!t) {
    const known = Object.keys(doc)
      .filter((s) => s.startsWith("markets."))
      .map((s) => s.slice("markets.".length));
    throw new Error(`no [markets.${key.toLowerCase()}] in the environment file (have: ${known.join(", ") || "none"})`);
  }
  const where = `markets.${key}`;
  return {
    marketId: num(t, "market_id", where),
    params: {
      oracleId: oracleIdFor(str(t, "oracle_id", where)),
      initialMarginBps: num(t, "initial_margin_bps", where),
      maintenanceMarginBps: num(t, "maintenance_margin_bps", where),
      liquidationFeeBps: num(t, "liquidation_fee_bps", where),
      maxExecutionDeviationBps: num(t, "max_execution_deviation_bps", where),
      maxOracleConfidenceBps: num(t, "max_oracle_confidence_bps", where),
      maxOracleAge: num(t, "max_oracle_age_secs", where),
      maxLeverageBps: num(t, "max_leverage_bps", where),
      active: bool(t, "active", where),
      // `setMarket` forces it true; carried for completeness.
      listed: true,
      maxOpenInterest: BigInt(num(t, "max_open_interest", where)) * 10n ** 18n,
      minFillNotional: BigInt(num(t, "min_fill_notional_usd", where)) * 10n ** 18n,
    },
  };
}
