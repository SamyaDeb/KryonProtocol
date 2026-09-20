#!/usr/bin/env tsx
/**
 * ops — operate a Kryon venue through its timelock.
 *
 * Every admin function belongs to `KryonTimelock`, so nothing here calls a
 * contract directly. A change is SCHEDULED, waits at least 48 hours (the
 * contract's own minimum, on testnet as on mainnet), and is then EXECUTED.
 * Plan accordingly: the fix you want today is the operation you schedule two
 * days before.
 *
 *   npm run ops -- status                          what the venue looks like now
 *   npm run ops -- queue                           scheduled operations and when they are ready
 *
 *   npm run ops -- market pause 2                  # preview only
 *   npm run ops -- market pause 2 --send           # schedule it
 *   npm run ops -- market unpause 2 --send
 *   npm run ops -- market apply btc --send         # the TOML's parameters for that market
 *   npm run ops -- caps 250000 10000 --send        # USDC, whole units
 *   npm run ops -- fees 2 -50 350 --send           # maker, taker, in millionths
 *   npm run ops -- liquidation 15 5000 --send
 *   npm run ops -- publishers 0xa,0xb --send       # replaces the whole set
 *   npm run ops -- role grant insurance BACKSTOP_SIGNER_ROLE 0x… --send
 *   npm run ops -- role revoke orderGateway OPERATOR_ROLE 0x… --send
 *
 *   npm run ops -- execute <operationId> --send    # once it is ready
 *   npm run ops -- cancel <operationId> --send
 *
 * Nothing is sent without `--send`: a preview prints the target, the decoded
 * effect in words, the calldata, the operation id and the time it becomes
 * executable. Scheduling also writes a receipt next to the keystores
 * (~/.kryon/ops/<network>/<id>.json) so `execute` can reproduce the exact
 * arguments even if the indexer is behind.
 *
 * Signs with the governance key: KRYON_SIGNER_GOVERNANCE (keystore or kms; on
 * arc-local a plain GOVERNANCE_PRIVATE_KEY works). It must hold PROPOSER_ROLE
 * to schedule and EXECUTOR_ROLE to execute.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { decodeFunctionData, encodeFunctionData, formatUnits, parseUnits, type Address, type Hex } from "viem";

import { kryonTimelockAbi, riskParamsAbi, vaultAbi, feeRouterAbi } from "@/lib/chain/contracts";
import type { ProtocolContracts } from "@/lib/chain/networks";
import { assertServiceConfig } from "@/lib/config-check";
import { bootstrap, createSender, type KeeperContext } from "@/lib/keepers/runtime";
import {
  grantRole,
  operationSalt,
  revokeRole,
  ROLE_NAMES,
  scheduledCall,
  setDepositCaps,
  setLiquidationParams,
  setMarket,
  setMarketActive,
  setMarketFees,
  setPublishers,
  type ContractKey,
  type Operation,
  type RoleName,
  type ScheduledCall,
} from "@/lib/ops/operations";
import { marketParamsFromToml, readEnvironmentToml } from "@/lib/ops/environment";
import { neon } from "@/lib/sql";

const argv = process.argv.slice(2);
const SEND = argv.includes("--send");
const args = argv.filter((a) => !a.startsWith("--"));
const say = (s = "") => process.stdout.write(`${s}\n`);
const die = (m: string): never => {
  process.stderr.write(`ops: ${m}\n`);
  process.exit(1);
};

const RECEIPTS = (network: string) => join(homedir(), ".kryon", "ops", network);

async function main() {
  const command = args[0];
  if (!command) return die("what should I do? See the header of scripts/ops.ts for the commands.");

  assertServiceConfig("monitor"); // chain reads + database, no key of its own
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return die("DATABASE_URL is not set");
  const sql = neon(databaseUrl);
  const ctx = await bootstrap({ service: "ops", sql, env: process.env });

  try {
    switch (command) {
      case "status":
        await status(ctx);
        break;
      case "queue":
        await queue(ctx, sql);
        break;
      case "execute":
      case "cancel":
        await runQueued(ctx, sql, command, args[1]);
        break;
      default:
        await schedule(ctx, sql, buildOperation(ctx.contracts, args));
    }
  } finally {
    await sql.end();
  }
}

/** Turn the command line into one operation, or explain what was expected. */
function buildOperation(contracts: ProtocolContracts, a: string[]): Operation {
  const need = (i: number, what: string) => a[i] ?? die(`expected ${what}`);
  switch (a[0]) {
    case "market": {
      const sub = need(1, "pause | unpause | apply");
      if (sub === "pause" || sub === "unpause") return setMarketActive(Number(need(2, "a market id")), sub === "unpause");
      if (sub === "apply") {
        const key = need(2, "a market key from the environment TOML (btc, eth, …)");
        const toml = readEnvironmentToml(process.env.KRYON_NETWORK ?? "arc-testnet");
        const { marketId, params } = marketParamsFromToml(toml, key);
        return setMarket(marketId, params);
      }
      return die(`unknown market command "${sub}"`);
    }
    case "caps": {
      const total = parseUnits(need(1, "a total cap in USDC"), 6);
      const perAccount = parseUnits(need(2, "a per-account cap in USDC"), 6);
      return setDepositCaps(total, perAccount);
    }
    case "fees":
      return setMarketFees(Number(need(1, "a market id")), Number(need(2, "a maker rate")), Number(need(3, "a taker rate")));
    case "liquidation":
      return setLiquidationParams(Number(need(1, "maxRewardBps")), Number(need(2, "partialLiquidationBps")));
    case "publishers":
      return setPublishers(need(1, "comma-separated publisher addresses").split(",").map((x) => x.trim() as Address));
    case "role": {
      const verb = need(1, "grant | revoke");
      const contract = need(2, "a contract key") as ContractKey;
      const role = need(3, `a role (${ROLE_NAMES.join(", ")})`) as RoleName;
      const account = need(4, "an address") as Address;
      if (!(contract in contracts)) return die(`unknown contract "${contract}"`);
      if (!ROLE_NAMES.includes(role)) return die(`unknown role "${role}"`);
      return verb === "grant" ? grantRole(contract, role, account) : verb === "revoke" ? revokeRole(contract, role, account) : die(`unknown role command "${verb}"`);
    }
    default:
      return die(`unknown command "${a[0]}"`);
  }
}

