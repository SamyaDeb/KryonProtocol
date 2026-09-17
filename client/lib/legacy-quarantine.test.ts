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

/** Modules that describe the previous, non-EVM deployment. */
const LEGACY_MODULES = /(?:^|\/)legacy-(?:config|networks|network-server)$/;

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
 * Each is on a known path out:
 *  - the trading UI (`features/trade/**`, `app/*Page`, the market pages and
 *    cells) renders old-chain amounts and Stellar explorer links, and is
 *    rewritten with the wallet/trading work, not here;
 *  - `lib/format|math|validation|stats` and `lib/market/*` do arithmetic in the
 *    old chain's 1e7 amount scale. Re-basing them on Arc's scales changes every
 *    number the UI renders, so it belongs with the UI rewrite rather than
 *    inside a config move;
 *  - the four API routes verify old-chain signed messages or sign Soroban
 *    transactions. Steps 2 and 3 replace them with Arc SQL and EIP-712.
 */
const QUARANTINED = new Set([
  "app/LandingPage.tsx",
  "app/api/markets/route.ts",
  "app/api/orders/cancel-all/route.ts",
  "app/api/orders/cancel/route.ts",
  "app/api/orders/route.ts",
  "app/api/settlements/[id]/sign/route.ts",
  "app/markets/page.tsx",
  "app/trade/[market]/page.tsx",
  "components/common/MarketCell.tsx",
  "components/common/TopNav.tsx",
  "features/collateral/useCollateral.ts",
  "features/trade/components/AccountBar.tsx",
  "features/trade/components/BottomPanel.tsx",
  "features/trade/components/DepositWithdrawDialog.tsx",
  "features/trade/components/FundingHistoryTable.tsx",
  "features/trade/components/MarketDataProvider.tsx",
  "features/trade/components/MarketHeader.tsx",
  "features/trade/components/MarketsTable.tsx",
  "features/trade/components/OrderBook.tsx",
  "features/trade/components/OrderEntry.tsx",
  "features/trade/components/PositionsTable.tsx",
  "features/trade/components/SettlementModal.tsx",
  "features/trade/components/TradeChart.tsx",
  "features/trade/components/TradeHistoryTable.tsx",
  "features/trade/components/TradeTerminalGrid.tsx",
  "features/wallet/components/WalletConnect.tsx",
  "lib/format.test.ts",
  "lib/format.ts",
  "lib/market/liquidation-sizing.ts",
  "lib/market/matcher.ts",
  "lib/market/signing-message.ts",
  "lib/math.ts",
  "lib/oracle-activity.ts",
  "lib/stats.ts",
  "lib/validation.ts",
]);

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
