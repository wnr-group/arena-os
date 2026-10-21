import 'server-only'
import { and, eq, lt, notInArray, sql } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { googleBusinessCredentials, googleReviews } from '@/db/schema'
import { loadGoogleConnection } from './google-credentials'
import type { FetchGoogleReviews } from './google-business-api'

/**
 * Pull one tenant's Google reviews into the cache (0142).
 *
 * ── The fetcher is INJECTED ────────────────────────────────────────────────
 *
 * Everything here — the upsert, the idempotency, the bookkeeping, the tenant
 * scoping — is exercised in tests with a fake fetcher, so the only untested
 * part of this feature is the HTTP call itself, which cannot be tested until
 * Google grants API access and verifies the OAuth consent screen. That is the
 * whole reason for the seam; see lib/reviews/google-business-api.ts.
 *
 * ── Why an upsert and not delete-then-insert ───────────────────────────────
 *
 * The unique (tenant_id, google_review_id) is the idempotency guarantee, so a
 * re-sync UPDATES what it already wrote. Clearing the table first would leave a
 * window — however short — where a visitor's homepage showed no reviews, and
 * would lose everything if the fetch failed halfway.
 *
 * A review Google no longer returns IS removed — but only after a fetch that is
 * provably complete (not truncated, nothing skipped). A review deleted by its
 * author, or taken down by Google, must not sit on the public homepage forever;
 * and a short or partial call must not empty it. See the prune step below.
 *
 * ── Failure is recorded, not thrown away ───────────────────────────────────
 *
 * A failing sync writes `last_sync_error` and returns; it does not throw past
 * the caller. A scheduled job iterating tenants must not stop at the first
 * venue whose token was revoked, and an operator needs to see WHICH venue is
 * broken without reading logs.
 */

export type SyncResult = {
  tenantId: string
  /** False when the tenant has not connected — not an error. */
  connected: boolean
  /** Rows written (inserted or updated). */
  synced: number
  /**
   * Entries Google returned that this project could not store — reported by
   * the fetcher, which is where the dropping happens (0143). Previously this
   * was structurally always 0.
   */
  skipped: number
  /** Cached rows deleted because Google no longer returns them. */
  removed: number
  error: string | null
}

export async function syncGoogleReviewsForTenant(
  tenantId: string,
  fetchReviews: FetchGoogleReviews,
  db: DB = ownerDb,
  opts: { minIntervalMs?: number } = {},
): Promise<SyncResult> {
  const base = {
    tenantId,
    connected: false,
    synced: 0,
    skipped: 0,
    removed: 0,
    error: null,
  } as SyncResult

  // Set once the tenant is known to be connected, so a failure after that point
  // is reported as a broken connection rather than "not connected".
  let connected = false
  try {
    // INSIDE the try: loadGoogleConnection rethrows a DecryptionError for a
    // tampered row, an AAD mismatch or a rotated key. That must be this
    // tenant's recorded failure, not an exception that ends a sweep of every
    // tenant after it.
    const connection = await loadGoogleConnection(tenantId, db)
    // Not connected is the NORMAL case — most tenants never will be. No row is
    // touched and nothing is reported as broken.
    if (!connection) return base
    connected = true

    // Optional throttle for the interactive "Sync now" button, which is not
    // otherwise rate limited: refuse if an attempt began moments ago.
    if (opts.minIntervalMs) {
      const [row] = await db
        .select({ lastSyncAttempt: googleBusinessCredentials.lastSyncAttempt })
        .from(googleBusinessCredentials)
        .where(eq(googleBusinessCredentials.tenantId, tenantId))
        .limit(1)
      if (row?.lastSyncAttempt && Date.now() - row.lastSyncAttempt.getTime() < opts.minIntervalMs) {
        return {
          ...base,
          connected: true,
          error: 'A sync was started a moment ago. Please wait a minute and try again.',
        }
      }
    }

    await db
      .update(googleBusinessCredentials)
      .set({ lastSyncAttempt: new Date() })
      .where(eq(googleBusinessCredentials.tenantId, tenantId))

    const fetched = await fetchReviews({
      accountId: connection.accountId,
      locationId: connection.locationId,
      clientId: connection.clientId,
      clientSecret: connection.clientSecret,
      refreshToken: connection.refreshToken,
    })

    const startedAt = new Date()
    let synced = 0
    for (const r of fetched.reviews) {
      await db
        .insert(googleReviews)
        .values({
          tenantId,
          googleReviewId: r.googleReviewId,
          reviewerName: r.reviewerName,
          // ?? null because the field is optional: a fetcher that omits it must
          // write a null, not leave the column at its previous value.
          reviewerPhotoUrl: r.reviewerPhotoUrl ?? null,
          rating: r.rating,
          comment: r.comment,
          reviewCreatedAt: r.reviewCreatedAt,
          syncedAt: new Date(),
        })
        // The unique constraint turns a re-sync into an update. `tenant_id` is
        // NOT in the update set: the conflict target already fixed it, and a row
        // must never be able to change hands between tenants.
        .onConflictDoUpdate({
          target: [googleReviews.tenantId, googleReviews.googleReviewId],
          set: {
            reviewerName: r.reviewerName,
            reviewerPhotoUrl: r.reviewerPhotoUrl ?? null,
            rating: r.rating,
            comment: r.comment,
            reviewCreatedAt: r.reviewCreatedAt,
            syncedAt: new Date(),
          },
        })
      synced++
    }

    // ── prune what Google no longer returns ──────────────────────────────
    //
    // Only after a fetch that is PROVABLY complete: the walk was not cut short
    // (`truncated === false`, so an adapter that does not say never prunes) and
    // nothing was dropped as unmappable (an entry we could not read might be
    // exactly the cached row we would otherwise delete). Anything less could
    // wipe a homepage because one call came back short.
    //
    // `synced_at < startedAt` leaves alone any row a concurrent sync wrote
    // while this one was in flight, so two racing runs cannot delete each
    // other's fresh rows; a row this run upserted is in the keep-list anyway.
    let removed = 0
    if (fetched.truncated === false && fetched.skipped === 0) {
      const keep = fetched.reviews.map((r) => r.googleReviewId)
      const gone = await db
        .delete(googleReviews)
        .where(
          and(
            eq(googleReviews.tenantId, tenantId),
            lt(googleReviews.syncedAt, startedAt),
            keep.length > 0 ? notInArray(googleReviews.googleReviewId, keep) : undefined,
          ),
        )
        .returning({ id: googleReviews.id })
      removed = gone.length
    }

    await db
      .update(googleBusinessCredentials)
      .set({ lastSyncedAt: new Date(), lastSyncError: null })
      .where(eq(googleBusinessCredentials.tenantId, tenantId))

    return {
      tenantId,
      connected: true,
      synced,
      skipped: fetched.skipped,
      removed,
      error: null,
    }
  } catch (e) {
    // The MESSAGE only. A token or an Authorization header must never reach a
    // column an owner-facing screen renders.
    const message = e instanceof Error ? e.message : 'Unknown error'
    if (connected) {
      // Best-effort: if the database itself is the problem this write can fail
      // too, and that must not turn into an exception for the caller.
      await db
        .update(googleBusinessCredentials)
        .set({ lastSyncError: message.slice(0, 500) })
        .where(eq(googleBusinessCredentials.tenantId, tenantId))
        .catch(() => {})
    } else {
      // Failed while loading the connection (e.g. a DecryptionError). The row
      // exists, so record it for the owner-facing screen all the same.
      await db
        .update(googleBusinessCredentials)
        .set({ lastSyncAttempt: new Date(), lastSyncError: message.slice(0, 500) })
        .where(eq(googleBusinessCredentials.tenantId, tenantId))
        .catch(() => {})
    }
    return { ...base, connected: true, error: message }
  }
}

