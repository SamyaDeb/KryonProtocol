// The seam between the Arc code and the previous deployment's, enforced.
//
// `@/config` used to describe the old chain — Soroban RPC URLs, network
// passphrases, 7-decimal amounts, a `mainnet`/`testnet` network id — and it was
// imported from ~50 files, so nothing in the import graph told you whether a
// given module was talking to the new chain or the old one. That module now
// lives at `lib/stellar/legacy-config.ts`, where the path itself says which
// chain it describes.
//
// The point of the move is only kept by this test. Without it, the next hurried
// change re-imports `NETWORK.passphrase` into an Arc route, `tsc` says nothing
// (a string is a string), and the seam quietly closes back up.
//
// ── How to use the list below ────────────────────────────────────────────────
// QUARANTINED is a debt register, not a config knob. Every entry is a file the
// Arc migration has not reached yet. The list may SHRINK freely — deleting an
// entry as you port a file is the intended workflow and needs no ceremony.
// Adding one means new code was written against the old chain, which wants a
// conversation rather than an edit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Modules that describe the previous, non-EVM deployment: its config, and the
 * 1e7-scale number helpers (`lib/stellar/legacy-format`, `legacy-math`) that
 * `lib/format` and `lib/math` were before they moved to Arc's scales.
 */
const LEGACY_MODULES = /(?:^|\/)legacy-(?:config|networks|network-server|format|math)$/;

/**
 * Directories that are legacy by definition, so an import there carries no
 * information and is not worth listing file by file:
 *
 *  - `lib/stellar/**` is the old chain's client, quarantine included.
 *  - `scripts/**` holds the previous deployment's keepers. They run one network
 *    per process against the old chain and are replaced wholesale, not ported.
 */
const LEGACY_BY_LOCATION = [/^lib\/stellar\//, /^scripts\//];

/**
 * Files outside those directories that still read the old chain's config.
 *
 * Empty: the app runs on Arc throughout. It stays as a register so a
 * regression has somewhere visible to go, and `lib/stellar/**` itself is
 * deleted with its dependencies (Phase 4 PR 7).
 */
const QUARANTINED = new Set<string>([]);

const SOURCE_ROOTS = ["app", "lib", "features", "components", "stores", "scripts"];

/** `from "..."` / `from '...'` specifiers only — a mention in prose is not an import. */
const IMPORT_RE = /\bfrom\s+["']([^"']+)["']/g;

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (/\.tsx?$/.test(entry)) out.push(`${root}/${entry}`);
    }
  }
  return out.sort();
}

function importsLegacy(file: string): boolean {
  const text = readFileSync(file, "utf8");
  for (const [, specifier] of text.matchAll(IMPORT_RE)) {
    if (LEGACY_MODULES.test(specifier)) return true;
  }
  return false;
}

function offenders(): string[] {
  return sourceFiles().filter(
    (f) => !LEGACY_BY_LOCATION.some((re) => re.test(f)) && importsLegacy(f)
  );
}

test("the file scan actually finds files", () => {
  // A glob that silently matches nothing would make every assertion below pass
  // while checking nothing at all — the exact failure `run-unit-tests.mjs` was
  // written to prevent, reproduced one level down.
  const files = sourceFiles();
  assert.ok(files.length > 50, `expected the app's sources, found ${files.length}`);
  assert.ok(files.includes("lib/network.ts"), "lib/network.ts not scanned");
});

test("no new file reads the old chain's config", () => {
  const unexpected = offenders().filter((f) => !QUARANTINED.has(f));
  assert.deepEqual(
    unexpected,
    [],
    "These files import the previous deployment's config. Arc code resolves " +
      "networks through @/lib/network and markets through @/lib/markets + " +
      "@/lib/queries/markets:\n  " + unexpected.join("\n  ")
  );
});

test("the quarantine list has no stale entries", () => {
  // A ported file left on the list would silently re-authorise itself if it
  // ever regressed. Removing the entry is part of porting the file.
  const current = new Set(offenders());
  const stale = [...QUARANTINED].filter((f) => !current.has(f)).sort();
  assert.deepEqual(
    stale,
    [],
    "These no longer read the old chain's config — delete them from " +
      "QUARANTINED:\n  " + stale.join("\n  ")
  );
});

test("nothing under lib/queries or lib/chain is quarantined", () => {
  // The Arc data path is the one surface that must never have a foot in both
  // chains, because it is what steps 2 and 3 build on.
  for (const f of QUARANTINED) {
    assert.ok(
      !f.startsWith("lib/queries/") && !f.startsWith("lib/chain/"),
      `${f} is on the Arc data path and cannot be quarantined`
    );
  }
});
