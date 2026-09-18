// Every identifier the query layer and the API routes put in SQL must exist in
// the Arc schema.
//
// This is the test that would have caught the drift step 2 fixed. When the
// schema moved to the Arc baseline, the routes kept inserting `"Account"
// (address, collateral, "cancelledNonces", …)` — columns that no longer
// existed — and every check stayed green, because the SQL lives in strings and
// `tsc` cannot see into a string.
//
// How: parse the baseline migration for its tables, columns, enum types and
// enum values; lex every template literal in the SQL-bearing sources; fail on
// any double-quoted identifier that is neither in the schema nor declared as an
// alias (`AS "x"`) in the same file, and on any single-quoted enum-looking
// literal that is not a value of some enum. No database needed, so it runs in
// every CI job; the database-backed suites then execute the same statements.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { migrationSql } from "@/lib/test/pg";

interface Schema {
  tables: Map<string, Set<string>>;
  enums: Map<string, Set<string>>;
}

function parseSchema(sql: string): Schema {
  const tables = new Map<string, Set<string>>();
  const enums = new Map<string, Set<string>>();
  for (const [, name, values] of sql.matchAll(/CREATE TYPE "(\w+)" AS ENUM \(([^)]*)\)/g)) {
    enums.set(name, new Set([...values.matchAll(/'(\w+)'/g)].map((m) => m[1])));
  }
  for (const [, name, body] of sql.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g)) {
    tables.set(name, new Set([...body.matchAll(/^\s+"(\w+)"\s/gm)].map((m) => m[1])));
  }
  return { tables, enums };
}

/**
 * The raw text of every template literal in a TypeScript source, including
 * those nested inside `${…}` of another. A real lexer rather than a regex: a
 * regex over backticks mis-pairs nested templates and then reads ordinary
 * `"strings"` in code as SQL identifiers.
 */
