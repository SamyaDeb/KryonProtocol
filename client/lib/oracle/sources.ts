/**
 * Price sources: one adapter per venue behind a single interface.
 *
 * A source is a file, not a refactor (docs/engineering/ORACLE_STRATEGY.md §3):
 * Tier 1 adds a Chainlink Data Streams adapter here and nothing else changes.
 *
 * Every adapter
 *   - fetches all requested symbols in as few HTTP calls as the venue allows,
 *   - parses decimal strings straight to 1e18 bigints (no float round-trip),
 *   - stamps each quote with when it was observed, and
 *   - reports per-symbol failures instead of failing the whole batch, so one
 *     delisted pair does not take a venue out for every market.
 *
 * Health (consecutive failures, last success) lives in `SourceHealth`, owned by
 * the publisher, so adapters stay stateless and trivially testable.
 */

import { parseUnits } from "viem";

/** A price observed at one venue, in 1e18 fixed point. */
export interface SourceQuote {
  source: string;
  symbol: string;
  price: bigint;
  /** Wall-clock ms when the venue says the price was current (or when fetched). */
  ts: number;
}

export interface SourceResult {
  quotes: SourceQuote[];
  /** Symbols this venue was asked for and could not price, with the reason. */
  errors: { symbol: string; error: string }[];
}

export interface PriceSource {
  readonly name: string;
  /** Whether this venue is configured to price `symbol` at all. */
  supports(symbol: string): boolean;
  fetch(symbols: readonly string[]): Promise<SourceResult>;
}

export type FetchJson = (url: string, timeoutMs: number) => Promise<unknown>;

export const defaultFetchJson: FetchJson = async (url, timeoutMs) => {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "kryon-oracle/1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export interface SourceOptions {
  fetchJson?: FetchJson;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Which venues price which symbol. Verified against the public APIs on
 * 2026-09-18. TRX has no Coinbase market, so it runs on exactly two sources
 * with no slack: one venue outage stops TRX publication.
 *
 * `USDC` is the de-peg reading, not a market. Coinbase is deliberately absent
 * for it: Coinbase treats USDC as USD 1:1, so its USDC-USD spot is pinned at
 * 1.00 and can never show a de-peg.
 */
export const DEFAULT_VENUES: Readonly<Record<string, readonly string[]>> = {
  BTC: ["binance", "coinbase", "kraken"],
  ETH: ["binance", "coinbase", "kraken"],
  SOL: ["binance", "coinbase", "kraken"],
  XRP: ["binance", "coinbase", "kraken"],
  BNB: ["binance", "coinbase", "kraken"],
  TRX: ["binance", "kraken"],
  USDC: ["binance", "kraken"],
};

/** Exact decimal string → 1e18 bigint. Rejects anything that is not a positive number. */
export function parsePrice(raw: unknown): bigint {
  if (typeof raw !== "string" && typeof raw !== "number") throw new Error("price is not a string");
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`unparseable price ${JSON.stringify(s).slice(0, 40)}`);
  // parseUnits rounds past 18 places; venues never quote that finely.
  const v = parseUnits(s, 18);
  if (v <= 0n) throw new Error("non-positive price");
  return v;
}

function base(o: SourceOptions) {
  return {
    fetchJson: o.fetchJson ?? defaultFetchJson,
    timeoutMs: o.timeoutMs ?? 1_500,
    now: o.now ?? Date.now,
  };
}

