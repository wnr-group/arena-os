/**
 * Drives the REAL Google fetcher against a DUMMY Google (0106).
 *
 * The one path scripts/test-google-business-reviews.ts cannot reach is the live
 * HTTP call: this project has no approved Business Profile quota and no verified
 * consent screen. That suite therefore injects a fake FetchGoogleReviews and
 * never exercises createGoogleReviewFetcher's own body.
 *
 * This does the opposite. It runs the real createGoogleReviewFetcher(), the real
 * exchangeRefreshToken(), the real syncGoogleReviewsForTenant() and the real
 * getPublicGoogleReviews() — and swaps only the DESTINATION, by handing them a
 * `fetch` that rewrites Google's hostnames to a local server speaking Google's
 * documented JSON. Everything under test is production code; only the far end is
 * dummy.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/demo-google-reviews-dummy-api.ts
 *
 * It seeds a connection on a scratch tenant and removes it again, so it leaves
 * the database exactly as it found it.
 */
import { createServer, type Server } from 'node:http'
import { loadEnv } from './env'

const REVIEW_PAGE_1 = {
  reviews: [
    {
      reviewId: 'dummy-1',
      name: 'accounts/123/locations/456/reviews/dummy-1',
      reviewer: { displayName: 'Asha R', profilePhotoUrl: 'https://lh3.example/a.jpg' },
      starRating: 'FIVE',
      comment: 'Best courts in town. Booking took ten seconds.',
      createTime: '2026-09-01T10:00:00Z',
      updateTime: '2026-09-01T10:00:00Z',
    },
    {
      reviewId: 'dummy-2',
      name: 'accounts/123/locations/456/reviews/dummy-2',
      reviewer: { isAnonymous: true, displayName: 'Should Be Ignored' },
      starRating: 'FOUR',
      comment: 'Good lighting, parking is tight.',
      createTime: '2026-08-20T18:30:00Z',
    },
  ],
  nextPageToken: 'PAGE2',
}

const REVIEW_PAGE_2 = {
  reviews: [
    {
      reviewId: 'dummy-3',
      name: 'accounts/123/locations/456/reviews/dummy-3',
      reviewer: { displayName: 'Vikram S' },
      starRating: 'THREE',
      createTime: '2026-07-11T09:15:00Z',
    },
    // Deliberately unusable: no star rating. The mapper must DROP this rather
    // than store a 0 the column CHECK would refuse.
    {
      reviewId: 'dummy-bad',
      reviewer: { displayName: 'Malformed' },
      createTime: '2026-07-01T09:15:00Z',
    },
  ],
}

type Mode = 'ok' | 'forbidden'
let mode: Mode = 'ok'
const seen: string[] = []

function startDummyGoogle(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    seen.push(`${req.method} ${url.pathname}${url.search}`)

    if (url.pathname === '/token') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const p = new URLSearchParams(body)
        // Assert the REAL exchangeRefreshToken() sent the documented grant.
        const ok =
          p.get('grant_type') === 'refresh_token' &&
          !!p.get('refresh_token') &&
          !!p.get('client_id') &&
          !!p.get('client_secret')
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify(
            ok
              ? { access_token: 'ya29.dummy-access-token', expires_in: 3599, token_type: 'Bearer' }
              : { error: 'invalid_request', error_description: 'missing grant fields' },
          ),
        )
      })
      return
    }

    if (url.pathname.endsWith('/reviews')) {
      if (mode === 'forbidden') {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: { code: 403, message: 'Business Profile API has not been used in project 123 before or it is disabled.' },
          }),
        )
        return
      }
      // The Authorization header must carry the token the exchange just returned.
      if (req.headers.authorization !== 'Bearer ya29.dummy-access-token') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 401, message: 'bad token' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(url.searchParams.get('pageToken') === 'PAGE2' ? REVIEW_PAGE_2 : REVIEW_PAGE_1))
      return
    }

    res.writeHead(404)
    res.end('{}')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port })
    })
  })
}

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra?: unknown) => {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(extra)}`}`)
  if (ok) pass++
  else fail++
}

