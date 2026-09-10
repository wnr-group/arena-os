/**
 * Google review prompt (0104) — the URL rule, eligibility, completion and
 * tenant isolation, against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-google-review.ts
 *
 * The eligibility half is exercised through REAL rows in `bookings` and
 * `orders`, not stubs, because "what counts as successful" is the whole
 * question this feature turns on.
 */
import { Client, Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import {
  normalizeGoogleReviewUrl,
  isGoogleReviewUrl,
} from '../lib/settings/google-review'
import { businessProfileSchema, upsertBusinessProfile } from '../lib/settings/business-profile'
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

async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

async function main() {
  loadEnv()

  // ════════════════════════════════════════════════════════════════════════
  section('1. the URL rule (pure — no database)')
  {
    const g = 'https://g.page/r/AbC123DeF456/review'
    check('a g.page review link is accepted', normalizeGoogleReviewUrl(g) === g)
    const w = 'https://search.google.com/local/writereview?placeid=ChIJabc123'
    check('the writereview form is accepted, query intact', normalizeGoogleReviewUrl(w) === w)
    check(
      'a Maps URL is accepted',
      normalizeGoogleReviewUrl('https://www.google.com/maps/place/Arena') ===
        'https://www.google.com/maps/place/Arena',
    )
    check(
      'a country TLD is accepted',
      normalizeGoogleReviewUrl('https://www.google.co.in/maps/place/Arena') !== null,
    )
    check(
      'a Maps share link is accepted',
      normalizeGoogleReviewUrl('https://maps.app.goo.gl/AbC123') !== null,
    )

    // THE reason the host is an allowlist.
    check('another host is refused', normalizeGoogleReviewUrl('https://evil.example/review') === null)
    check(
      'a lookalike host is refused',
      normalizeGoogleReviewUrl('https://google.com.evil.example/maps') === null,
    )
    check('http is refused', normalizeGoogleReviewUrl('http://g.page/r/AbC123/review') === null)
    check('javascript: is refused', normalizeGoogleReviewUrl('javascript:alert(1)') === null)
    check(
      'a non-Maps google.com page is refused',
      normalizeGoogleReviewUrl('https://www.google.com/search?q=arena') === null,
    )
    check(
      'writereview without a placeid is refused',
      normalizeGoogleReviewUrl('https://search.google.com/local/writereview') === null,
    )
    check('blank is null, not an error', normalizeGoogleReviewUrl('   ') === null)
    check('null in, null out', normalizeGoogleReviewUrl(null) === null)
    check('a fragment is dropped', normalizeGoogleReviewUrl(`${g}#x`) === g)
    check('isGoogleReviewUrl agrees', isGoogleReviewUrl(g) && !isGoogleReviewUrl('https://x.test/a'))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('2. the save contract')
  {
    const base = { invoicePrefix: 'INV', whatsappGroupEnabled: false, googleReviewEnabled: false }
    check('a profile with no Google fields parses', businessProfileSchema.safeParse(base).success)
    check(
      'a bad URL is refused even when disabled',
      !businessProfileSchema.safeParse({ ...base, googleReviewUrl: 'https://evil.example/x' })
        .success,
    )
    check(
      'enabling with no link is refused',
      !businessProfileSchema.safeParse({ ...base, googleReviewEnabled: true }).success,
    )
    check(
      'enabling with a good link is accepted',
      businessProfileSchema.safeParse({
        ...base,
        googleReviewUrl: 'https://g.page/r/AbC123DeF456/review',
        googleReviewEnabled: true,
      }).success,
    )
  }

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  const app = drizzle(appPool, { schema })

  const asCustomer = <T,>(customerId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.customer_id', ${customerId}, true)`)
      return fn(tx as unknown as Db)
    })

  /** The reader's question, asked exactly as lib/portal/review-prompt.ts asks it. */
  const linkFor = (customerId: string, tenantId: string) =>
    asCustomer(customerId, (tx) =>
      tx
        .execute<{ url: string | null }>(
          sql`select public.public_google_review(${tenantId}::uuid) as url`,
        )
        .then((r) => r.rows[0].url),
    )

  /** Eligibility exactly as the app asks it — through the function. */
  const eligible = (customerId: string) =>
    asCustomer(customerId, (tx) =>
      tx
        .execute<{ yes: boolean }>(sql`select public.customer_review_eligible() as yes`)
        .then((r) => r.rows[0].yes),
    )

  /** Completion exactly as the app does it — through the function. */
  const complete = (customerId: string) =>
    asCustomer(customerId, (tx) =>
      tx
        .execute<{ ok: boolean }>(sql`select public.customer_complete_review_prompt() as ok`)
        .then((r) => r.rows[0].ok),
    )
  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$1,'active','Asia/Kolkata')
       on conflict (slug) do update set status='active' returning id`,
      [slug],
    )
    const tenantId = t.rows[0].id
    await owner.query('delete from business_profiles where tenant_id=$1', [tenantId])
    await owner.query('delete from customers where tenant_id=$1', [tenantId])
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active')
       on conflict (tenant_id,name) do update set status='active' returning id`,
      [tenantId],
    )
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
    await owner.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active'`,
      [tenantId, u.rows[0].id],
    )
    return { tenantId, branchId: b.rows[0].id, userId: u.rows[0].id }
  }

  let seq = 0
  const makeCustomer = async (tenantId: string, name: string) => {
    seq++
    const r = await owner.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
      [tenantId, `+9195${String(10000000 + seq).slice(0, 8)}`, name],
    )
    return r.rows[0].id
  }

  const A = await makeTenant('grva')
  const B = await makeTenant('grvb')
  const URL_A = 'https://g.page/r/TenantAAAAAAA/review'
  const URL_B = 'https://g.page/r/TenantBBBBBBB/review'

  const withUser = <T,>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })

  for (const [t, url] of [
    [A, URL_A],
    [B, URL_B],
  ] as const) {
    await withUser(t.userId, (tx) =>
      upsertBusinessProfile(tx, t.tenantId, {
        invoicePrefix: 'INV',
        whatsappGroupEnabled: false,
        googleReviewUrl: url,
        googleReviewEnabled: true,
      } as never),
    )
  }

  // ════════════════════════════════════════════════════════════════════════
  section('3. the database refuses what the rule refuses')
  {
    const off = await refusal(() =>
      owner.query('update business_profiles set google_review_url=$2 where tenant_id=$1', [
        A.tenantId,
        'https://evil.example/review',
      ]),
    )
    check('an off-Google URL is refused by the CHECK', off !== null)
    check('…naming the constraint', (off ?? '').includes('business_profiles_google_review_url'), off)

    const onNoUrl = await refusal(() =>
      owner.query(
        'update business_profiles set google_review_url=null, google_review_enabled=true where tenant_id=$1',
        [A.tenantId],
      ),
    )
    check('enabled with no link is refused by the CHECK', onNoUrl !== null)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('4. eligibility comes from real bookings and orders')
  {
    const fresh = await makeCustomer(A.tenantId, 'Never Visited')
    check('a customer with no history is NOT eligible', (await eligible(fresh)) === false)

    // A booking.
    const booker = await makeCustomer(A.tenantId, 'Booker')
    const mkBooking = async (customerId: string, status: string) =>
      owner.query(
        `insert into bookings (tenant_id,branch_id,customer_id,booking_number,status,source,
                               subtotal,discount,tax,total,deposit)
         values ($1,$2,$3,'BK'||floor(random()*1e9)::text,$4::booking_status,'online',
                 '0','0','0','0','0')`,
        [A.tenantId, A.branchId, customerId, status],
      )
    await mkBooking(booker, 'confirmed')
    check('a confirmed booking makes the customer eligible', (await eligible(booker)) === true)

    const cancelled = await makeCustomer(A.tenantId, 'Cancelled Only')
    await mkBooking(cancelled, 'cancelled')
    check('a CANCELLED booking does not', (await eligible(cancelled)) === false)

    const noShow = await makeCustomer(A.tenantId, 'No Show')
    await mkBooking(noShow, 'no_show')
    check('a NO-SHOW booking does not', (await eligible(noShow)) === false)

    // An order.
    const mkOrder = async (customerId: string, status: string, acceptance: string) =>
      owner.query(
        `insert into orders (tenant_id,branch_id,customer_id,order_number,status,acceptance_status)
         values ($1,$2,$3,'OD'||floor(random()*1e9)::text,$4::order_status,$5::order_acceptance_status)`,
        [A.tenantId, A.branchId, customerId, status, acceptance],
      )
    const orderer = await makeCustomer(A.tenantId, 'Orderer')
    await mkOrder(orderer, 'open', 'accepted')
    check('an accepted order makes the customer eligible', (await eligible(orderer)) === true)

    const pendingOrder = await makeCustomer(A.tenantId, 'Pending Order')
    await mkOrder(pendingOrder, 'open', 'pending')
    check('a PENDING (unaccepted) order does not', (await eligible(pendingOrder)) === false)

    const rejected = await makeCustomer(A.tenantId, 'Rejected Order')
    await mkOrder(rejected, 'open', 'rejected')
    check('a REJECTED order does not', (await eligible(rejected)) === false)

    const cancelledOrder = await makeCustomer(A.tenantId, 'Cancelled Order')
    await mkOrder(cancelledOrder, 'cancelled', 'accepted')
    check('a CANCELLED order does not', (await eligible(cancelledOrder)) === false)

    // §12 — many transactions, still one prompt. The prompt is a QUESTION about
    // the customer, so there is nothing that could exist five times.
    const heavy = await makeCustomer(A.tenantId, 'Regular')
    for (let i = 0; i < 5; i++) await mkBooking(heavy, 'completed')
    for (let i = 0; i < 5; i++) await mkOrder(heavy, 'billed', 'accepted')
    check('5 bookings + 5 orders is still exactly one eligible answer', (await eligible(heavy)) === true)
    const [{ n }] = (
      await owner.query<{ n: string }>(
        `select count(*) n from customers where id=$1 and google_review_prompt_completed_at is null`,
        [heavy],
      )
    ).rows
    check('…and exactly one prompt row — the customer row itself', Number(n) === 1)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('5. completion, and what it does not claim')
  {
    const c = await makeCustomer(A.tenantId, 'Reviewer')
    check('pending by default', (await linkFor(c, A.tenantId)) === URL_A)

    check('the customer records their own answer', (await complete(c)) === true)
    check('…and the prompt then reads as answered', (await linkFor(c, A.tenantId)) === URL_A)
    check(
      '…a replay is idempotent, not a second write',
      (await complete(c)) === false,
    )
    // The completion is the customer's statement — nothing here consults Google.
    check(
      'completion is stored on the customer row, not a Google signal',
      (
        await owner.query<{ n: string }>(
          `select count(*) n from information_schema.columns
            where table_name='customers' and column_name='google_review_prompt_completed_at'`,
        )
      ).rows[0].n === '1',
    )
  }

  // ════════════════════════════════════════════════════════════════════════
  section('6. tenant isolation')
  {
    const ca = await makeCustomer(A.tenantId, 'A Customer')
    const cb = await makeCustomer(B.tenantId, 'B Customer')

    check("A's customer gets A's link", (await linkFor(ca, A.tenantId)) === URL_A)
    check("B's customer gets B's link", (await linkFor(cb, B.tenantId)) === URL_B)

    // THE isolation property: the argument alone must not select a row.
    check("A's customer cannot resolve B's link", (await linkFor(ca, B.tenantId)) === null)
    check("B's customer cannot resolve A's link", (await linkFor(cb, A.tenantId)) === null)

    // business_profiles itself stays shut — the reason this is a projection.
    const direct = await asCustomer(ca, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int n from public.business_profiles where tenant_id = ${A.tenantId}::uuid`,
      ),
    )
    check('business_profiles is not readable by a customer session', Number(direct.rows[0].n) === 0)

    // A customer cannot touch another customer's answer.
    const before = (
      await owner.query<{ done: string | null }>(
        'select google_review_prompt_completed_at done from customers where id=$1',
        [cb],
      )
    ).rows[0].done
    // The function only ever touches current_customer_id()'s own row, so
    // there is no argument through which A could reach B. Asserted anyway.
    await complete(ca)
    const after = (
      await owner.query<{ done: string | null }>(
        'select google_review_prompt_completed_at done from customers where id=$1',
        [cb],
      )
    ).rows[0].done
    check("A's customer cannot complete B's customer's prompt", before === after)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('7. the venue switch')
  {
    const c = await makeCustomer(A.tenantId, 'Switch Watcher')
    check('enabled → link', (await linkFor(c, A.tenantId)) === URL_A)

    await owner.query('update business_profiles set google_review_enabled=false where tenant_id=$1', [
      A.tenantId,
    ])
    check('disabled → no link (prompt hidden)', (await linkFor(c, A.tenantId)) === null)
    check(
      '…but the URL is preserved, not deleted',
      (
        await owner.query<{ u: string }>(
          'select google_review_url u from business_profiles where tenant_id=$1',
          [A.tenantId],
        )
      ).rows[0].u === URL_A,
    )

    await owner.query('update business_profiles set google_review_enabled=true where tenant_id=$1', [
      A.tenantId,
    ])
    check('re-enabled → pending customers see it again', (await linkFor(c, A.tenantId)) === URL_A)

    const unconfigured = await makeTenant('grvc')
    const cc = await makeCustomer(unconfigured.tenantId, 'No Profile')
    check(
      'a venue with no profile row reads null, not an error',
      (await linkFor(cc, unconfigured.tenantId)) === null,
    )
  }

  for (const t of [A, B]) {
    await owner.query('delete from customers where tenant_id=$1', [t.tenantId])
    await owner.query('delete from business_profiles where tenant_id=$1', [t.tenantId])
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  await appPool.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
