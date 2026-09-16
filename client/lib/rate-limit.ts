const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

async function distributedRateLimit(key: string, limit: number): Promise<boolean | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const bucketKey = `rl:${key}:${Math.floor(Date.now() / WINDOW_MS)}`;
  const res = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      ["INCR", bucketKey],
      ["PEXPIRE", bucketKey, String(WINDOW_MS + 5_000)],
    ]),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error("distributed rate limit unavailable");
  }

  const result = (await res.json()) as Array<{ result?: unknown }>;
  const count = Number(result[0]?.result ?? 0);
  return Number.isFinite(count) && count <= limit;
}

function localRateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) {
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k);
    }
  }

  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  current.count += 1;
  return current.count <= limit;
}

export async function rateLimit(key: string, limit: number): Promise<boolean> {
  const distributed = await distributedRateLimit(key, limit).catch(() => false);
  if (distributed !== null) return distributed;
  // No distributed limiter configured. The in-memory fallback is per-instance
  // (per-isolate on serverless platforms), so under horizontal scale it is
  // effectively no limit at all. In production that is not acceptable for
  // state-mutating routes — fail closed and surface the misconfiguration.
  if (process.env.NODE_ENV === "production") {
    console.error("rate-limit: UPSTASH_REDIS_REST_URL/TOKEN not configured in production — denying request");
    return false;
  }
  return localRateLimit(key, limit);
}

export function requestKey(req: Request, owner: string): string {
  // CF-Connecting-IP is set by Cloudflare and cannot be spoofed by the client
  // (Cloudflare strips inbound values). x-forwarded-for is client-spoofable
  // and only a best-effort fallback for non-Cloudflare deployments.
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = cfIp || forwarded || req.headers.get("x-real-ip") || "unknown";
  return `${owner}:${ip}`;
}

export function bodyTooLarge(req: Request, maxBytes = 4096): boolean {
  const len = Number(req.headers.get("content-length") ?? 0);
  return Number.isFinite(len) && len > maxBytes;
}
