#!/usr/bin/env node
/**
 * Unit-test runner that refuses to pass vacuously.
 *
 * `tsx --test "**\/*.test.ts"` exits 0 when the glob matches nothing. Combined
 * with `client/.gitignore` excluding `*.test.ts` from the repo, that made the
 * CI test step a false green: on a fresh checkout there are no test files, the
 * runner finds nothing, and the step reports success having verified nothing.
 * A build that manufactures confidence is worse than one with no test step at
 * all, because nobody goes looking for the gap.
 *
 * So: count the files first, and fail loudly with the actual reason when there
 * are none.
 */

import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PATTERN = "**/*.test.ts";
const IGNORE = ["node_modules/**", ".next/**", ".open-next/**", ".wrangler/**"];

const files = globSync(PATTERN, { exclude: (p) => IGNORE.some((i) => p.startsWith(i.split("/")[0])) });

if (files.length === 0) {
  console.error(
    [
      "No unit tests found.",
      "",
      "`client/.gitignore` excludes `*.test.ts` and `*.test.tsx` from the repository,",
      "so a fresh checkout — including every CI run — contains no test files. The test",
      "step would otherwise exit 0 having verified nothing.",
      "",
      "Resolve it one way or the other:",
      "  • track the tests  — drop the `*.test.ts` rules so CI actually runs them, or",
      "  • keep them local  — remove the `Unit tests` step from .github/workflows/ci.yml,",
      "                       since it cannot verify anything there.",
    ].join("\n")
  );
  process.exit(1);
}

// --test-concurrency=1: the suites that need a database share one physical
// database (KRYON_TEST_DATABASE_URL) and truncate tables in their fixtures, so
// running files in parallel lets one suite wipe another's rows mid-test. The
// indexer suite already narrowed its TRUNCATE to dodge this; that only works
// while no two suites own a table, which stopped being true once the
// reconciler started asserting on Fill. Serial execution costs a few seconds
// and removes the whole class of flake.
console.log(`running ${files.length} unit test file(s)`);
const result = spawnSync("tsx", ["--test", "--test-concurrency=1", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