export function templateLiterals(src: string): string[] {
  const out: string[] = [];
  // Stack of open templates (their accumulated text) and, per `${`, brace depth.
  const templates: string[] = [];
  const braceDepth: number[] = [];
  let i = 0;
  const inTemplate = () => templates.length > 0 && braceDepth.length < templates.length;

  while (i < src.length) {
    const c = src[i];
    if (inTemplate()) {
      if (c === "\\") {
        templates[templates.length - 1] += src.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        out.push(templates.pop()!);
        i += 1;
      } else if (c === "$" && src[i + 1] === "{") {
        templates[templates.length - 1] += "${}";
        braceDepth.push(0);
        i += 2;
      } else {
        templates[templates.length - 1] += c;
        i += 1;
      }
      continue;
    }
    // Code (top level, or inside a `${…}`).
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 2;
      if (i < 2) break;
    } else if (c === '"' || c === "'") {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (c === "`") {
      templates.push("");
      i += 1;
    } else if (c === "{" && braceDepth.length > 0) {
      braceDepth[braceDepth.length - 1] += 1;
      i += 1;
    } else if (c === "}" && braceDepth.length > 0) {
      if (braceDepth[braceDepth.length - 1] === 0) braceDepth.pop();
      else braceDepth[braceDepth.length - 1] -= 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  return out;
}

/** Problems with the SQL in one source file, as readable strings. */
export function driftIn(src: string, schema: Schema): string[] {
  const known = new Set<string>([...schema.tables.keys(), ...schema.enums.keys()]);
  for (const cols of schema.tables.values()) for (const c of cols) known.add(c);
  const enumValues = new Set<string>();
  for (const vals of schema.enums.values()) for (const v of vals) enumValues.add(v);

  const templates = templateLiterals(src);
  const aliases = new Set<string>();
  for (const t of templates) for (const [, a] of t.matchAll(/\bAS\s+"(\w+)"/gi)) aliases.add(a);

  const problems: string[] = [];
  for (const t of templates) {
    // Only templates that are SQL. A UI string in backticks is not.
    if (!/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b/.test(t)) continue;
    for (const [, id] of t.matchAll(/"(\w+)"/g)) {
      if (!known.has(id) && !aliases.has(id)) problems.push(`unknown identifier "${id}"`);
    }
    for (const [, lit] of t.matchAll(/'([A-Z][A-Z_]+)'/g)) {
      if (!enumValues.has(lit)) problems.push(`unknown enum value '${lit}'`);
    }
    for (const [, list] of t.matchAll(/'\{([A-Z_,]+)\}'/g)) {
      for (const v of list.split(",")) if (!enumValues.has(v)) problems.push(`unknown enum value '${v}'`);
    }
  }
  return [...new Set(problems)];
}

function sqlSources(): string[] {
  const files: string[] = [];
  for (const f of readdirSync("lib/queries")) {
    if (f.endsWith(".ts") && !f.endsWith(".test.ts")) files.push(join("lib/queries", f));
  }
  for (const f of readdirSync("app/api", { recursive: true, encoding: "utf8" })) {
    if (f.endsWith("route.ts")) files.push(join("app/api", f));
  }
  return files.sort();
}

const schema = parseSchema(migrationSql());

test("the migration parser finds the Arc schema", () => {
  // A parser that silently found nothing would make the drift check vacuous.
  assert.ok(schema.tables.get("Order")?.has("filledSize"), "Order.filledSize not parsed");
  assert.ok(schema.tables.get("Account")?.has("minValidNonce"), "Account.minValidNonce not parsed");
  assert.ok(schema.enums.get("FillStatus")?.has("PENDING"), "FillStatus not parsed");
  assert.ok(schema.tables.size >= 25, `expected the full schema, parsed ${schema.tables.size} tables`);
});

test("the lexer handles nested templates and ignores code strings", () => {
  const src =
    'const a = "notSql"; const q = `SELECT "x" FROM (${f(`AND "y" = 1`)}) WHERE "z" = \'OPEN\'`;';
  const t = templateLiterals(src);
  assert.deepEqual(t, ['AND "y" = 1', 'SELECT "x" FROM (${}) WHERE "z" = \'OPEN\'']);
});

test("the check catches the drift step 2 fixed", () => {
  // Verbatim from the pre-Arc order intake.
  const legacy = [
    "await sql`",
    '  INSERT INTO "Account" (address, collateral, "cancelledNonces", "filledByNonce", "createdAt", "updatedAt")',
    "  VALUES (${o.owner}, '{}', ARRAY[]::BIGINT[], '{}', NOW(), NOW())",
    "`;",
    "await sql`SELECT \"expiryTs\" FROM \"Order\" WHERE status = 'QUEUED'`;",
  ].join("\n");
  const problems = driftIn(legacy, schema);
  assert.ok(problems.includes('unknown identifier "cancelledNonces"'), problems.join("; "));
  assert.ok(problems.includes('unknown identifier "filledByNonce"'), problems.join("; "));
  assert.ok(problems.includes('unknown identifier "expiryTs"'), problems.join("; "));
  assert.ok(problems.includes("unknown enum value 'QUEUED'"), problems.join("; "));
});

/**
 * Routes still issuing the previous schema's SQL, replaced by the EIP-712
 * intake (roadmap Phase 3 step 3). Like QUARANTINED, this list may only
 * shrink: an entry that no longer drifts fails the staleness test below.
 */
const AWAITING_STEP_3 = new Set([
  "app/api/orders/route.ts",
  "app/api/orders/cancel/route.ts",
  "app/api/orders/cancel-all/route.ts",
]);

test("every SQL identifier in the query layer and the API routes exists in the schema", () => {
  const files = sqlSources();
  assert.ok(files.some((f) => f.endsWith("orders.ts")), "lib/queries not scanned");
  assert.ok(files.length >= 20, `expected the query layer and routes, found ${files.length} files`);
  const failures: string[] = [];
  for (const f of files) {
    if (AWAITING_STEP_3.has(f)) continue;
    for (const p of driftIn(readFileSync(f, "utf8"), schema)) failures.push(`${f}: ${p}`);
  }
  assert.deepEqual(failures, [], "SQL references something the Arc schema does not define:\n  " + failures.join("\n  "));
});

test("the step-3 allowlist has no stale entries", () => {
  // `cancel/route.ts` uses unquoted legacy columns this lexer cannot see, so an
  // entry counts as live while it still reads the old chain's config.
  const stale = [...AWAITING_STEP_3].filter((f) => {
    const src = readFileSync(f, "utf8");
    return driftIn(src, schema).length === 0 && !/legacy-(config|network-server)/.test(src);
  });
  assert.deepEqual(stale, [], "These routes are ported — remove them from AWAITING_STEP_3:\n  " + stale.join("\n  "));
});