async function schedule(ctx: KeeperContext, sql: ReturnType<typeof neon>, op: Operation) {
  const delay = (await ctx.client.readContract({
    address: ctx.contracts.timelock,
    abi: kryonTimelockAbi,
    functionName: "getMinDelay",
  })) as bigint;
  const salt = operationSalt(op.description, Date.now());
  const call = scheduledCall(op, ctx.contracts, salt, delay);
  const id = (await ctx.client.readContract({
    address: ctx.contracts.timelock,
    abi: kryonTimelockAbi,
    functionName: "hashOperation",
    args: [call.target, call.value, call.data, call.predecessor, call.salt],
  })) as Hex;
  const readyAt = new Date(Date.now() + Number(delay) * 1000);

  say(`\n${op.description}\n`);
  say(`  contract     ${op.contract} ${call.target}`);
  say(`  calldata     ${call.data}`);
  say(`  operation    ${id}`);
  say(`  salt         ${call.salt}`);
  say(`  delay        ${Number(delay) / 3600}h — executable from ${readyAt.toISOString()}`);

  if (!SEND) {
    say(`\nPreview only. Re-run with --send to schedule it.\n`);
    return;
  }

  const sender = await createSender({ ctx, service: "ops", keyEnvVar: "GOVERNANCE_PRIVATE_KEY", env: process.env });
  const data = encodeFunctionData({
    abi: kryonTimelockAbi,
    functionName: "schedule",
    args: [call.target, call.value, call.data, call.predecessor, call.salt, call.delaySeconds],
  });
  const outcome = await sender.send({ to: ctx.contracts.timelock, data, label: `schedule ${id.slice(0, 10)}` });
  const dir = RECEIPTS(ctx.network.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({ id, description: op.description, network: ctx.network.id, ...serialisable(call), readyAt: readyAt.toISOString() }, null, 2)
  );
  say(`\nScheduled in ${outcome.receipt.transactionHash}. Receipt written to ${join(dir, `${id}.json`)}.`);
  say(`Execute it after ${readyAt.toISOString()}:  npm run ops -- execute ${id} --send\n`);
  void sql;
}

