import 'server-only'
import { cache } from 'react'
import { desc, eq, sql } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { googleReviews } from '@/db/schema'

/**
 * The homepage's read of the Google review cache (0142).
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
 * the tenant GUC from the subdomain, `google_reviews_public_select` (0142)
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
   * OPTIONAL, and deliberately NOT rendered today (0143). Projected so an
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
 * The venue's newest cached reviews (at most HOMEPAGE_LIMIT), plus the average
 * and count over ALL cached reviews.
 *
 * `averageRating` and `count` come from a separate aggregate over every cached
 * row — NOT from the six that are displayed. Taking them from the limited list
 * made a venue with 200 reviews read "from 6 reviews" with an average biased to
 * the newest few. The sync caches the venue's whole review list (and prunes
 * ones Google removed), so the aggregate describes the same set Google does,
 * to within sync lag. They are still computed over what is CACHED rather than
 * stored from Google's own `averageRating`/`totalReviewCount`: the headline
 * can never disagree with the data this page actually holds.
 *
 * `cache()` dedupes within one render pass, so a page body and its
 * generateMetadata() share a single query.
 */
export const getPublicGoogleReviews = cache(async function getPublicGoogleReviews(
  tenantId: string,
): Promise<PublicGoogleReviews> {
  const { rows, totals } = await withPublicTenant(tenantId, async (tx) => {
    const rows = await tx
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
      .limit(HOMEPAGE_LIMIT)

    // Over every cached row, not just the page above.
    const [totals] = await tx
      .select({
        count: sql<number>`count(*)`.mapWith(Number),
        avg: sql<number>`coalesce(avg(${googleReviews.rating}), 0)`.mapWith(Number),
      })
      .from(googleReviews)
      .where(eq(googleReviews.tenantId, tenantId))

    return { rows, totals }
  })

  if (rows.length === 0) return { reviews: [], averageRating: 0, count: 0 }

  return {
    reviews: rows.map((r) => ({
      ...r,
      reviewCreatedAt: r.reviewCreatedAt.toISOString(),
    })),
    averageRating: Math.round(totals.avg * 10) / 10,
    count: totals.count,
  }
})
