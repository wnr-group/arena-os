import 'server-only'
import { cache } from 'react'
import { desc, eq } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { googleReviews } from '@/db/schema'

/**
 * The homepage's read of the Google review cache (0106).
 *
 * ── It never calls Google ──────────────────────────────────────────────────
 *
 * This is the whole point of the cache. A public page that made a third-party
 * API call per render would go down when Google did, and Business Profile quota
 * is per PROJECT and shared across every tenant — one busy venue would starve
 * the rest. The sync writes; this only reads its own database.
 *
 * ── Tenant isolation ───────────────────────────────────────────────────────
 *
 * Two layers, as everywhere else on the public path: withPublicTenant() pins
 * the tenant GUC from the subdomain, `google_reviews_public_select` (0106)
 * scopes every row to it, and the explicit tenantId filter here means a
 * loosened policy still could not cross a venue boundary.
 *
 * ── Absent by default ──────────────────────────────────────────────────────
 *
 * A tenant that has not connected has no rows, so this returns [] and the
 * homepage renders exactly as it does today. There is no error state to handle
 * and nothing for a visitor to notice — which is the requirement, because most
 * tenants will never have Business Profile API access.
 */

export type PublicGoogleReview = {
  id: string
  /** Null when the reviewer chose anonymity — the UI says "A Google user". */
  reviewerName: string | null
  /**
   * OPTIONAL, and deliberately NOT rendered today (0107). Projected so an
   * avatar UI is a component change rather than a re-sync — but read the note
   * in GoogleReviewsSection before using it: hotlinking googleusercontent from
   * a public page leaks every visitor's IP to Google, so showing it is a
   * privacy decision, not a styling one.
   */
  reviewerPhotoUrl?: string | null
  rating: number
  comment: string | null
  reviewCreatedAt: string
}

export type PublicGoogleReviews = {
  reviews: PublicGoogleReview[]
  /** Rounded to one decimal, over the CACHED rows — see the note below. */
  averageRating: number
  count: number
}

/** How many to put on a homepage. Enough to be convincing, not a wall of text. */
const HOMEPAGE_LIMIT = 6

/**
 * The venue's cached reviews, newest first.
 *
 * `averageRating` and `count` are computed over what is CACHED, not over
 * Google's own `averageRating`/`totalReviewCount`. Those two numbers are
 * available from the API and deliberately not stored: showing "4.8 from 312
 * reviews" beside six cached ones invites a visitor to wonder where the other
 * 306 are, and the moment a sync lags, the headline number and the visible
 * reviews disagree. What is shown is what is here.
 *
 * `cache()` dedupes within one render pass, so a page body and its
 * generateMetadata() share a single query.
 */
export const getPublicGoogleReviews = cache(async function getPublicGoogleReviews(
  tenantId: string,
): Promise<PublicGoogleReviews> {
  const rows = await withPublicTenant(tenantId, (tx) =>
    tx
      .select({
        id: googleReviews.id,
        reviewerName: googleReviews.reviewerName,
        reviewerPhotoUrl: googleReviews.reviewerPhotoUrl,
        rating: googleReviews.rating,
        comment: googleReviews.comment,
        reviewCreatedAt: googleReviews.reviewCreatedAt,
      })
      .from(googleReviews)
      .where(eq(googleReviews.tenantId, tenantId))
      .orderBy(desc(googleReviews.reviewCreatedAt))
      .limit(HOMEPAGE_LIMIT),
  )

  if (rows.length === 0) return { reviews: [], averageRating: 0, count: 0 }

  const total = rows.reduce((sum, r) => sum + r.rating, 0)
  return {
    reviews: rows.map((r) => ({
      ...r,
      reviewCreatedAt: r.reviewCreatedAt.toISOString(),
    })),
    averageRating: Math.round((total / rows.length) * 10) / 10,
    count: rows.length,
  }
})