/**
 * Remove a tenant's cached reviews from the public homepage.
 *
 * Called on Disconnect. With no connection there is no sync, so nothing could
 * ever remove a review Google later deletes or takes down — the cache would go
 * stale in exactly the way the prune step exists to prevent. Reconnecting and
 * syncing repopulates it. Runs on the owner connection because staff have no
 * DELETE policy on google_reviews; the tenant id must come from the
 * authenticated context, never from the caller's input.
 */
export async function deleteCachedGoogleReviews(
  tenantId: string,
  db: DB = ownerDb,
): Promise<number> {
  const gone = await db
    .delete(googleReviews)
    .where(eq(googleReviews.tenantId, tenantId))
    .returning({ id: googleReviews.id })
  return gone.length
}

/**
 * Every connected tenant, one at a time.
 *
 * Sequential rather than parallel on purpose: Business Profile quota is per
 * PROJECT (~300 QPM once approved), shared across every tenant, so firing all
 * of them at once would have one busy venue starve the rest. A job that takes a
 * little longer is the right trade for one that does not rate-limit itself.
 *
 * One tenant's failure never stops the loop — that is the reason
 * syncGoogleReviewsForTenant records errors instead of throwing.
 *
 * ── Overlap is the CALLER's problem, deliberately (0143) ────────────────────
 *
 * Sequential also means this gets slower as venues connect, so once the sweep
 * outlasts the cron interval two runs overlap. The database survives that — the
 * unique constraint plus ON CONFLICT DO UPDATE cannot duplicate a row — but
 * both runs spend the same per-project Google quota on the same reviews and
 * interleave the sync bookkeeping, so a failure can look like it recovered.
 *
 * The guard is deliberately NOT here, because `db` is a connection POOL. A
 * session-level advisory lock taken by one statement would be released on a
 * different connection than the one the next statement borrows, so the lock
 * would not mean what it says. Wrapping the whole sweep in one transaction to
 * get a transaction-scoped lock would be worse: it would hold a snapshot open
 * across every HTTP call to Google.
 *
 * So serialisation belongs to the process that runs the sweep, on a connection
 * it owns for its whole lifetime — see scripts/sync-google-reviews.ts, which
 * takes pg_try_advisory_lock on a dedicated client and exits quietly when a
 * previous run is still going.
 */
export async function syncAllGoogleReviews(
  fetchReviews: FetchGoogleReviews,
  db: DB = ownerDb,
): Promise<SyncResult[]> {
  const tenants = await db
    .select({ tenantId: googleBusinessCredentials.tenantId })
    .from(googleBusinessCredentials)
    .orderBy(sql`${googleBusinessCredentials.tenantId}`)

  const results: SyncResult[] = []
  for (const t of tenants) {
    try {
      results.push(await syncGoogleReviewsForTenant(t.tenantId, fetchReviews, db))
    } catch (e) {
      // syncGoogleReviewsForTenant records its own failures and should not
      // throw; this is the backstop so nothing it missed can end the sweep.
      results.push({
        tenantId: t.tenantId,
        connected: true,
        synced: 0,
        skipped: 0,
        removed: 0,
        error: e instanceof Error ? e.message : 'Unknown error',
      })
    }
  }
  return results
}
