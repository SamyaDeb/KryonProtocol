import { test } from "node:test";
import assert from "node:assert/strict";

import { geoDecision, parseBlockedCountries, requestCountry } from "./geoblock";

const headers = (h: Record<string, string>) => new Headers(h);

test("the blocked list: codes only, case-insensitive, empty by default", () => {
  assert.deepEqual([...parseBlockedCountries(" us, gb ,xyz,, 1a")], ["US", "GB"]);
  assert.equal(parseBlockedCountries(undefined).size, 0);
});

test("country from the CDN headers; unknown is null", () => {
  assert.equal(requestCountry(headers({ "cf-ipcountry": "us" })), "US");
  assert.equal(requestCountry(headers({ "x-vercel-ip-country": "GB" })), "GB");
  assert.equal(requestCountry(headers({ "cf-ipcountry": "XX" })), null);
  assert.equal(requestCountry(headers({})), null);
});

test("blocked pages rewrite, blocked APIs get 451, legal and health stay open", () => {
  const blocked = parseBlockedCountries("US");
  assert.deepEqual(geoDecision("/trade/BTC-PERP", "US", blocked), { action: "rewrite", to: "/restricted" });
  assert.deepEqual(geoDecision("/api/orders", "US", blocked), { action: "reject", status: 451 });
  for (const open of ["/restricted", "/terms", "/privacy", "/risk", "/api/health", "/api/time"]) {
    assert.deepEqual(geoDecision(open, "US", blocked), { action: "allow" }, open);
  }
  assert.deepEqual(geoDecision("/trade/BTC-PERP", "DE", blocked), { action: "allow" });
  assert.deepEqual(geoDecision("/trade/BTC-PERP", null, blocked), { action: "allow" }, "no header, no block");
  assert.deepEqual(geoDecision("/trade/BTC-PERP", "US", new Set()), { action: "allow" }, "empty list blocks nothing");
});
