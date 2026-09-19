#!/usr/bin/env node
/**
 * npm audit as a merge gate.
 *
 *   node .github/scripts/npm-audit-gate.mjs client kryon-protocol
 *
 * Blocking: High and Critical advisories in PRODUCTION dependencies. Advisory:
 * everything else (dev dependencies, moderate and below), reported to the job
 * summary only, because advisory databases change daily and a hard fail on
 * every new moderate would make green builds non-deterministic.
 *
 * Exceptions live in .github/npm-audit-allowlist.json, one entry per advisory,
 * each with a reason, an owner and an expiry date. An expired entry fails the
 * gate: an exception has to be renewed deliberately, not forgotten. An entry
 * that no longer matches anything is reported so it can be deleted.
 *
 * `--package-lock-only` keeps the result a function of the lockfile alone, so
 * the gate never depends on an install.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const ALLOWLIST = resolve(ROOT, ".github/npm-audit-allowlist.json");
const BLOCKING = new Set(["high", "critical"]);
const workspaces = process.argv.slice(2);
if (workspaces.length === 0) {
  console.error("usage: npm-audit-gate.mjs <workspace> [workspace...]");
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);
const allowlist = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
const byId = new Map(allowlist.advisories.map((a) => [a.id, a]));
const used = new Set();

/** `npm audit` exits non-zero when it finds anything; that is not an error. */
function audit(dir, omitDev) {
  const args = ["audit", "--json", "--package-lock-only"];
  if (omitDev) args.push("--omit=dev");
  try {
    return JSON.parse(execFileSync("npm", args, { cwd: resolve(ROOT, dir), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    if (e.stdout) return JSON.parse(e.stdout);
    throw e;
  }
}

/** Flatten npm's tree into one row per (advisory, package). */
function advisories(report) {
  const out = new Map();
  for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of v.via) {
      if (typeof via !== "object") continue; // a string `via` points at another package's entry
      const id = via.url?.split("/").pop() ?? `npm-${via.source}`;
      const key = `${id}::${via.name ?? name}`;
      if (!out.has(key)) {
        out.set(key, { id, package: via.name ?? name, severity: via.severity, title: via.title, dependent: name, fix: v.fixAvailable });
      }
    }
  }
  return [...out.values()];
}

const summary = [];
const blocked = [];

for (const ws of workspaces) {
  const prod = advisories(audit(ws, true)).filter((a) => BLOCKING.has(a.severity));
  const all = audit(ws, false).metadata?.vulnerabilities ?? {};
  summary.push(`### ${ws}`, "", `Advisory totals (including dev): ${JSON.stringify(all)}`, "");

  if (prod.length === 0) {
    summary.push("No High or Critical advisories in production dependencies.", "");
    continue;
  }
  summary.push("| advisory | package | severity | allowlisted until | title |", "|---|---|---|---|---|");
  for (const a of prod) {
    const entry = byId.get(a.id);
    let state;
    if (!entry) {
      state = "**not allowlisted**";
      blocked.push({ ...a, why: "not allowlisted" });
    } else {
      used.add(a.id);
      if (entry.expires < today) {
        state = `**expired ${entry.expires}**`;
        blocked.push({ ...a, why: `allowlist entry expired ${entry.expires} (owner: ${entry.owner})` });
      } else {
        state = entry.expires;
      }
    }
    summary.push(`| ${a.id} | ${a.package} | ${a.severity} | ${state} | ${(a.title ?? "").replaceAll("|", "\\|").slice(0, 90)} |`);
  }
  summary.push("");
}

const stale = allowlist.advisories.filter((a) => !used.has(a.id));
if (stale.length > 0) {
  summary.push("### Allowlist entries no longer matching anything (delete them)", "", ...stale.map((a) => `- ${a.id} (${a.package})`), "");
}

const text = summary.join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## npm audit gate\n\n${text}\n`);

for (const b of blocked) {
  console.log(`::error::${b.severity} ${b.id} in ${b.package} (via ${b.dependent}): ${b.why}`);
}
if (blocked.length > 0) {
  console.log(`\n${blocked.length} blocking advisories. Fix the dependency, or add a dated entry to .github/npm-audit-allowlist.json with a reason and an owner.`);
  process.exit(1);
}
