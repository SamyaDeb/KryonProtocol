#!/usr/bin/env tsx
import { neon } from "../lib/sql";
import { readFileSync } from "fs";

// Split SQL into individual statements, keeping $$-quoted bodies (DO blocks,
// function bodies) intact. Neon's HTTP query runs one command per call, so we
// must hand it exactly one statement at a time.
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let dollar = false;
  for (let i = 0; i < sql.length; i++) {
    const two = sql.slice(i, i + 2);
    if (two === "$$") { dollar = !dollar; buf += two; i++; continue; }
    const ch = sql[i];
    buf += ch;
    if (ch === ";" && !dollar) { out.push(buf.trim()); buf = ""; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => {
    const code = s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    return code.length > 0;
  });
}

async function main() {
  const sqlClient = neon(process.env.DATABASE_URL!);
  const path = process.argv[2];
  if (!path) { console.error("usage: apply-migration.ts <path.sql>"); process.exit(1); }

  const statements = splitStatements(readFileSync(path, "utf8"));
  let applied = 0;
  for (const stmt of statements) {
    await sqlClient.query(stmt);
    applied++;
  }
  console.log(`✓ applied ${applied} statements from ${path}`);
}
main().catch((e) => { console.error("✗ migration failed:", e.message); process.exit(1); });
