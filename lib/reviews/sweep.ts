import 'server-only'
import { acquireLease, releaseLease } from '@/lib/cron/lease'
import { syncGoogleReviewsBatch, type SyncResult } from './sync'
import { createGoogleReviewFetcher } from './google-business-api'

/** The lease name for the whole sweep. */
export const SYNC_LEASE_NAME = 'google-review-sweep'

/**
 * How long one sweep may keep starting new tenants. The Vercel route is cut at
 * maxDuration = 60s, so it works for 45s and leaves the rest for the tenant in
 * flight; a host cron with no such limit passes a larger budget.
 */
export const DEFAULT_SWEEP_BUDGET_MS = 45_000
/** Added to the budget for the lease: the tenant in flight when the budget runs out. */
const LEASE_MARGIN_MS = 90_000

export type SweepOutcome =
  | { skipped: true }
  | { skipped: false; results: SyncResult[]; /** connected tenants left for the next run */ deferred: number; ms: number }

/**
 * Run the all-tenants review sync once, serialised across processes.
 *
 * Shared by scripts/sync-google-reviews.ts (host cron) and
 * app/api/cron/sync-google-reviews (Vercel Cron), so both take the same lease and
 * cannot overlap each other.
 *
 * The guard is an expiring lease row (lib/cron/lease.ts), NOT a session advisory
 * lock: behind a transaction pooler a session lock neither excludes nor releases
 * reliably, and a leaked one skipped every later run forever. "Try" semantics are
 * kept — an overlapping run SKIPS instead of queueing and repeating the sweep —
 * and a run killed mid-way only holds the lease until it expires.
 *
 * The sweep is time-boxed (`budgetMs`) and visits the least recently attempted
 * tenants first, so a run cut at the limit is continued by the next one rather
 * than starving the same tail tenants every day.
 */
export async function runGoogleReviewSweep(
  opts: { budgetMs?: number } = {},
): Promise<SweepOutcome> {
  if (!process.env.DATABASE_URL_OWNER) throw new Error('DATABASE_URL_OWNER is not set')

  // Checked HERE rather than discovered per tenant. Without it every connected
  // venue fails identically on decrypting its refresh token, which reads like a
  // fleet-wide Google outage and is really one missing variable.
  if (!process.env.PAYMENT_SETTINGS_ENCRYPTION_KEY) {
    throw new Error(
      'PAYMENT_SETTINGS_ENCRYPTION_KEY is not set; stored refresh tokens cannot be decrypted.',
    )
  }

  const budgetMs = opts.budgetMs ?? DEFAULT_SWEEP_BUDGET_MS
  const lease = await acquireLease(SYNC_LEASE_NAME, budgetMs + LEASE_MARGIN_MS)
  if (!lease) return { skipped: true }

  const started = Date.now()
  try {
    const { results, deferred } = await syncGoogleReviewsBatch(createGoogleReviewFetcher(), undefined, {
      deadline: started + budgetMs,
    })
    return { skipped: false, results, deferred, ms: Date.now() - started }
  } finally {
    await releaseLease(lease)
  }
}

/** Totals for a log line / response body. No tenant ids, tokens or messages. */
export function summariseSweep(results: SyncResult[]) {
  const connected = results.filter((r) => r.connected)
  return {
    examined: results.length,
    connected: connected.length,
    notConnected: results.length - connected.length,
    synced: connected.reduce((sum, r) => sum + r.synced, 0),
    skipped: connected.reduce((sum, r) => sum + r.skipped, 0),
    removed: connected.reduce((sum, r) => sum + r.removed, 0),
    failed: connected.filter((r) => r.error !== null).length,
  }
}
