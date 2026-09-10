/**
 * The Google Business Profile boundary — the ONE place that knows Google's
 * shapes, and the one place that will need touching when access arrives.
 *
 * Pure and dependency-free on purpose: the mapping below is arithmetic and
 * string handling, so it is tested without a network, a database or a Google
 * account. Everything downstream (sync, cache, homepage) consumes
 * `GoogleReviewFromApi` and has never heard of `starRating` or `createTime`.
 *
 * ══ WHAT GOOGLE SUPPORTS, VERIFIED ══════════════════════════════════════════
 *
 * `accounts.locations.reviews.list` — GET, parent
 * `accounts/{accountId}/locations/{locationId}`, scope
 * `https://www.googleapis.com/auth/business.manage`. It returns `reviews`,
 * `averageRating`, `totalReviewCount` and `nextPageToken`.
 *
 * The Review resource has exactly four methods: `list`, `get`, `updateReply`
 * and `deleteReply`. There is NO create — a business can only reply. That is
 * why this module reads and never writes, and why the customer prompt (0104)
 * has to send people to Google rather than collecting a review here.
 *
 * ══ WHAT IS WIRED, AND WHAT IS UNVERIFIED ═══════════════════════════════════
 *
 * The real call IS implemented below (createGoogleReviewFetcher). What is not
 * available is a way to RUN it: two approvals stand between this project and a
 * live response, neither of which is code:
 *
 *   1. QUOTA. A new Cloud project has 0 QPM on these APIs. Access needs an
 *      application, a verified Business Profile live 60+ days, and a business
 *      website. Approval takes roughly two weeks.
 *   2. CONSENT. `business.manage` is a sensitive scope, and this is a
 *      MULTI-TENANT app: each venue owner authorises their own profile against
 *      our OAuth client, so the consent screen needs Google's app verification.
 *      That is a separate review from the quota one.
 *
 * So the first run against real Google IS the test for the HTTP call itself.
 * Everything around it is covered without one: the enum mapping, the URL
 * building, the error classification and the paging loop are all exercised in
 * scripts/test-google-business-reviews.ts with a stub `fetch`, and the sync,
 * cache and isolation with an injected fake fetcher.
 *
 * When a venue's approvals land, nothing here changes — that venue fills in
 * its own OAuth client and location in settings, and a caller passes
 * createGoogleReviewFetcher() to syncAllGoogleReviews().
 */

/** One review, in this project's shape rather than Google's. */
export type GoogleReviewFromApi = {
  /** Google's own review id, taken from the resource name. The idempotency key. */
  googleReviewId: string
  /** Null when the reviewer chose to stay anonymous — Google really returns this. */
  reviewerName: string | null
  reviewerPhotoUrl: string | null
  /** 1–5. Google's ONE..FIVE enum is mapped here so nothing downstream sees it. */
  rating: number
  /** Null when the reviewer left stars and no words. */
  comment: string | null
  reviewCreatedAt: Date
  reviewUrl: string | null
}

/**
 * What the sync needs from Google. Injected, so the sync is testable with a
 * fake and so the real implementation is one clearly-marked swap.
 *
 * Returning ALL reviews rather than a page is deliberate: paging is Google's
 * concern and belongs behind this boundary, not in the sync loop.
 */
export type FetchGoogleReviews = (params: {
  accountId: string
  locationId: string
  /** The VENUE'S OWN OAuth client — its project, its quota, its verification. */
  clientId: string
  /** Plaintext, in memory, for the life of one call. Never logged, never stored. */
  clientSecret: string
  /** Plaintext, in memory, for the life of one call. Never logged, never stored. */
  refreshToken: string
}) => Promise<GoogleReviewFromApi[]>

/** Google's star enum, and the only place it is understood. */
const STAR_RATING: Record<string, number> = {
  STAR_RATING_UNSPECIFIED: 0,
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
}

/** The raw shape, as documented. Only the fields this project uses. */
export type RawGoogleReview = {
  name?: string
  reviewId?: string
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean }
  starRating?: string
  comment?: string
  createTime?: string
  updateTime?: string
}