function serialisable(call: ScheduledCall) {
  return { target: call.target, value: call.value.toString(), data: call.data, predecessor: call.predecessor, salt: call.salt, delaySeconds: call.delaySeconds.toString() };
}

/** The scheduled call for an id: the local receipt first, then the indexer. */
async function findCall(ctx: KeeperContext, sql: ReturnType<typeof neon>, id: string): Promise<ScheduledCall & { description: string }> {
  try {
    const raw = JSON.parse(readFileSync(join(RECEIPTS(ctx.network.id), `${id}.json`), "utf8")) as Record<string, string>;
    return {
      target: raw.target as Address,
      value: BigInt(raw.value),
      data: raw.data as Hex,
      predecessor: raw.predecessor as Hex,
      salt: raw.salt as Hex,
      delaySeconds: BigInt(raw.delaySeconds),
      description: raw.description ?? "(from receipt)",
    };
  } catch {
    /* fall through to the indexer */
  }
  const rows = await sql.query<{ calls: unknown; salt: string; predecessor: string; description: string | null }[]>(
    `SELECT "calls", "salt", "predecessor", "description" FROM "GovernanceOperation" WHERE "network" = $1 AND "operationId" = $2`,
    [ctx.network.id, id]
  );
  const row = rows[0];
  if (!row) return die(`operation ${id} is neither in ~/.kryon/ops nor indexed on ${ctx.network.id}`);
  const calls = (Array.isArray(row.calls) ? row.calls : []) as { target: string; value: string; data: string }[];
  if (calls.length !== 1) return die(`operation ${id} has ${calls.length} calls; batch operations are not supported here`);
  return {
    target: calls[0].target as Address,
    value: BigInt(calls[0].value ?? 0),
    data: calls[0].data as Hex,
    predecessor: row.predecessor as Hex,
    salt: row.salt as Hex,
    delaySeconds: 0n,
    description: row.description ?? describeCall(calls[0].data as Hex),
  };
}

async function runQueued(ctx: KeeperContext, sql: ReturnType<typeof neon>, verb: "execute" | "cancel", id?: string) {
  if (!id) return die(`expected an operation id: npm run ops -- ${verb} <operationId> --send`);
  const call = await findCall(ctx, sql, id);
  const ready = (await ctx.client.readContract({
    address: ctx.contracts.timelock,
    abi: kryonTimelockAbi,
    functionName: "isOperationReady",
    args: [id as Hex],
  })) as boolean;

  say(`\n${verb === "execute" ? "Execute" : "Cancel"}: ${call.description}`);
  say(`  operation    ${id}`);
  say(`  ready        ${ready ? "yes" : "NOT YET (the timelock will revert)"}`);
  if (!SEND) {
    say(`\nPreview only. Re-run with --send.\n`);
    return;
  }
  if (verb === "execute" && !ready) return die("the operation is not ready yet; the timelock would revert");

  const sender = await createSender({ ctx, service: "ops", keyEnvVar: "GOVERNANCE_PRIVATE_KEY", env: process.env });
  const data =
    verb === "execute"
      ? encodeFunctionData({ abi: kryonTimelockAbi, functionName: "execute", args: [call.target, call.value, call.data, call.predecessor, call.salt] })
      : encodeFunctionData({ abi: kryonTimelockAbi, functionName: "cancel", args: [id as Hex] });
  const outcome = await sender.send({ to: ctx.contracts.timelock, data, label: `${verb} ${id.slice(0, 10)}` });
  say(`\n${verb === "execute" ? "Executed" : "Cancelled"} in ${outcome.receipt.transactionHash}.\n`);
}

