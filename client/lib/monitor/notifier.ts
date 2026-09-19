/**
 * Delivery. One `Notifier` interface, a webhook implementation and a stdout
 * one, so PagerDuty or e-mail can be added in Phase 5 without touching a
 * single check.
 *
 * A notifier that throws must never take the loop down — that would turn a
 * broken webhook into a total loss of monitoring — so `fanout` catches per
 * notifier and reports the failure through the logger and a counter.
 */

import type { Logger, Metrics } from "@/lib/keepers/runtime";

import type { AlertEvent } from "./alerting";

export interface Notifier {
  readonly name: string;
  send(event: AlertEvent, ctx: { network: string }): Promise<void>;
}

export type WebhookFormat = "slack" | "discord" | "telegram" | "generic";

/**
 * True when `hostname` is `domain` itself or a subdomain of it. A bare
 * `endsWith(domain)` would also accept `evilslack.com`, so the match is exact
 * or on a dot boundary.
 */
export function isHostOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Slack, Discord and Telegram each want a different field; the URL says which. */
export function detectFormat(url: string): WebhookFormat {
  let hostname: string;
  try {
    // `hostname`, not `host`: the port is not part of the name.
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "generic";
  }
  const on = (domain: string) => isHostOrSubdomain(hostname, domain);
  if (on("slack.com")) return "slack";
  if (on("discord.com") || on("discordapp.com")) return "discord";
  if (on("telegram.org")) return "telegram";
  return "generic";
}

const ICON: Record<AlertEvent["kind"], string> = { firing: "🔴", reminder: "🔁", resolved: "🟢" };

export function formatText(e: AlertEvent, network: string): string {
  const head =
    e.kind === "resolved"
      ? `${ICON.resolved} RESOLVED ${e.key} on ${network} after ${duration(e.forSecs)}`
      : `${ICON[e.kind]} ${e.severity} ${e.key} on ${network}${e.kind === "reminder" ? ` — still failing after ${duration(e.forSecs)}` : ""}`;
  const lines = [head, e.detail];
  if (e.kind !== "resolved" && e.runbook) lines.push(`runbook: infra/deploy/runbooks/${e.runbook}`);
  return lines.join("\n");
}

function duration(secs: number): string {
  if (secs < 120) return `${secs}s`;
  if (secs < 7200) return `${Math.round(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h${Math.round((secs % 3600) / 60)}m`;
}

export function webhookBody(e: AlertEvent, network: string, format: WebhookFormat, chatId?: string): unknown {
  const text = formatText(e, network);
  switch (format) {
    case "slack":
      return { text };
    case "discord":
      return { content: text };
    case "telegram":
      return { chat_id: chatId, text, disable_notification: e.kind === "resolved" };
    default:
      // Both field names, plus the structured alert, so a relay can use either.
      return { text, content: text, alert: { ...e, network } };
  }
}

export interface WebhookOptions {
  url: string;
  network: string;
  format?: WebhookFormat;
  chatId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function webhookNotifier(o: WebhookOptions): Notifier {
  const format = o.format ?? detectFormat(o.url);
  if (format === "telegram" && !o.chatId) {
    throw new Error("a Telegram webhook needs ALERT_TELEGRAM_CHAT_ID");
  }
  const doFetch = o.fetchImpl ?? fetch;
  return {
    name: `webhook:${format}`,
    async send(event, ctx) {
      const res = await doFetch(o.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webhookBody(event, ctx.network, format, o.chatId)),
        signal: AbortSignal.timeout(o.timeoutMs ?? 5_000),
      });
      if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
    },
  };
}

/** Always present: an alert is also a log line, whatever else is configured. */
export function stdoutNotifier(log: Logger): Notifier {
  return {
    name: "stdout",
    async send(event, ctx) {
      const at = event.kind === "resolved" ? log.info : event.severity === "PAGE" ? log.error : log.warn;
      at.call(log, formatText(event, ctx.network), {
        alert: true,
        kind: event.kind,
        alertKey: event.key,
        severity: event.severity,
        runbook: event.runbook,
        forSecs: event.forSecs,
        ...event.values,
      });
    },
  };
}

/**
 * Deliver to every notifier, independently. A failure is logged and counted;
 * it never propagates, and it never stops the other notifiers.
 */
export function fanout(notifiers: readonly Notifier[], log: Logger, metrics: Metrics): Notifier {
  return {
    name: notifiers.map((n) => n.name).join("+") || "none",
    async send(event, ctx) {
      await Promise.all(
        notifiers.map(async (n) => {
          try {
            await n.send(event, ctx);
            metrics.inc(`monitor_alerts_sent_total.${n.name}`);
          } catch (err) {
            metrics.inc(`monitor_alert_delivery_failures_total.${n.name}`);
            log.error("alert delivery failed; the alert is in this log only", {
              notifier: n.name,
              alertKey: event.key,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })
      );
    },
  };
}