/**
 * Google's shape → ours, dropping anything unusable.
 *
 * Returns null rather than throwing for a review this project cannot store: a
 * single malformed entry in a page of fifty must not fail the whole sync and
 * leave the homepage stale. The caller drops the nulls.
 *
 * What makes a review unusable:
 *   * no id — there would be nothing to deduplicate on, so a re-sync would
 *     append it forever;
 *   * no or unspecified star rating — the column CHECKs 1..5, and a review with
 *     no rating is not something to render stars for;
 *   * no createTime — ordering is by review date, and a null would float.
 */
export function toGoogleReview(raw: RawGoogleReview): GoogleReviewFromApi | null {
  // The resource name is `accounts/{a}/locations/{l}/reviews/{reviewId}`;
  // `reviewId` is also returned directly. Prefer the explicit field and fall
  // back to the last path segment.
  const googleReviewId = raw.reviewId?.trim() || raw.name?.split('/').filter(Boolean).pop() || ''
  if (!googleReviewId) return null

  const rating = STAR_RATING[raw.starRating ?? ''] ?? 0
  if (rating < 1 || rating > 5) return null

  const createdMs = raw.createTime ? Date.parse(raw.createTime) : NaN
  if (Number.isNaN(createdMs)) return null

  // isAnonymous is Google's own flag; a missing displayName means the same
  // thing, so both land as null and the UI says "A Google user".
  const anonymous = raw.reviewer?.isAnonymous === true
  const name = anonymous ? null : raw.reviewer?.displayName?.trim() || null

  return {
    googleReviewId,
    reviewerName: name,
    // Not shown for an anonymous reviewer either — the photo would identify
    // exactly the person who asked not to be identified.
    reviewerPhotoUrl: anonymous ? null : raw.reviewer?.profilePhotoUrl?.trim() || null,
    rating,
    comment: raw.comment?.trim() || null,
    reviewCreatedAt: new Date(createdMs),
    // Google does not return a public permalink on the Review resource
    // (reviewReplyUrl is for the OWNER to reply, not for a visitor to read), so
    // this stays null until there is a documented field for it. Null is honest;
    // a guessed URL would 404 for visitors.
    reviewUrl: null,
  }
}

/**
 * The REVIEWS LIST endpoint, paginated.
 *
 * `reviews.list` is a GET on
 * `v4/accounts/{accountId}/locations/{locationId}/reviews`, returning
 * `reviews`, `averageRating`, `totalReviewCount` and `nextPageToken`. Only
 * the first is used here — see lib/reviews/public.ts for why the aggregate
 * figures are deliberately not stored.
 *
 * ── Ids are normalised, because both forms are in the wild ────────────────
 *
 * Google's own console shows `accounts/123`, its API returns bare `123`, and
 * an owner pasting from either is equally likely. Stripping the prefix here
 * means the stored value can be in either shape and the path is still built
 * correctly — rather than producing
 * `accounts/accounts/123/locations/locations/456`, which 404s in a way that
 * looks like a permissions problem.
 */
const API_ROOT = 'https://mybusiness.googleapis.com/v4'

/** `accounts/123` or `123` → `123`. */
function bareId(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  return trimmed.includes('/') ? (trimmed.split('/').pop() ?? trimmed) : trimmed
}

/** The parent path reviews.list expects. Exported so a test can assert it. */
export function reviewsUrl(accountId: string, locationId: string, pageToken?: string): string {
  const url = new URL(
    `${API_ROOT}/accounts/${bareId(accountId)}/locations/${bareId(locationId)}/reviews`,
  )
  // 50 is Google's documented maximum for this endpoint. Fewer pages means
  // fewer calls against a per-PROJECT quota shared by every tenant.
  url.searchParams.set('pageSize', '50')
  if (pageToken) url.searchParams.set('pageToken', pageToken)
  return url.toString()
}

/** Raised by the fetcher. `permanent` means retrying will never help. */
export class GoogleApiError extends Error {
  readonly permanent: boolean
  constructor(message: string, permanent: boolean) {
    super(message)
    this.name = 'GoogleApiError'
    this.permanent = permanent
  }
}

/**
 * Turn an HTTP status into a message a human can act on.
 *
 * The distinction that matters is PERMANENT vs transient, because the sync
 * records the message for an operator and a scheduled job will run again
 * regardless. "Reconnect the profile" and "we were rate-limited" need
 * different reactions, and a bare "403" tells nobody which one happened.
 */