async function main() {
  loadEnv()
  if (!process.env.DATABASE_URL_OWNER) throw new Error('DATABASE_URL_OWNER is not set')
  if (!process.env.PAYMENT_SETTINGS_ENCRYPTION_KEY) {
    throw new Error('PAYMENT_SETTINGS_ENCRYPTION_KEY is not set')
  }

  const { server, port } = await startDummyGoogle()
  console.log(`→ dummy Google listening on 127.0.0.1:${port}\n`)

  // The ONLY substitution: Google's hostnames point at the local server. Every
  // URL below is still built by the production code under test.
  const redirect: typeof fetch = (input, init) => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const rewritten = raw
      .replace('https://mybusiness.googleapis.com', `http://127.0.0.1:${port}`)
      .replace('https://oauth2.googleapis.com', `http://127.0.0.1:${port}`)
    return fetch(rewritten, init)
  }

  const { createGoogleReviewFetcher } = await import('../lib/reviews/google-business-api')
  const { exchangeRefreshToken } = await import('../lib/reviews/google-oauth')
  const { syncGoogleReviewsForTenant } = await import('../lib/reviews/sync')
  const { getPublicGoogleReviews } = await import('../lib/reviews/public')
  const { saveGoogleOAuthClient, saveGoogleRefreshToken, deleteGoogleConnection } = await import(
    '../lib/reviews/google-credentials'
  )
  const { ownerDb } = await import('../db')
  const { sql } = await import('drizzle-orm')

  const { rows: ts } = await ownerDb.execute<{ id: string; name: string }>(
    sql`select id, name from public.tenants order by created_at limit 1`,
  )
  const tenant = ts[0]
  if (!tenant) throw new Error('no tenants in this database')
  console.log(`→ scratch tenant: ${tenant.name} (${tenant.id})\n`)

  // The real fetcher, wired to the real token exchange, both aimed at the dummy.
  const fetcher = createGoogleReviewFetcher(redirect, (rt, ci, cs) =>
    exchangeRefreshToken(rt, ci, cs, redirect),
  )

  try {
    await saveGoogleOAuthClient(tenant.id, {
      accountId: 'accounts/123',
      locationId: 'locations/456',
      clientId: 'dummy.apps.googleusercontent.com',
      clientSecret: 'dummy-client-secret',
    })
    await saveGoogleRefreshToken(tenant.id, '1//dummy-refresh-token')

    console.log('── a successful sync, end to end ──')
    const r1 = await syncGoogleReviewsForTenant(tenant.id, fetcher, ownerDb)
    check('the tenant reads as connected', r1.connected === true, r1)
    check('three usable reviews cached across two pages', r1.synced === 3, r1)
    check('no error recorded', r1.error === null, r1)
    // The malformed page-2 entry (no starRating) must be COUNTED, not just
    // silently dropped — SyncResult.skipped was structurally always 0 before
    // the fetcher started reporting it (0107).
    check('the malformed entry is reported as skipped', r1.skipped === 1, r1.skipped)
    check('the real token exchange posted to /token', seen.some((s) => s.startsWith('POST /token')), seen)
    check('page 1 asked for the documented pageSize', seen.some((s) => s.includes('pageSize=50')), seen)
    check('the loop followed nextPageToken', seen.some((s) => s.includes('pageToken=PAGE2')), seen)

    console.log('\n── what the homepage now renders ──')
    const pub = await getPublicGoogleReviews(tenant.id)
    check('three reviews are public', pub.count === 3, pub)
    check('newest first', pub.reviews[0]?.reviewerName === 'Asha R', pub.reviews.map((x) => x.reviewerName))
    check('the anonymous reviewer kept no name', pub.reviews[1]?.reviewerName === null, pub.reviews[1])
    check('…and no photo stored for them', pub.reviews[1]?.reviewerPhotoUrl === null, pub.reviews[1])
    check(
      '…while the named reviewer keeps theirs through the round trip',
      pub.reviews[0]?.reviewerPhotoUrl === 'https://lh3.example/a.jpg',
      pub.reviews[0],
    )
    check('a stars-only review kept null words', pub.reviews[2]?.comment === null, pub.reviews[2])
    check('FIVE mapped to 5', pub.reviews[0]?.rating === 5, pub.reviews[0])
    check('the average is over what is cached', pub.averageRating === 4, pub.averageRating)
    for (const rv of pub.reviews) {
      console.log(
        `      ${'★'.repeat(rv.rating)}${'☆'.repeat(5 - rv.rating)}  ` +
          `${rv.reviewerName ?? 'A Google user'} — ${rv.comment ?? '(no words)'}`,
      )
    }

    console.log('\n── a re-sync is idempotent ──')
    const r2 = await syncGoogleReviewsForTenant(tenant.id, fetcher, ownerDb)
    const pub2 = await getPublicGoogleReviews(tenant.id)
    check('the same three are rewritten, not duplicated', r2.synced === 3 && pub2.count === 3, {
      synced: r2.synced,
      count: pub2.count,
    })

    console.log('\n── the failure path, classified from a real 403 ──')
    mode = 'forbidden'
    const r3 = await syncGoogleReviewsForTenant(tenant.id, fetcher, ownerDb)
    check('the sync returns an error rather than throwing', r3.error !== null, r3)
    check(
      '…and explains 403 rather than just saying 403',
      /Business Profile API is not enabled/.test(r3.error ?? ''),
      r3.error,
    )
    const { rows: err } = await ownerDb.execute<{ last_sync_error: string | null }>(
      sql`select last_sync_error from public.google_business_credentials where tenant_id = ${tenant.id}::uuid`,
    )
    check('…recorded where an operator can find it', !!err[0]?.last_sync_error, err[0])
    check('the cached reviews survived the failure', (await getPublicGoogleReviews(tenant.id)).count === 3)

    console.log('\n── recovery ──')
    mode = 'ok'
    const r4 = await syncGoogleReviewsForTenant(tenant.id, fetcher, ownerDb)
    const { rows: err2 } = await ownerDb.execute<{ last_sync_error: string | null }>(
      sql`select last_sync_error from public.google_business_credentials where tenant_id = ${tenant.id}::uuid`,
    )
    check('a later success clears the error', r4.error === null && err2[0]?.last_sync_error === null, err2[0])
  } finally {
    await ownerDb.execute(sql`delete from public.google_reviews where tenant_id = ${tenant.id}::uuid`)
    await deleteGoogleConnection(tenant.id)
    server.close()
    const { rows: left } = await ownerDb.execute<{ c: number; r: number }>(
      sql`select (select count(*) from public.google_business_credentials)::int c,
                 (select count(*) from public.google_reviews)::int r`,
    )
    console.log(`\n→ cleaned up — credentials ${left[0].c}, cached reviews ${left[0].r}`)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
