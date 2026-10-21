import 'server-only'
import { Client } from 'pg'
import { syncAllGoogleReviews, type SyncResult } from './sync'
import { createGoogleReviewFetcher } from './google-business-api'

/**
 * The advisory-lock key for the whole sweep. Arbitrary but FIXED — advisory
 * locks share one namespace per database, so it must not collide with another
 * job's. Nothing else in this project takes one today; keep any future keys
 * listed together.
 */
export const SYNC_LOCK_KEY = 4207105

export type SweepOutcome =
  | { skipped: true }
  | { skipped: false; results: SyncResult[]; ms: number }

/**
 * Run the all-tenants review sync once, serialised across processes.
 *
 * Shared by scripts/sync-google-reviews.ts (host cron) and
 * app/api/cron/sync-google-reviews (Vercel Cron), so both take the same lock
 * and cannot overlap each other.
 *
 * The lock is a session-level pg_try_advisory_lock on a DEDICATED client held
 * for the whole sweep — @/db is a connection pool, so a session lock taken by
 * one pooled statement would be released on a different connection than the
 * next statement borrows. "try" rather than plain, so an overlapping run SKIPS
 * instead of queueing behind the first and repeating the whole sweep. The lock
 * is released by the connection dropping even if the process is killed.
 */
export async function runGoogleReviewSweep(): Promise<SweepOutcome> {
  const url = process.env.DATABASE_URL_OWNER
  if (!url) throw new Error('DATABASE_URL_OWNER is not set')

  // Checked HERE rather than discovered per tenant. Without it every connected
  // venue fails identically on decrypting its refresh token, which reads like a
  // fleet-wide Google outage and is really one missing variable.
  if (!process.env.PAYMENT_SETTINGS_ENCRYPTION_KEY) {
    throw new Error(
      'PAYMENT_SETTINGS_ENCRYPTION_KEY is not set; stored refresh tokens cannot be decrypted.',
    )
  }

  const lockClient = new Client({ connectionString: url })
  await lockClient.connect()
  try {
    const { rows } = await lockClient.query<{ got: boolean }>(
      'select pg_try_advisory_lock($1) as got',
      [SYNC_LOCK_KEY],
    )
    if (rows[0]?.got !== true) return { skipped: true }

    const started = Date.now()
    try {
      const results = await syncAllGoogleReviews(createGoogleReviewFetcher())
      return { skipped: false, results, ms: Date.now() - started }
    } finally {
      await lockClient.query('select pg_advisory_unlock($1)', [SYNC_LOCK_KEY]).catch(() => {})
    }
  } finally {
    await lockClient.end().catch(() => {})
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
