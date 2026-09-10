/**
 * Google Business Profile connection + review cache (0105) — Feature B.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-google-business-reviews.ts
 *
 * The Google HTTP call is the ONE thing not covered, because it cannot be until
 * the project has approved API quota and a verified OAuth consent screen. Every
 * other part — the enum mapping, the encryption, the upsert, idempotency, the
 * failure bookkeeping, the public read and tenant isolation — runs here against
 * a real database with an injected fake fetcher. That split is the whole reason
 * FetchGoogleReviews is a parameter.
 */
import { Client, Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import {
  toGoogleReview,
  reviewsUrl,
  describeApiFailure,
  createGoogleReviewFetcher,
  type FetchGoogleReviews,
} from '../lib/reviews/google-business-api'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, extra?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  → ${JSON.stringify(extra)}`}`)
  if (c) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

const review = (id: string, star: string, over: Record<string, unknown> = {}) => ({
  reviewId: id,
  name: `accounts/a/locations/l/reviews/${id}`,
  reviewer: { displayName: 'Asha R', profilePhotoUrl: 'https://lh3.example/p.jpg' },
  starRating: star,
  comment: 'Great tables and friendly staff.',
  createTime: '2026-08-01T10:00:00Z',
  ...over,
})

async function main() {
  loadEnv()

  // EVERY module that reaches @/db is imported HERE, after loadEnv(): @/db
  // builds its pools at module load, so a static import at the top of this
  // file would have them constructed with no password. Same shape the other
  // database suites use.
  const { getPublicGoogleReviews } = await import('../lib/reviews/public')
  const {
    loadGoogleConnection,
    saveGoogleOAuthClient,
    saveGoogleRefreshToken,
    deleteGoogleConnection,
    getGoogleConnectionStatus,
  } = await import('../lib/reviews/google-credentials')
  const { issueOAuthState, readOAuthState, consentUrl } = await import('../lib/reviews/google-oauth-flow')
  const { syncGoogleReviewsForTenant, syncAllGoogleReviews } = await import('../lib/reviews/sync')

  // ════════════════════════════════════════════════════════════════════════
  section('1. Google’s shapes → ours (pure)')
  {
    const r = toGoogleReview(review('r1', 'FIVE'))
    check('a five-star review maps', r?.rating === 5 && r?.googleReviewId === 'r1')
    check('…keeping the words', r?.comment === 'Great tables and friendly staff.')
    check(
      '…and the review date, not the sync date',
      r?.reviewCreatedAt.toISOString().startsWith('2026-08-01') === true,
    )

    check('ONE maps to 1', toGoogleReview(review('r2', 'ONE'))?.rating === 1)
    check('THREE maps to 3', toGoogleReview(review('r3', 'THREE'))?.rating === 3)

    // The enum is the whole reason this mapping exists — a naive Number() would
    // give NaN and a CHECK violation at the far end of a sync.
    check(
      'STAR_RATING_UNSPECIFIED is dropped, not stored as 0',
      toGoogleReview(review('r4', 'STAR_RATING_UNSPECIFIED')) === null,
    )
    check('an unknown rating is dropped', toGoogleReview(review('r5', 'SIX')) === null)

    check(
      'a review with no id is dropped (nothing to deduplicate on)',
      toGoogleReview({ ...review('', 'FIVE'), reviewId: '', name: '' }) === null,
    )
    check(
      'the id falls back to the last segment of the resource name',
      toGoogleReview({
        ...review('ignored', 'FIVE'),
        reviewId: '',
        name: 'accounts/a/locations/l/reviews/fromName',
      })?.googleReviewId === 'fromName',
    )
    check(
      'a review with no createTime is dropped (ordering would float)',
      toGoogleReview({ ...review('r6', 'FIVE'), createTime: undefined }) === null,
    )

    // Anonymity is Google's own flag and must survive into our copy.
    const anon = toGoogleReview(review('r7', 'FOUR', { reviewer: { isAnonymous: true, displayName: 'Leaked' } }))
    check('an anonymous reviewer keeps no name', anon?.reviewerName === null)
    check('…and no photo either', anon?.reviewerPhotoUrl === null)

    check('a rating with no words is fine', toGoogleReview(review('r8', 'FIVE', { comment: undefined }))?.comment === null)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('1b. the HTTP layer (stub fetch — no network, no Google)')
  {
    // Both id shapes are in the wild: Google's console shows accounts/123,
    // its API returns a bare 123. Either must build the same path.
    const bare = reviewsUrl('123', '456')
    check(
      'a bare id builds the documented path',
      bare.startsWith('https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews'),
    )
    check(
      'a prefixed id builds the SAME path, not accounts/accounts/123',
      reviewsUrl('accounts/123', 'locations/456').split('?')[0] === bare.split('?')[0],
    )
    check('pageSize is the documented maximum', bare.includes('pageSize=50'))
    check('a page token is carried', reviewsUrl('123', '456', 'tok').includes('pageToken=tok'))

    // Permanent vs transient is the distinction the sync records for a human:
    // reconnect the profile, or simply wait for the next run.
    check('401 is permanent (reconnect needed)', describeApiFailure(401, '').permanent === true)
    check(
      '403 explains the usual causes rather than just saying 403',
      describeApiFailure(403, '').message.includes('not enabled'),
    )
    check('404 is permanent', describeApiFailure(404, '').permanent === true)
    check('429 is transient', describeApiFailure(429, '').permanent === false)
    check('500 is transient', describeApiFailure(500, '').permanent === false)

    // The paging loop, driven by a stub fetch.
    let calls = 0
    const pages: Record<string, unknown> = {
      first: { reviews: [review('p1', 'FIVE')], nextPageToken: 'T2' },
      T2: { reviews: [review('p2', 'FOUR')] },
    }
    const stubFetch = (async (url: string) => {
      calls++
      const tok = new URL(url).searchParams.get('pageToken') ?? 'first'
      return { ok: true, json: async () => pages[tok] } as unknown as Response
    }) as unknown as typeof fetch

    const fetcher = createGoogleReviewFetcher(stubFetch, async () => 'access-token')
    const paged = await fetcher({ accountId: '123', locationId: '456', clientId: 'cid', clientSecret: 'csec', refreshToken: 'r' })
    check('the loop follows nextPageToken', calls === 2 && paged.length === 2)
    check('…and stops when there is none', paged.map((r) => r.googleReviewId).join() === 'p1,p2')

    // A bad status must surface as a classified error, never an empty array:
    // empty would be indistinguishable from a venue that has no reviews yet,
    // and would let the sync record a cheerful success while doing nothing.
    const failing = createGoogleReviewFetcher(
      (async () =>
        ({ ok: false, status: 403, text: async () => 'denied' }) as unknown as Response) as unknown as typeof fetch,
      async () => 'access-token',
    )
    let apiErr: string | null = null
    try {
      await failing({ accountId: '1', locationId: '2', clientId: 'cid', clientSecret: 'csec', refreshToken: 'r' })
    } catch (e) {
      apiErr = e instanceof Error ? e.message : String(e)
    }
    check('a 403 throws rather than returning an empty list', apiErr !== null && apiErr.includes('403'))
  }

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 })
  const ownerDrizzle = drizzle(ownerPool, { schema }) as unknown as Db
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  const app = drizzle(appPool, { schema })

  const asPublic = <T,>(tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.public_tenant_id', ${tenantId}, true)`)
      return fn(tx as unknown as Db)
    })

  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$1,'active','Asia/Kolkata')
       on conflict (slug) do update set status='active' returning id`,
      [slug],
    )
    const id = t.rows[0].id
    await owner.query('delete from google_reviews where tenant_id=$1', [id])
    await owner.query('delete from google_business_credentials where tenant_id=$1', [id])
    return id
  }

  const A = await makeTenant('gbpa')
  const B = await makeTenant('gbpb')

  // ════════════════════════════════════════════════════════════════════════
  section('2. the connection, and the token')
  {
    check('an unconnected tenant reads null', (await loadGoogleConnection(A, ownerDrizzle)) === null)

    await saveGoogleOAuthClient(
      A,
      { accountId: 'accounts/111', locationId: 'locations/222', clientId: 'client-A', clientSecret: 'client-secret-A' },
      ownerDrizzle,
    )
    // The client pair alone is not a usable connection: there is no token to
    // exchange yet, so every caller sees the same "not connected" as a venue
    // that never configured anything.
    check('a client pair alone is NOT yet a connection', (await loadGoogleConnection(A, ownerDrizzle)) === null)
    const preAuth = await getGoogleConnectionStatus(A, ownerDrizzle)
    check('…but settings shows it as configured, unauthorised', preAuth?.authorised === false)

    // Step two: what the OAuth callback does.
    check(
      'the callback stores the refresh token against the saved client',
      (await saveGoogleRefreshToken(A, 'refresh-secret-A', ownerDrizzle)) === true,
    )

    const conn = await loadGoogleConnection(A, ownerDrizzle)
    check('a saved connection round-trips', conn?.refreshToken === 'refresh-secret-A')
    check('…with the location ids', conn?.accountId === 'accounts/111' && conn?.locationId === 'locations/222')

    // THE property that makes the AAD worth having.
    const stored = (
      await owner.query<{ c: string }>(
        'select refresh_token_encrypted c from google_business_credentials where tenant_id=$1',
        [A],
      )
    ).rows[0].c
    check('the token is NOT stored in plaintext', !stored.includes('refresh-secret-A'))

    // The client secret is the OTHER half and equally useless alone — both are
    // sealed with the same tenant-id AAD, and neither may sit in plaintext.
    const storedClient = (
      await owner.query<{ c: string }>(
        'select oauth_client_secret_encrypted c from google_business_credentials where tenant_id=$1',
        [A],
      )
    ).rows[0].c
    check('the OAuth client secret is NOT stored in plaintext', !storedClient.includes('client-secret-A'))
    check('…and the client id round-trips (it is not a secret)', conn?.clientId === 'client-A')
    check('…and the client secret round-trips', conn?.clientSecret === 'client-secret-A')

    // Move A's ciphertext onto B's row: it must fail to decrypt, not silently
    // authorise as B.
    await saveGoogleOAuthClient(
      B,
      { accountId: 'accounts/999', locationId: 'locations/888', clientId: 'client-B', clientSecret: 'client-secret-B' },
      ownerDrizzle,
    )
    await owner.query('update google_business_credentials set refresh_token_encrypted=$2 where tenant_id=$1', [B, stored])
    let threw = false
    try {
      await loadGoogleConnection(B, ownerDrizzle)
    } catch {
      threw = true
    }
    check("a ciphertext moved between tenants will NOT decrypt", threw)

    // Put B back.
    await saveGoogleOAuthClient(
      B,
      { accountId: 'accounts/999', locationId: 'locations/888', clientId: 'client-B', clientSecret: 'client-secret-B' },
      ownerDrizzle,
    )

    // A callback naming a tenant that never configured a client must not be
    // able to create one — the UPDATE matches no row and reports false.
    const orphan = await makeTenant('gbporphan')
    check(
      'a token cannot be stored for a tenant with no client pair',
      (await saveGoogleRefreshToken(orphan, 'stray-token', ownerDrizzle)) === false,
    )

    // B was re-saved above (client pair only), so it needs authorising too —
    // the same two steps a real venue goes through.
    await saveGoogleRefreshToken(B, 'refresh-secret-B', ownerDrizzle)

    const status = await getGoogleConnectionStatus(A, ownerDrizzle)
    check('the status view carries no token', status !== null && !('refreshToken' in status))
    check('…and now reports authorised', status?.authorised === true)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('2b. the OAuth consent flow (state signing — no network)')
  {
    const state = issueOAuthState(A)
    check('a fresh state verifies and names its tenant', readOAuthState(state)?.tenantId === A)

    // THE attack this prevents: a callback naming a tenant it was not issued
    // for. Swapping the tenant breaks the signature over the whole payload.
    const forged = state.replace(A, B)
    check('a state re-pointed at another tenant is REFUSED', readOAuthState(forged) === null)

    check('a tampered signature is refused', readOAuthState(state.slice(0, -2) + '00') === null)
    check('a malformed state is refused', readOAuthState('nonsense') === null)
    check('a missing state is refused', readOAuthState(null) === null)

    // Two attempts must never collide, or one browser could finish another's.
    check('each attempt is unique', issueOAuthState(A) !== issueOAuthState(A))

    // access_type=offline + prompt=consent is what makes Google return a
    // REFRESH token. Without both, a second authorisation silently yields only
    // an access token and the connection stores nothing usable.
    const url = consentUrl({ clientId: 'cid', redirectUri: 'https://v.example/cb', state })
    check('the consent URL asks for offline access', url.includes('access_type=offline'))
    check('…and forces re-consent, so a refresh token is returned', url.includes('prompt=consent'))
    check('…for the business.manage scope', decodeURIComponent(url).includes('auth/business.manage'))
    check('…carrying the signed state', url.includes(encodeURIComponent(state)))
  }
  // ════════════════════════════════════════════════════════════════════════
  section('3. the sync (fake fetcher — the real one needs Google approval)')
  {
    const fake =
      (rows: ReturnType<typeof review>[]): FetchGoogleReviews =>
      async () =>
        rows.map(toGoogleReview).flatMap((r) => (r ? [r] : []))

    const first = await syncGoogleReviewsForTenant(A, fake([review('g1', 'FIVE'), review('g2', 'FOUR')]), ownerDrizzle)
    check('a first sync writes both reviews', first.synced === 2 && first.error === null)

    // THE idempotency guarantee — an index, not an application check.
    const second = await syncGoogleReviewsForTenant(A, fake([review('g1', 'FIVE'), review('g2', 'FOUR')]), ownerDrizzle)
    const [{ n }] = (
      await owner.query<{ n: string }>('select count(*) n from google_reviews where tenant_id=$1', [A])
    ).rows
    check('a re-sync updates rather than duplicating', second.synced === 2 && Number(n) === 2)

    // An edited review must change in place.
    await syncGoogleReviewsForTenant(A, fake([review('g1', 'ONE', { comment: 'Changed my mind.' })]), ownerDrizzle)
    const [edited] = (
      await owner.query<{ rating: number; comment: string }>(
        'select rating, comment from google_reviews where tenant_id=$1 and google_review_id=$2',
        [A, 'g1'],
      )
    ).rows
    check('an edited review is updated in place', edited.rating === 1 && edited.comment === 'Changed my mind.')

    // A review Google stops returning is KEPT — see the note in sync.ts.
    const [{ n2 }] = (
      await owner.query<{ n2: string }>('select count(*) n2 from google_reviews where tenant_id=$1', [A])
    ).rows
    check('a review Google no longer returns is kept, not deleted', Number(n2) === 2)

    // Failure is RECORDED, not thrown, so a job can carry on to the next venue.
    const failing: FetchGoogleReviews = async () => {
      throw new Error('invalid_grant: token revoked')
    }
    const bad = await syncGoogleReviewsForTenant(A, failing, ownerDrizzle)
    check('a failing sync returns an error rather than throwing', bad.error?.includes('invalid_grant') === true)
    const [{ err }] = (
      await owner.query<{ err: string }>(
        'select last_sync_error err from google_business_credentials where tenant_id=$1',
        [A],
      )
    ).rows
    check('…and records it where an operator can find it', err.includes('invalid_grant'))

    const recovered = await syncGoogleReviewsForTenant(A, fake([review('g1', 'FIVE')]), ownerDrizzle)
    const [{ err2 }] = (
      await owner.query<{ err2: string | null }>(
        'select last_sync_error err2 from google_business_credentials where tenant_id=$1',
        [A],
      )
    ).rows
    check('a later success clears the error', recovered.error === null && err2 === null)

    // Not connected is normal, not broken.
    const C = await makeTenant('gbpc')
    const none = await syncGoogleReviewsForTenant(C, fake([review('x', 'FIVE')]), ownerDrizzle)
    check('an unconnected tenant syncs nothing and reports no error', none.connected === false && none.error === null)

    // One venue's failure must not stop the loop.
    await syncGoogleReviewsForTenant(B, fake([review('b1', 'FIVE')]), ownerDrizzle)
    const all = await syncAllGoogleReviews(fake([review('all1', 'FOUR')]), ownerDrizzle)
    check(
      'syncAll visits every configured tenant, connected or not',
      all.length >= 2 && all.some((r) => r.connected),
    )
    check(
      '…and an unauthorised one does not stop the loop',
      all.every((r) => r.error === null),
    )
  }

  // ════════════════════════════════════════════════════════════════════════
  section('4. the public read, and tenant isolation')
  {
    const a = await getPublicGoogleReviews(A)
    check("A's homepage sees A's reviews", a.reviews.length > 0)
    check('…with an average over what is cached', a.averageRating > 0 && a.count === a.reviews.length)

    const b = await getPublicGoogleReviews(B)
    check("B's homepage sees B's reviews", b.reviews.length > 0)

    // THE isolation property.
    const aIds = new Set(a.reviews.map((r) => r.id))
    const bIds = new Set(b.reviews.map((r) => r.id))
    check('the two venues share no review row', [...aIds].every((id) => !bIds.has(id)))

    // Asked on A's subdomain for B's id: RLS scopes to the PINNED tenant, so
    // the explicit filter finds nothing rather than returning B's rows.
    const cross = await asPublic(A, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int n from public.google_reviews where tenant_id = ${B}::uuid`,
      ),
    )
    check("A's subdomain cannot read B's reviews", Number(cross.rows[0].n) === 0)

    // And the credentials are not reachable from a public session AT ALL.
    const creds = await asPublic(A, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int n from public.google_business_credentials`),
    )
    check('google_business_credentials is not publicly readable', Number(creds.rows[0].n) === 0)

    const D = await makeTenant('gbpd')
    const empty = await getPublicGoogleReviews(D)
    check('an unconnected venue returns an empty set, not an error', empty.reviews.length === 0 && empty.count === 0)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('5. disconnecting')
  {
    await deleteGoogleConnection(A, ownerDrizzle)
    check('the connection is gone', (await loadGoogleConnection(A, ownerDrizzle)) === null)
    const still = await getPublicGoogleReviews(A)
    check('…but the cached reviews are KEPT (disconnect ≠ erase)', still.reviews.length > 0)
  }

  for (const t of [A, B]) {
    await owner.query('delete from google_reviews where tenant_id=$1', [t])
    await owner.query('delete from google_business_credentials where tenant_id=$1', [t])
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  await ownerPool.end()
  await appPool.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