/** Best-effort words for calldata the indexer stored but we did not build. */
function describeCall(data: Hex): string {
  for (const abi of [riskParamsAbi, vaultAbi, feeRouterAbi]) {
    try {
      const d = decodeFunctionData({ abi, data });
      return `${d.functionName}(${(d.args ?? []).map(String).join(", ")})`;
    } catch {
      /* not this one */
    }
  }
  return `unrecognised calldata ${data.slice(0, 10)}`;
}

async function queue(ctx: KeeperContext, sql: ReturnType<typeof neon>) {
  const rows = await sql.query<{ operationId: string; status: string; readyAt: string; description: string | null; calls: unknown }[]>(
    `SELECT "operationId", "status"::text AS "status", "readyAt", "description", "calls"
     FROM "GovernanceOperation" WHERE "network" = $1 ORDER BY ("status" = 'SCHEDULED') DESC, "readyAt" DESC LIMIT 25`,
    [ctx.network.id]
  );
  if (rows.length === 0) return say("\nNo governance operations on this network.\n");
  say(`\nGovernance queue — ${ctx.network.id}\n`);
  for (const r of rows) {
    const readyAt = new Date(r.readyAt);
    const when = r.status !== "SCHEDULED" ? "" : readyAt.getTime() <= Date.now() ? "  READY" : `  ready ${readyAt.toISOString()}`;
    const calls = (Array.isArray(r.calls) ? r.calls : []) as { data: string }[];
    say(`  ${r.status.padEnd(9)} ${r.operationId.slice(0, 12)}…${when}`);
    say(`            ${r.description ?? calls.map((c) => describeCall(c.data as Hex)).join("; ")}`);
  }
  say("");
}

async function status(ctx: KeeperContext) {
  const [caps, deposited, minDelay] = await Promise.all([
    ctx.client.readContract({ address: ctx.contracts.vault, abi: vaultAbi, functionName: "depositCaps" }),
    ctx.client.readContract({ address: ctx.contracts.vault, abi: vaultAbi, functionName: "totalDeposited" }),
    ctx.client.readContract({ address: ctx.contracts.timelock, abi: kryonTimelockAbi, functionName: "getMinDelay" }),
  ]);
  const ids = (await ctx.client.readContract({ address: ctx.contracts.riskParams, abi: riskParamsAbi, functionName: "marketIds" })) as readonly number[];

  say(`\nVenue — ${ctx.network.id} (chain ${ctx.network.chainId})\n`);
  say(`  timelock delay   ${Number(minDelay) / 3600}h`);
  say(`  deposit caps     $${formatUnits(caps[0], 6)} total, $${formatUnits(caps[1], 6)} per account${caps[0] === 0n ? "  (CLOSED)" : ""}`);
  say(`  deposited        $${formatUnits(deposited as bigint, 6)}`);
  say(`\n  market  active  maker/taker      min fill   max OI`);
  for (const id of ids) {
    const m = await ctx.client.readContract({ address: ctx.contracts.riskParams, abi: riskParamsAbi, functionName: "market", args: [id] });
    // `marketRates` returns a struct: { makerRate, takerRate, set }.
    const fees = (await ctx.client
      .readContract({ address: ctx.contracts.feeRouter, abi: feeRouterAbi, functionName: "marketRates", args: [id] })
      .catch(() => null)) as { makerRate: number; takerRate: number; set: boolean } | null;
    const rates = fees?.set ? `${(fees.makerRate / 100).toFixed(2)}/${(fees.takerRate / 100).toFixed(2)} bps` : "not set";
    const minFill = `$${m.minFillNotional / 10n ** 18n}`;
    say(`  ${String(id).padEnd(7)} ${(m.active ? "yes" : "no").padEnd(7)} ${rates.padEnd(16)} ${minFill.padEnd(10)} ${m.maxOpenInterest / 10n ** 18n}`);
  }
  say("");
}

main().catch((err) => {
  process.stderr.write(`ops: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
