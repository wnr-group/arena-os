type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

// This limiter is in-memory only — there's no Redis/KV in this stack yet, so
// state resets on deploy/restart and isn't shared across instances or
// between the edge proxy and the Node server action runtime. That's an
// accepted trade-off for a first layer of abuse protection on the public
// booking site (AROS-47); a distributed limiter (Upstash/Redis) can drop in
// behind this same function signature later without touching call sites.
// The size cap + opportunistic sweep below just keeps a long-lived process
// from accumulating one bucket per distinct IP/phone forever.
const MAX_BUCKETS = 50_000

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number }

/** Fixed-window rate limit keyed by an arbitrary string, e.g. `avail:1.2.3.4`. */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()

  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k)
    }
  }

  const existing = buckets.get(key)
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true }
  }

  if (existing.count >= limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) }
  }

  existing.count += 1
  return { ok: true }
}