function venueSupports(name: string, venues: Readonly<Record<string, readonly string[]>>) {
  return (symbol: string) => (venues[symbol] ?? []).includes(name);
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Binance ────────────────────────────────────────────────────────────────

/**
 * USDC-quoted pairs, one call for every symbol. USDC is the protocol's unit of
 * account, so a USDC quote needs no conversion. The de-peg reading uses
 * USDCUSDT, which moves if either stablecoin leaves the peg; both cases should
 * halt publication.
 *
 * Binance answers HTTP 451 to US-hosted IPs. Deploy publishers accordingly.
 */
export function binanceSource(o: SourceOptions = {}, venues = DEFAULT_VENUES): PriceSource {
  const b = base(o);
  const pair = (s: string) => (s === "USDC" ? "USDCUSDT" : `${s}USDC`);
  return {
    name: "binance",
    supports: venueSupports("binance", venues),
    async fetch(symbols) {
      const out: SourceResult = { quotes: [], errors: [] };
      if (symbols.length === 0) return out;
      const pairs = symbols.map(pair);
      const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(pairs))}`;
      let rows: unknown;
      try {
        rows = await b.fetchJson(url, b.timeoutMs);
      } catch (err) {
        for (const symbol of symbols) out.errors.push({ symbol, error: msg(err) });
        return out;
      }
      const ts = b.now();
      const bySymbol = new Map<string, unknown>();
      if (Array.isArray(rows)) {
        for (const r of rows as { symbol?: string; price?: unknown }[]) {
          if (r && typeof r.symbol === "string") bySymbol.set(r.symbol, r.price);
        }
      }
      for (const symbol of symbols) {
        try {
          if (!bySymbol.has(pair(symbol))) throw new Error("pair missing from response");
          out.quotes.push({ source: "binance", symbol, price: parsePrice(bySymbol.get(pair(symbol))), ts });
        } catch (err) {
          out.errors.push({ symbol, error: msg(err) });
        }
      }
      return out;
    },
  };
}

// ─── Coinbase ───────────────────────────────────────────────────────────────

/**
 * Coinbase Exchange ticker, one call per product (the venue has no batch
 * ticker). Uses the venue's own trade time, so a frozen book shows as stale.
 */
export function coinbaseSource(o: SourceOptions = {}, venues = DEFAULT_VENUES): PriceSource {
  const b = base(o);
  return {
    name: "coinbase",
    supports: venueSupports("coinbase", venues),
    async fetch(symbols) {
      const out: SourceResult = { quotes: [], errors: [] };
      await Promise.all(
        symbols.map(async (symbol) => {
          try {
            const r = (await b.fetchJson(
              `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}-USD/ticker`,
              b.timeoutMs
            )) as { price?: unknown; time?: unknown; message?: unknown };
            if (r && typeof r.message === "string") throw new Error(r.message);
            const t = typeof r.time === "string" ? Date.parse(r.time) : NaN;
            out.quotes.push({
              source: "coinbase",
              symbol,
              price: parsePrice(r.price),
              ts: Number.isFinite(t) ? t : b.now(),
            });
          } catch (err) {
            out.errors.push({ symbol, error: msg(err) });
          }
        })
      );
      return out;
    },
  };
}

// ─── Kraken ─────────────────────────────────────────────────────────────────

/** Kraken's request name for a base asset (it calls bitcoin XBT). */
export function krakenPair(symbol: string): string {
  return `${symbol === "BTC" ? "XBT" : symbol}USD`;
}

/**
 * Kraken answers under its own internal names, which differ from the request
 * for legacy assets (`XBTUSD` → `XXBTZUSD`, `ETHUSD` → `XETHZUSD`).
 */
export function krakenResultKey(result: Record<string, unknown>, symbol: string): string | undefined {
  const b = symbol === "BTC" ? "XBT" : symbol;
  const candidates = [`${b}USD`, `X${b}ZUSD`];
  return candidates.find((k) => k in result);
}

/** Last-trade price for every symbol in one call. */
export function krakenSource(o: SourceOptions = {}, venues = DEFAULT_VENUES): PriceSource {
  const b = base(o);
  return {
    name: "kraken",
    supports: venueSupports("kraken", venues),
    async fetch(symbols) {
      const out: SourceResult = { quotes: [], errors: [] };
      if (symbols.length === 0) return out;
      const url = `https://api.kraken.com/0/public/Ticker?pair=${symbols.map(krakenPair).join(",")}`;
      let body: { error?: unknown; result?: Record<string, { c?: unknown[] }> };
      try {
        body = (await b.fetchJson(url, b.timeoutMs)) as typeof body;
      } catch (err) {
        for (const symbol of symbols) out.errors.push({ symbol, error: msg(err) });
        return out;
      }
      const errs = Array.isArray(body?.error) ? (body.error as unknown[]) : [];
      const result = body?.result ?? {};
      const ts = b.now();
      for (const symbol of symbols) {
        try {
          const key = krakenResultKey(result, symbol);
          if (!key) throw new Error(errs.length ? String(errs[0]) : "pair missing from response");
          out.quotes.push({ source: "kraken", symbol, price: parsePrice(result[key]?.c?.[0]), ts });
        } catch (err) {
          out.errors.push({ symbol, error: msg(err) });
        }
      }
      return out;
    },
  };
}

// ─── registry and health ────────────────────────────────────────────────────

export function defaultSources(o: SourceOptions = {}): PriceSource[] {
  return [binanceSource(o), coinbaseSource(o), krakenSource(o)];
}

/** Per (source, symbol) health, so one bad pair does not condemn a venue. */
export class SourceHealth {
  private readonly state = new Map<string, { failures: number; lastOk: number | null; lastError: string | null }>();

  private key(source: string, symbol: string) {
    return `${source}:${symbol}`;
  }

  ok(source: string, symbol: string, at: number) {
    this.state.set(this.key(source, symbol), { failures: 0, lastOk: at, lastError: null });
  }

  fail(source: string, symbol: string, error: string) {
    const k = this.key(source, symbol);
    const prev = this.state.get(k) ?? { failures: 0, lastOk: null, lastError: null };
    this.state.set(k, { failures: prev.failures + 1, lastOk: prev.lastOk, lastError: error });
  }

  get(source: string, symbol: string) {
    return this.state.get(this.key(source, symbol)) ?? { failures: 0, lastOk: null, lastError: null };
  }

  healthy(source: string, symbol: string): boolean {
    return this.get(source, symbol).failures === 0;
  }
}

/**
 * Fetch every symbol from every venue that supports it, in parallel, and drop
 * quotes older than `maxQuoteAgeMs`. A venue that throws outright is recorded
 * as a failure for every symbol it was asked for.
 */
export async function collectQuotes(
  sources: readonly PriceSource[],
  symbols: readonly string[],
  health: SourceHealth,
  opts: { now: number; maxQuoteAgeMs: number }
): Promise<Map<string, SourceQuote[]>> {
  const bySymbol = new Map<string, SourceQuote[]>(symbols.map((s) => [s, []]));
  await Promise.all(
    sources.map(async (src) => {
      const wanted = symbols.filter((s) => src.supports(s));
      if (wanted.length === 0) return;
      let res: SourceResult;
      try {
        res = await src.fetch(wanted);
      } catch (err) {
        for (const s of wanted) health.fail(src.name, s, msg(err));
        return;
      }
      for (const e of res.errors) health.fail(src.name, e.symbol, e.error);
      for (const q of res.quotes) {
        const age = opts.now - q.ts;
        if (age > opts.maxQuoteAgeMs) {
          health.fail(src.name, q.symbol, `quote ${Math.round(age)}ms old`);
          continue;
        }
        health.ok(src.name, q.symbol, opts.now);
        bySymbol.get(q.symbol)?.push(q);
      }
    })
  );
  return bySymbol;
}