export function describeApiFailure(status: number, body: string): GoogleApiError {
  const detail = body.slice(0, 300)
  if (status === 401) {
    return new GoogleApiError(
      'Google rejected the access token (401). The venue needs to reconnect its Business Profile.',
      true,
    )
  }
  if (status === 403) {
    // 403 is the one people misread. It is almost never "wrong password" —
    // it is the API not enabled, the project on zero quota, or the connected
    // Google account not managing this location.
    return new GoogleApiError(
      `Google refused the request (403). Usually the Business Profile API is not enabled ` +
        `for the project, the project has no approved quota, or the connected account does ` +
        `not manage this location. ${detail}`,
      true,
    )
  }
  if (status === 404) {
    return new GoogleApiError(
      `Google has no such account/location (404). Check the stored ids. ${detail}`,
      true,
    )
  }
  if (status === 429) {
    return new GoogleApiError('Rate-limited by Google (429). The next run will retry.', false)
  }
  return new GoogleApiError(`Google returned ${status}. ${detail}`, status < 500 ? true : false)
}

/**
 * The real fetcher: exchange the refresh token, then page through the reviews.
 *
 * ══ WHAT THIS CAN AND CANNOT BE TRUSTED TO DO ══════════════════════════════
 *
 * The code is complete and follows the documented contract, but it has NOT
 * been run against Google — this project has no approved API quota and no
 * verified OAuth consent screen, and neither can be obtained by writing code:
 *
 *   * Business Profile API access needs an application, a verified profile
 *     live 60+ days, and a business website (~2 weeks);
 *   * `business.manage` is a sensitive scope, and because this is
 *     multi-tenant each venue owner consents against OUR client, so the
 *     consent screen needs Google's app verification.
 *
 * So treat the first real run as the test. Everything AROUND it — the enum
 * mapping, the pagination loop's own logic, the URL building, the error
 * classification, the upsert, the cache and the isolation — is covered by
 * scripts/test-google-business-reviews.ts with an injected fake.
 *
 * `fetchImpl` is a parameter for exactly that reason: the paging and error
 * handling below can be exercised with a stub `fetch`, without a network.
 */
export function createGoogleReviewFetcher(
  fetchImpl: typeof fetch = fetch,
  exchange: (
    refreshToken: string,
    clientId: string,
    clientSecret: string,
  ) => Promise<string> = defaultExchange,
): FetchGoogleReviews {
  return async ({ accountId, locationId, clientId, clientSecret, refreshToken }) => {
    const accessToken = await exchange(refreshToken, clientId, clientSecret)

    const out: GoogleReviewFromApi[] = []
    let pageToken: string | undefined
    // A bound, not a `while (true)`: a server that kept returning the same
    // nextPageToken would otherwise spin forever against a shared quota. 40
    // pages of 50 is 2,000 reviews, far past what a homepage will ever show.
    for (let page = 0; page < 40; page++) {
      let res: Response
      try {
        res = await fetchImpl(reviewsUrl(accountId, locationId, pageToken), {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(20_000),
        })
      } catch (e) {
        // Transient by definition — a timeout or a DNS blip is worth retrying.
        throw new GoogleApiError(
          `Could not reach the Business Profile API: ${e instanceof Error ? e.name : 'unknown'}`,
          false,
        )
      }

      if (!res.ok) {
        throw describeApiFailure(res.status, await res.text().catch(() => ''))
      }

      const json = (await res.json()) as { reviews?: RawGoogleReview[]; nextPageToken?: string }
      for (const raw of json.reviews ?? []) {
        // A single malformed entry must not fail a page of fifty and leave the
        // homepage stale, so unusable ones are dropped rather than thrown on.
        const mapped = toGoogleReview(raw)
        if (mapped) out.push(mapped)
      }

      if (!json.nextPageToken) break
      pageToken = json.nextPageToken
    }

    return out
  }
}

/**
 * Kept out of the fetcher's default parameter so importing this module does
 * not drag the OAuth module — and its `server-only` marker — into anything
 * that only wants toGoogleReview().
 */
async function defaultExchange(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const { exchangeRefreshToken } = await import('./google-oauth')
  return exchangeRefreshToken(refreshToken, clientId, clientSecret)
}
