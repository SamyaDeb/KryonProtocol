// Timestamps must mean the same instant whoever writes them and whoever reads
// them back. `timestamp without time zone` carries no offset, and both the pg
// driver's formatter and its parser default to the PROCESS's timezone — so a
// web app on a host in Asia/Kolkata and a service that pins itself to UTC
// disagreed by the offset about the same row, in the direction that makes ages
// negative and staleness checks pass. Note that lib/test/pg.ts pins TZ=UTC for
// database-backed suites, which is why nothing here caught it before.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseUtcTimestamp, utcParams } from "./sql";

test("a Date parameter is sent as UTC, not as the writer's wall clock", () => {
  const at = new Date("2026-09-20T15:29:52.668Z");
  const [out] = utcParams([at]) as string[];
  assert.equal(out, "2026-09-20T15:29:52.668Z");
  assert.equal(new Date(out).getTime(), at.getTime());
});

test("everything else is passed through, and untouched arrays are not copied", () => {
  const params = ["arc-testnet", 42, null, undefined, 7n, { a: 1 }];
  assert.equal(utcParams(params), params, "no Date, no copy");
  const mixed = utcParams(["x", new Date(0), 3]);
  assert.deepEqual(mixed, ["x", "1970-01-01T00:00:00.000Z", 3]);
});

test("a stored timestamp is read back as the instant it was written", () => {
  // What Postgres hands back for a `timestamp` column: no zone, space separated.
  assert.equal(parseUtcTimestamp("2026-09-20 15:29:52.668").toISOString(), "2026-09-20T15:29:52.668Z");
  assert.equal(parseUtcTimestamp("2026-09-20 15:29:52").toISOString(), "2026-09-20T15:29:52.000Z");
});

test("the round trip survives a writer and a reader in different zones", () => {
  const at = new Date("2026-09-20T15:29:52.668Z");
  const sent = (utcParams([at]) as string[])[0];
  // Postgres drops the designator and stores the wall time it was given.
  const stored = sent.replace("T", " ").replace("Z", "");
  assert.equal(parseUtcTimestamp(stored).getTime(), at.getTime());
});
