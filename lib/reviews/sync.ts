import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { googleBusinessCredentials, googleReviews } from '@/db/schema'
import { loadGoogleConnection } from './google-credentials'
import type { FetchGoogleReviews } from './google-business-api'

/**
 * Pull one tenant's Google reviews into the cache (0105).
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
 * A review that Google no longer returns is deliberately KEPT. Google removes
 * reviews for its own reasons (spam sweeps, an account closing), and a
 * homepage that empties itself because one call came back short is worse than
 * one that is slightly out of date. Pruning, if ever wanted, is a separate
 * decision with its own rule.
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
  /** Entries Google returned that this project could not store. */
  skipped: number
  error: string | null
}

export async function syncGoogleReviewsForTenant(
  tenantId: string,
  fetchReviews: FetchGoogleReviews,
  db: DB = ownerDb,
): Promise<SyncResult> {
  const base = { tenantId, connected: false, synced: 0, skipped: 0, error: null } as SyncResult

  const connection = await loadGoogleConnection(tenantId, db)
  // Not connected is the NORMAL case — most tenants never will be. No row is
  // touched and nothing is reported as broken.
  if (!connection) return base

  await db
    .update(googleBusinessCredentials)
    .set({ lastSyncAttempt: new Date() })
    .where(eq(googleBusinessCredentials.tenantId, tenantId))

  let fetched
  try {
    fetched = await fetchReviews({
      accountId: connection.accountId,
      locationId: connection.locationId,
      clientId: connection.clientId,
      clientSecret: connection.clientSecret,
      refreshToken: connection.refreshToken,
    })
  } catch (e) {
    // The MESSAGE only. A token or an Authorization header must never reach a
    // column an owner-facing screen renders.
    const message = e instanceof Error ? e.message : 'Unknown error'
    await db
      .update(googleBusinessCredentials)
      .set({ lastSyncError: message.slice(0, 500) })
      .where(eq(googleBusinessCredentials.tenantId, tenantId))
    return { ...base, connected: true, error: message }
  }

  let synced = 0
  for (const r of fetched) {
    await db
      .insert(googleReviews)
      .values({
        tenantId,
        googleReviewId: r.googleReviewId,
        reviewerName: r.reviewerName,
        reviewerPhotoUrl: r.reviewerPhotoUrl,
        rating: r.rating,
        comment: r.comment,
        reviewCreatedAt: r.reviewCreatedAt,
        reviewUrl: r.reviewUrl,
        syncedAt: new Date(),
      })
      // The unique constraint turns a re-sync into an update. `tenant_id` is
      // NOT in the update set: the conflict target already fixed it, and a row
      // must never be able to change hands between tenants.
      .onConflictDoUpdate({
        target: [googleReviews.tenantId, googleReviews.googleReviewId],
        set: {
          reviewerName: r.reviewerName,
          reviewerPhotoUrl: r.reviewerPhotoUrl,
          rating: r.rating,
          comment: r.comment,
          reviewCreatedAt: r.reviewCreatedAt,
          reviewUrl: r.reviewUrl,
          syncedAt: new Date(),
        },
      })
    synced++
  }

  await db
    .update(googleBusinessCredentials)
    .set({ lastSyncedAt: new Date(), lastSyncError: null })
    .where(eq(googleBusinessCredentials.tenantId, tenantId))

  return { tenantId, connected: true, synced, skipped: 0, error: null }
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
    results.push(await syncGoogleReviewsForTenant(t.tenantId, fetchReviews, db))
  }
  return results
}
