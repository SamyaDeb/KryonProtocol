// The previous chain is gone from the app. This keeps it gone: no source file
// may import its modules or SDKs, the directory that held them may not come
// back, and neither may the packages. It runs with every `npm test`, so CI
// fails on a regression.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const SOURCE_ROOTS = ["app", "lib", "features", "components", "stores", "scripts"];

/** Import specifiers that belong to the previous chain. */
const LEGACY_SPECIFIER = /(?:^|\/)(?:lib\/stellar(?:\/|$)|legacy-(?:config|networks|network-server|format|math)$)|^@stellar\//;

/** `from "…"`, `import("…")` and `require("…")`: a mention in prose is not an import. */
const IMPORT_RE = /\b(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (/\.(?:tsx?|mjs|cjs|js)$/.test(entry)) out.push(`${root}/${entry}`);
    }
  }
  return out.sort();
}

test("the file scan actually finds files", () => {
  // A scan that matched nothing would make every assertion below vacuous.
  const files = sourceFiles();
  assert.ok(files.length > 50, `expected the app's sources, found ${files.length}`);
  assert.ok(files.includes("lib/network.ts"), "lib/network.ts not scanned");
});

test("no source file imports the previous chain", () => {
  const offenders: string[] = [];
  for (const f of sourceFiles()) {
    for (const [, spec] of readFileSync(f, "utf8").matchAll(IMPORT_RE)) {
      if (LEGACY_SPECIFIER.test(spec)) offenders.push(`${f} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], "Kryon runs on Arc; these import the previous chain:\n  " + offenders.join("\n  "));
});

test("lib/stellar is gone and stays gone", () => {
  assert.equal(existsSync("lib/stellar"), false);
});

test("no @stellar/* package in package.json", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, Record<string, string> | undefined>;
  const deps = [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies]
    .flatMap((d) => Object.keys(d ?? {}))
    .filter((name) => name.startsWith("@stellar/"));
  assert.deepEqual(deps, []);
});
