/**
 * Alerting semantics: fires after N, does not repeat every tick, resolves
 * after M, honours the startup grace period — and a notifier that throws
 * never takes the loop down.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createLogger, Metrics } from "@/lib/keepers/runtime";

import { AlertEngine, overallLevel, type AlertEvent } from "./alerting";
import { fanout, formatText, webhookBody, detectFormat, isHostOrSubdomain, type Notifier } from "./notifier";
import { prometheus, statusJson, type MonitorSnapshotView } from "./exposition";
import type { CheckResult, Severity } from "./types";

const KEY = "vault.solvency";

function result(status: CheckResult["status"], o: { key?: string; check?: string; severity?: Severity } = {}): CheckResult {
  const key = o.key ?? KEY;
  return {
    key,
    check: o.check ?? key.split(":")[0],
    subject: key.includes(":") ? key.split(":")[1] : null,
    status,
    severity: o.severity ?? "PAGE",
    detail: `${key} is ${status}`,
    values: {},
    runbook: "solvency.md",
  };
}

function engine(o: Partial<ConstructorParameters<typeof AlertEngine>[0]> = {}) {
  return new AlertEngine({
    failAfter: 2,
    resolveAfter: 2,
    renotifyMs: 3_600_000,
    startupGraceMs: 0,
    startedAt: 0,
    ...o,
  });
}

const ran = new Set([KEY.split(":")[0], "oracle.freshness"]);

test("an alert fires only after N consecutive failing ticks", () => {
  const e = engine({ failAfter: 3 });
  assert.equal(e.observe([result("fail")], ran, 1_000).length, 0);
  assert.equal(e.observe([result("fail")], ran, 2_000).length, 0);
  const events = e.observe([result("fail")], ran, 3_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "firing");
  assert.equal(events[0].severity, "PAGE");
  // The clock starts at the first failure, not at the moment it fires.
  assert.equal(events[0].since, 1_000);
  assert.equal(events[0].forSecs, 2);
});

test("a flap never fires: the streak resets on a pass", () => {
  const e = engine({ failAfter: 2 });
  assert.equal(e.observe([result("fail")], ran, 1_000).length, 0);
  assert.equal(e.observe([result("pass")], ran, 2_000).length, 0);
  assert.equal(e.observe([result("fail")], ran, 3_000).length, 0);
  assert.equal(e.observe([result("pass")], ran, 4_000).length, 0);
  assert.equal(e.observe([result("fail")], ran, 5_000).length, 0);
});

test("a firing alert does not re-notify every tick, but does on the interval", () => {
  const e = engine({ failAfter: 1, renotifyMs: 10_000 });
  assert.equal(e.observe([result("fail")], ran, 0).length, 1);
  for (let t = 1_000; t < 10_000; t += 1_000) assert.equal(e.observe([result("fail")], ran, t).length, 0, `tick ${t}`);
  const reminder = e.observe([result("fail")], ran, 10_000);
  assert.equal(reminder.length, 1);
  assert.equal(reminder[0].kind, "reminder");
  assert.equal(e.observe([result("fail")], ran, 11_000).length, 0);
});

test("it resolves after M consecutive passes, and only if it had announced", () => {
  const e = engine({ failAfter: 1, resolveAfter: 3 });
  e.observe([result("fail")], ran, 0);
  assert.equal(e.observe([result("pass")], ran, 1_000).length, 0);
  assert.equal(e.observe([result("pass")], ran, 2_000).length, 0);
  const resolved = e.observe([result("pass")], ran, 3_000);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].kind, "resolved");
  assert.equal(resolved[0].forSecs, 3);
  assert.equal(e.state(KEY), undefined);

  // A failure that never reached the fire threshold resolves silently.
  const quiet = engine({ failAfter: 5, resolveAfter: 1 });
  quiet.observe([result("fail")], ran, 0);
  assert.equal(quiet.observe([result("pass")], ran, 1_000).length, 0);
});

test("nothing is delivered during the startup grace period, and what is still failing fires after it", () => {
  const e = engine({ failAfter: 1, startupGraceMs: 5_000, startedAt: 0 });
  assert.equal(e.observe([result("fail")], ran, 1_000).length, 0);
  assert.equal(e.observe([result("fail")], ran, 4_999).length, 0);
  // The state was tracked all along, so nothing has to re-accumulate.
  assert.equal(e.state(KEY)?.firing, true);
  const events = e.observe([result("fail")], ran, 5_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "firing");
  assert.equal(events[0].since, 1_000);
});

test("a failure that clears inside the grace period is never announced", () => {
  const e = engine({ failAfter: 1, resolveAfter: 1, startupGraceMs: 10_000, startedAt: 0 });
  e.observe([result("fail")], ran, 1_000);
  assert.equal(e.observe([result("pass")], ran, 2_000).length, 0);
});

test("a check that cannot run alerts at WARN, and never as a pass", () => {
  const e = engine({ failAfter: 1 });
  const events = e.observe([result("error", { severity: "WARN" })], ran, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].severity, "WARN");
  assert.equal(overallLevel(e.firing()), "WARN");
});

test("escalating WARN to PAGE notifies again", () => {
  const e = engine({ failAfter: 1, renotifyMs: 10_000_000 });
  e.observe([result("fail", { severity: "WARN" })], ran, 0);
  const escalated = e.observe([result("fail", { severity: "PAGE" })], ran, 1_000);
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].severity, "PAGE");
  assert.equal(overallLevel(e.firing()), "PAGE");
});

test("a skip counts as a pass, so a subject that stops applying resolves", () => {
  const e = engine({ failAfter: 1, resolveAfter: 1 });
  const key = "oracle.freshness:BTC";
  e.observe([result("fail", { key })], ran, 0);
  const resolved = e.observe([result("skip", { key })], ran, 1_000);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].kind, "resolved");
});

test("a subject that disappears resolves, but only if its check ran", () => {
  const e = engine({ failAfter: 1, resolveAfter: 1 });
  const key = "oracle.freshness:SOL";
  e.observe([result("fail", { key })], ran, 0);
  // The check ran and no longer reports SOL: the market is gone.
  const resolved = e.observe([result("pass", { key: "oracle.freshness:BTC" })], ran, 1_000);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].key, key);

  // A check that did not run this tick leaves its alerts alone.
  const e2 = engine({ failAfter: 1, resolveAfter: 1 });
  e2.observe([result("fail", { key })], ran, 0);
  assert.equal(e2.observe([], new Set(["vault.solvency"]), 1_000).length, 0);
  assert.equal(e2.state(key)?.firing, true);
});

test("per-check failAfter overrides the default", () => {
  const e = engine({ failAfter: 5, failAfterFor: (id) => (id === "vault.solvency" ? 1 : undefined) });
  assert.equal(e.observe([result("fail")], ran, 0).length, 1);
  assert.equal(e.observe([result("fail", { key: "oracle.quorum:BTC", check: "oracle.quorum" })], ran, 0).length, 0);
});

test("firing alerts are ordered worst first", () => {
  const e = engine({ failAfter: 1 });
  e.observe(
    [
      result("fail", { key: "infra.rpc", severity: "WARN" }),
      result("fail", { key: "vault.solvency", severity: "PAGE" }),
    ],
    new Set(["infra.rpc", "vault.solvency"]),
    0
  );
  assert.deepEqual(e.firing().map((f) => f.key), ["vault.solvency", "infra.rpc"]);
  assert.equal(overallLevel([]), "OK");
});

// ─── delivery ───────────────────────────────────────────────────────────────

const event: AlertEvent = {
  kind: "firing",
  key: "oracle.freshness:BTC",
  check: "oracle.freshness",
  subject: "BTC",
  severity: "PAGE",
  detail: "BTC STALE: 300s old",
  values: { ageSecs: 300 },
  runbook: "oracle-failure.md",
  since: 0,
  forSecs: 90,
};

test("a notifier that throws is contained: the others still deliver", async () => {
  const sent: string[] = [];
  const broken: Notifier = {
    name: "broken",
    send: async () => {
      throw new Error("webhook 500");
    },
  };
  const working: Notifier = {
    name: "working",
    send: async (e) => {
      sent.push(e.key);
    },
  };
  const metrics = new Metrics();
  const lines: string[] = [];
  const log = createLogger("test", "debug", {}, (l) => lines.push(l));

  await fanout([broken, working], log, metrics).send(event, { network: "arc-testnet" });
  assert.deepEqual(sent, ["oracle.freshness:BTC"]);
  assert.equal(metrics.snapshot().counters["monitor_alert_delivery_failures_total.broken"], "1");
  assert.equal(metrics.snapshot().counters["monitor_alerts_sent_total.working"], "1");
  assert.ok(lines.some((l) => l.includes("alert delivery failed")));
});

test("a tick keeps going when every notifier is broken", async () => {
  const metrics = new Metrics();
  const log = createLogger("test", "error", {}, () => {});
  const broken: Notifier = { name: "broken", send: async () => Promise.reject(new Error("down")) };
  await assert.doesNotReject(fanout([broken], log, metrics).send(event, { network: "arc-testnet" }));
});

test("the alert text names the severity, the subject and the runbook", () => {
  const text = formatText(event, "arc-testnet");
  assert.match(text, /PAGE oracle\.freshness:BTC on arc-testnet/);
  assert.match(text, /BTC STALE: 300s old/);
  assert.match(text, /runbook: infra\/deploy\/runbooks\/oracle-failure\.md/);
  assert.match(formatText({ ...event, kind: "resolved" }, "arc-testnet"), /RESOLVED .* after 90s/);
  assert.match(formatText({ ...event, kind: "reminder" }, "arc-testnet"), /still failing after 90s/);
});

test("each webhook flavour gets the field it expects", () => {
  assert.equal(detectFormat("https://hooks.slack.com/services/x"), "slack");
  assert.equal(detectFormat("https://discord.com/api/webhooks/x"), "discord");
  assert.equal(detectFormat("https://api.telegram.org/botX/sendMessage"), "telegram");
  assert.equal(detectFormat("https://alerts.example.com/hook"), "generic");

  assert.ok("text" in (webhookBody(event, "arc", "slack") as object));
  assert.ok("content" in (webhookBody(event, "arc", "discord") as object));
  const tg = webhookBody(event, "arc", "telegram", "123") as { chat_id: string };
  assert.equal(tg.chat_id, "123");
  const generic = webhookBody(event, "arc", "generic") as { text: string; content: string; alert: { key: string } };
  assert.equal(generic.alert.key, event.key);
  assert.equal(generic.text, generic.content);
});

test("webhook format matches the host exactly or on a dot boundary", () => {
  // Real hosts, including a port, mixed case and a trailing-dot FQDN.
  assert.equal(detectFormat("https://slack.com/x"), "slack");
  assert.equal(detectFormat("https://hooks.slack.com:8443/services/x"), "slack");
  assert.equal(detectFormat("https://HOOKS.Slack.COM/services/x"), "slack");
  assert.equal(detectFormat("https://hooks.slack.com./services/x"), "slack");
  assert.equal(detectFormat("https://discordapp.com/api/webhooks/x"), "discord");
  assert.equal(detectFormat("https://ptb.discord.com/api/webhooks/x"), "discord");
  assert.equal(detectFormat("https://API.Telegram.org:443/botX/sendMessage"), "telegram");

  // Look-alikes fall through to generic.
  for (const url of [
    "https://evilslack.com/hook",
    "https://slack.com.evil.io/hook",
    "https://notdiscord.com/hook",
    "https://discord.com.evil.io/hook",
    "https://mydiscordapp.com/hook",
    "https://faketelegram.org/hook",
    "https://hooks.slack.com@evil.io/hook", // userinfo, not host
    "https://evil.io/hooks.slack.com",
    "https://evil.io/?u=https://hooks.slack.com",
    "not a url",
    "",
  ]) {
    assert.equal(detectFormat(url), "generic", url);
  }

  assert.equal(isHostOrSubdomain("slack.com", "slack.com"), true);
  assert.equal(isHostOrSubdomain("a.b.slack.com", "slack.com"), true);
  assert.equal(isHostOrSubdomain("evilslack.com", "slack.com"), false);
  assert.equal(isHostOrSubdomain("com", "slack.com"), false);
});

// ─── exposure ───────────────────────────────────────────────────────────────

const view: MonitorSnapshotView = {
  network: "arc-testnet",
  level: "PAGE",
  tickAt: 10_000,
  tickDurationMs: 250,
  results: [
    { ...result("pass", { key: "vault.solvency" }), values: { assetsUsd: 1_000.5, priced: true } },
    { ...result("fail", { key: "oracle.freshness:BTC", check: "oracle.freshness" }), values: { ageSecs: 300 } },
    result("skip", { key: "infra.ws", check: "infra.ws", severity: "WARN" }),
  ],
  firing: [
    {
      key: "oracle.freshness:BTC",
      check: "oracle.freshness",
      subject: "BTC",
      severity: "PAGE",
      firing: true,
      failStreak: 3,
      passStreak: 0,
      firstFailedAt: 5_000,
      lastNotifiedAt: 6_000,
      detail: "BTC STALE",
    },
  ],
};

test("/metrics exposes one series per check, with numeric values", () => {
  const text = prometheus(view, new Metrics(), 11_000);
  assert.match(text, /kryon_monitor_level\{network="arc-testnet"\} 2/);
  assert.match(text, /kryon_monitor_check\{check="vault\.solvency",severity="PAGE",runbook="solvency\.md"\} 1/);
  assert.match(text, /kryon_monitor_check\{check="oracle\.freshness",subject="BTC",[^}]*\} 0/);
  assert.match(text, /kryon_monitor_check\{check="infra\.ws",[^}]*\} 2/);
  assert.match(text, /kryon_monitor_check_value\{check="vault\.solvency",name="assetsUsd"\} 1000\.5/);
  assert.match(text, /kryon_monitor_check_value\{check="vault\.solvency",name="priced"\} 1/);
  assert.match(text, /kryon_monitor_alert_firing\{check="oracle\.freshness",subject="BTC",severity="PAGE"\} 1/);
  assert.match(text, /kryon_monitor_tick_age_seconds\{network="arc-testnet"\} 1/);
  // Before the first tick it still serves, so a scrape never 500s.
  assert.match(prometheus(null, new Metrics(), 0), /kryon_monitor_up 1/);
});

test("/status reports the level, the firing alerts and every check", () => {
  const json = statusJson(view, 11_000) as { level: string; firing: unknown[]; checks: unknown[] };
  assert.equal(json.level, "PAGE");
  assert.equal(json.firing.length, 1);
  assert.equal(json.checks.length, 3);
  assert.deepEqual(statusJson(null, 0), { status: "starting" });
});
