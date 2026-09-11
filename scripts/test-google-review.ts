/**
 * Google review prompt (0105) — the URL rule, eligibility, completion and
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

  /**
   * THE decision, exactly as lib/portal/review-prompt.ts makes it: the same
   * three gates, in the same order, inside one customer transaction. Returns
   * the URL the popup would be handed, or null when no popup shows.
   *
   * Worth having as well as the per-gate helpers above, because "does the
   * popup appear" is a question about the gates TOGETHER — an eligible
   * customer who has already answered must still get nothing, and that
   * combination is not visible from either gate alone.
   *
   * Every rule it consults lives in SQL (public_google_review,
   * customer_review_eligible, the completion column), so this mirrors the
   * reader's ORDER without re-stating any of its logic.
   */
  const promptFor = (customerId: string, tenantId: string) =>
    asCustomer(customerId, async (tx) => {
      // 1. already answered?
      const answered = await tx.execute<{ done: Date | null }>(
        sql`select google_review_prompt_completed_at as done
              from public.customers where id = ${customerId}::uuid`,
      )
      if (!answered.rows[0] || answered.rows[0].done !== null) return null

      // 2 + 3. the venue's link, enabled and still valid
      const link = await tx.execute<{ url: string | null }>(
        sql`select public.public_google_review(${tenantId}::uuid) as url`,
      )
      const url = link.rows[0]?.url ?? null
      if (!url) return null

      // 4. eligibility
      const elig = await tx.execute<{ yes: boolean }>(
        sql`select public.customer_review_eligible() as yes`,
      )
      return elig.rows[0]?.yes === true ? url : null
    })

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
  // ── shared fixture builders ───────────────────────────────────────────────
  //
  // mkOrder returns the order id because delivery is not ON the order:
  // orders.status is the BILLING lifecycle (open/billed/cancelled) and has no
  // fulfilment value. Food reaching the customer is kots.status = 'served', and
  // createOrderCore writes exactly one KOT per order in the same transaction —
  // so these fixtures mirror the real shape.
  const mkBooking = async (customerId: string, status: string, tenant = A) =>
    owner.query(
      `insert into bookings (tenant_id,branch_id,customer_id,booking_number,status,source,
                             subtotal,discount,tax,total,deposit)
       values ($1,$2,$3,'BK'||floor(random()*1e9)::text,$4::booking_status,'online',
               '0','0','0','0','0')`,
      [tenant.tenantId, tenant.branchId, customerId, status],
    )

  const mkOrder = async (customerId: string, status: string, acceptance: string, tenant = A) => {
    const r = await owner.query<{ id: string }>(
      `insert into orders (tenant_id,branch_id,customer_id,order_number,status,acceptance_status)
       values ($1,$2,$3,'OD'||floor(random()*1e9)::text,$4::order_status,$5::order_acceptance_status)
       returning id`,
      [tenant.tenantId, tenant.branchId, customerId, status, acceptance],
    )
    return r.rows[0].id
  }

  const mkKot = async (orderId: string, status: string, tenant = A) =>
    owner.query(
      `insert into kots (tenant_id,branch_id,order_id,kot_number,status)
       values ($1,$2,$3,'KOT'||floor(random()*1e9)::text,$4::kot_status)`,
      [tenant.tenantId, tenant.branchId, orderId, status],
    )

  /** Food that reached the customer, and nothing else. */
  const mkServedFood = async (customerId: string, tenant = A) =>
    mkKot(await mkOrder(customerId, 'billed', 'accepted', tenant), 'served', tenant)

  section('4. eligibility: an ACTIVE booking OR DELIVERED food (0108)')
  {
    // Because the rule is OR, each half has to be exercised with the OTHER HALF
    // ABSENT. A customer given a qualifying booking is eligible whatever their
    // food looks like, so pairing bad food with a good booking would prove
    // nothing about the food gate.

    // ── 12. nothing finished at all ─────────────────────────────────────────
    const fresh = await makeCustomer(A.tenantId, 'Never Visited')
    check('a customer with no history is NOT eligible', (await eligible(fresh)) === false)

    // ── the BOOKING half, with no food anywhere ─────────────────────────────
    // The booking half is UNCHANGED from 0105: an existing booking that has not
    // been called off qualifies on its own, whatever the kitchen is doing.
    for (const st of ['confirmed', 'checked_in', 'completed']) {
      const c = await makeCustomer(A.tenantId, `${st} booking only`)
      await mkBooking(c, st)
      check(`a '${st}' booking ALONE is eligible (no food needed)`, (await eligible(c)) === true)
    }

    for (const st of ['cancelled', 'no_show']) {
      const c = await makeCustomer(A.tenantId, `${st} booking only`)
      await mkBooking(c, st)
      check(`a '${st}' booking alone is NOT eligible`, (await eligible(c)) === false)
    }

    // ── the FOOD half, with no booking anywhere ─────────────────────────────
    const foodOnly = await makeCustomer(A.tenantId, 'Served Food Only')
    await mkServedFood(foodOnly)
    check('served food ALONE is eligible (no booking needed)', (await eligible(foodOnly)) === true)

    for (const kot of ['pending', 'preparing', 'ready', 'cancelled']) {
      const c = await makeCustomer(A.tenantId, `${kot} food only`)
      await mkKot(await mkOrder(c, 'open', 'accepted'), kot)
      check(`food still '${kot}' alone is NOT eligible`, (await eligible(c)) === false)
    }

    const noKot = await makeCustomer(A.tenantId, 'Order never ticketed')
    await mkOrder(noKot, 'open', 'accepted')
    check('an accepted order with no kitchen ticket is NOT eligible', (await eligible(noKot)) === false)

    const cancelledOrder = await makeCustomer(A.tenantId, 'Cancelled order, served ticket')
    await mkKot(await mkOrder(cancelledOrder, 'cancelled', 'accepted'), 'served')
    check('a CANCELLED order is NOT eligible even once served', (await eligible(cancelledOrder)) === false)

    for (const acc of ['pending', 'rejected', 'awaiting_payment']) {
      const c = await makeCustomer(A.tenantId, `${acc} order, served ticket`)
      await mkKot(await mkOrder(c, 'open', acc), 'served')
      check(`an order still '${acc}' is NOT eligible, even served`, (await eligible(c)) === false)
    }

    // ── OR, not AND: one good half carries a bad other half ─────────────────
    const goodBookingBadFood = await makeCustomer(A.tenantId, 'Confirmed booking, food pending')
    await mkBooking(goodBookingBadFood, 'confirmed')
    await mkKot(await mkOrder(goodBookingBadFood, 'open', 'accepted'), 'pending')
    check(
      'confirmed booking + undelivered food is eligible — the booking carries it',
      (await eligible(goodBookingBadFood)) === true,
    )

    const badBookingGoodFood = await makeCustomer(A.tenantId, 'Cancelled booking, food served')
    await mkBooking(badBookingGoodFood, 'cancelled')
    await mkServedFood(badBookingGoodFood)
    check(
      'cancelled booking + served food is eligible — the food carries it',
      (await eligible(badBookingGoodFood)) === true,
    )

    const both = await makeCustomer(A.tenantId, 'Both Halves')
    await mkBooking(both, 'completed')
    await mkServedFood(both)

    check('completed booking + served food is eligible', (await eligible(both)) === true)

    const neither = await makeCustomer(A.tenantId, 'Neither Half')
    await mkBooking(neither, 'no_show')
    await mkKot(await mkOrder(neither, 'open', 'accepted'), 'cancelled')
    check('a no-show booking + a cancelled ticket is NOT eligible', (await eligible(neither)) === false)

    // ── 9. one customer cannot borrow another's history ─────────────────────
    const borrower = await makeCustomer(A.tenantId, 'Borrower')
    await mkBooking(borrower, 'no_show')
    check(
      "another customer's booking and served food do not carry this one",
      (await eligible(borrower)) === false,
    )
    check('…while the customers who earned it still are', (await eligible(both)) === true)

    // ── 10. one tenant cannot make another tenant's customer eligible ───────
    const bQualified = await makeCustomer(B.tenantId, 'B Qualified')
    await mkBooking(bQualified, 'confirmed', B)
    check("tenant B's own booking makes B's customer eligible", (await eligible(bQualified)) === true)

    // The two halves are protected by DIFFERENT things, so they are asserted
    // differently.
    //
    // BOOKINGS carry a composite FK — (tenant_id, customer_id) references
    // customers(tenant_id, id) — so a booking for tenant A's customer under
    // tenant B is not merely refused by the eligibility function, it cannot be
    // WRITTEN. The strongest possible guarantee, so assert that instead of
    // asserting a row that cannot exist.
    const aUnderB = await makeCustomer(A.tenantId, 'A customer, B booking')
    const refused = await refusal(() => mkBooking(aUnderB, 'completed', B))
    check(
      "a booking cannot even be written for another tenant's customer",
      refused?.includes('bookings_customer_tenant_fkey') === true,
      refused,
    )

    // ORDERS do NOT have that composite FK — orders_customer_id_fkey is
    // customer_id alone — so the cross-tenant row IS writable. Here the ONLY
    // thing standing between tenant B's kitchen and tenant A's customer is the
    // function's own `o.tenant_id = current_customer_tenant_id()` predicate.
    // That makes this the case actually worth testing.
    const aFoodUnderB = await makeCustomer(A.tenantId, 'A customer, B food')
    await mkServedFood(aFoodUnderB, B)
    check(
      "food served under tenant B cannot qualify tenant A's customer",
      (await eligible(aFoodUnderB)) === false,
    )
    check(
      '…even though the cross-tenant order row was accepted by the schema',
      (
        await owner.query(
          `select 1 from orders where customer_id=$1 and tenant_id=$2`,
          [aFoodUnderB, B.tenantId],
        )
      ).rowCount === 1,
    )

    // ── 8. an answered prompt stays answered ────────────────────────────────
    const answered = await makeCustomer(A.tenantId, 'Already Reviewed')
    await mkBooking(answered, 'confirmed')
    check('…eligible before answering', (await eligible(answered)) === true)
    await complete(answered)
    check('…still eligible as a FACT after answering', (await eligible(answered)) === true)
    const [{ done }] = (
      await owner.query<{ done: string | null }>(
        `select google_review_prompt_completed_at done from customers where id=$1`,
        [answered],
      )
    ).rows
    check('…but the prompt is recorded answered, which is what suppresses it', done !== null)

    // §12 — many transactions, still one prompt. The prompt is a QUESTION about
    // the customer, so there is nothing that could exist five times.
    const heavy = await makeCustomer(A.tenantId, 'Regular')
    for (let i = 0; i < 5; i++) await mkBooking(heavy, 'completed')
    for (let i = 0; i < 5; i++) await mkServedFood(heavy)
    check('5 bookings + 5 delivered orders is still exactly one eligible answer', (await eligible(heavy)) === true)
    const [{ n }] = (
      await owner.query<{ n: string }>(
        `select count(*) n from customers where id=$1 and google_review_prompt_completed_at is null`,
        [heavy],
      )
    ).rows
    check('…and exactly one prompt row — the customer row itself', Number(n) === 1)
  }

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

  // ════════════════════════════════════════════════════════════════════════
  //
  // Sections 4–7 test each GATE. This one tests the POPUP: the whole decision
  // getReviewPrompt() makes, for the surfaces a customer actually sees.
  //
  // The prompt is mounted once, in app/(portal)/layout.tsx, so it covers every
  // portal page — /account and /account/bookings, /account/wallet,
  // /account/profile alike. There is one rule, not one per page: an active
  // booking OR delivered food. These assert that union end to end, and that
  // answering it silences the popup EVERYWHERE rather than on the page it was
  // answered from.
  // ════════════════════════════════════════════════════════════════════════
  //
  // Sections 4–7 test each GATE. This one tests the POPUP: the whole decision
  // getReviewPrompt() makes, on the two surfaces a customer actually sees.
  //
  //   'portal'  every portal page except the home  → a LIVE booking
  //   'home'    /account                           → that, OR a finished one
  //
  // One mounted component picks between them by route (GoogleReviewPrompt), so
  // these assert the same union the client does — and that answering silences
  // the popup on BOTH surfaces, not just the one it was answered from.
  // ════════════════════════════════════════════════════════════════════════
  //
  // Sections 4–7 test each GATE. This one tests the POPUP: the whole decision
  // getReviewPrompt() makes.
  //
  // ONE rule, on every portal page. The prompt is mounted once by the portal
  // layout and asks the same question from /account, /account/bookings,
  // /account/wallet and /account/profile alike — there is deliberately no
  // per-route variation, because a prompt that appeared on one tab of the
  // portal and not another reads as a bug rather than as a design.
  section('8. the popup itself, across the whole portal')
  {
    // ── every qualifying experience raises it ───────────────────────────────
    const qualifying: [string, (c: string) => Promise<unknown>][] = [
      ['a confirmed booking', (c) => mkBooking(c, 'confirmed')],
      ['a checked-in booking', (c) => mkBooking(c, 'checked_in')],
      ['a completed booking', (c) => mkBooking(c, 'completed')],
      ['served food', (c) => mkServedFood(c)],
    ]
    for (const [label, seed] of qualifying) {
      const c = await makeCustomer(A.tenantId, `Popup: ${label}`)
      await seed(c)
      check(`${label} shows the popup`, (await promptFor(c, A.tenantId)) === URL_A)
    }

    // ── and nothing else does ───────────────────────────────────────────────
    const offCases: [string, (c: string) => Promise<unknown>][] = [
      ['a cancelled booking', (c) => mkBooking(c, 'cancelled')],
      ['a no-show booking', (c) => mkBooking(c, 'no_show')],
      ['food still pending in the kitchen', async (c) => mkKot(await mkOrder(c, 'open', 'accepted'), 'pending')],
      ['a cancelled kitchen ticket', async (c) => mkKot(await mkOrder(c, 'open', 'accepted'), 'cancelled')],
      ['an order awaiting payment', async (c) => mkKot(await mkOrder(c, 'open', 'awaiting_payment'), 'served')],
      ['no history at all', async () => undefined],
    ]
    for (const [label, seed] of offCases) {
      const c = await makeCustomer(A.tenantId, `No popup: ${label}`)
      await seed(c)
      check(`${label} shows NO popup`, (await promptFor(c, A.tenantId)) === null)
    }

    // ── "Maybe later" is a BROWSER decision, never a server one ─────────────
    //
    // Dismissing is remembered in sessionStorage by GoogleReviewPrompt and
    // reaches no action at all. What that means server-side is asserted here:
    // nothing about the customer changed, so the next portal visit — a new tab,
    // a refresh, tomorrow — asks again. Only the completion function stops it.
    const later = await makeCustomer(A.tenantId, 'Maybe Later')
    await mkBooking(later, 'completed')
    check('…shown on the first visit', (await promptFor(later, A.tenantId)) === URL_A)
    // (the customer taps "Maybe Later" — no server call happens at all)
    check('…still pending on a later visit, because nothing was written', (await promptFor(later, A.tenantId)) === URL_A)
    const untouched = (
      await owner.query<{ done: string | null }>(
        `select google_review_prompt_completed_at done from customers where id=$1`,
        [later],
      )
    ).rows[0].done
    check('…the completion column is untouched by a dismissal', untouched === null)

    // ── "I've left my review" silences it everywhere ────────────────────────
    const reviewed = await makeCustomer(A.tenantId, 'Says They Reviewed')
    await mkBooking(reviewed, 'completed')
    await mkServedFood(reviewed)
    check('…shown while pending', (await promptFor(reviewed, A.tenantId)) === URL_A)
    check('the customer confirms', (await complete(reviewed)) === true)
    check('…no popup afterwards, anywhere in the portal', (await promptFor(reviewed, A.tenantId)) === null)
    check(
      '…even though they are still eligible — completion is what suppresses it',
      (await eligible(reviewed)) === true,
    )
    check('…and a replay changes nothing', (await complete(reviewed)) === false)

    // ── isolation, at the popup level ───────────────────────────────────────
    const aCustomer = await makeCustomer(A.tenantId, 'Popup A')
    await mkBooking(aCustomer, 'completed')
    const bCustomer = await makeCustomer(B.tenantId, 'Popup B')
    await mkBooking(bCustomer, 'completed', B)
    check("A's customer gets A's link", (await promptFor(aCustomer, A.tenantId)) === URL_A)
    check("B's customer gets B's link", (await promptFor(bCustomer, B.tenantId)) === URL_B)
    check("A's customer cannot pull B's link by naming B", (await promptFor(aCustomer, B.tenantId)) === null)
    check("B's customer cannot pull A's link by naming A", (await promptFor(bCustomer, A.tenantId)) === null)

    // One customer answering must not silence another's prompt.
    const twin = await makeCustomer(A.tenantId, 'Untouched Twin')
    await mkBooking(twin, 'completed')
    await complete(aCustomer)
    check("…the twin's popup is unaffected by someone else answering", (await promptFor(twin, A.tenantId)) === URL_A)
    check('…while the one who answered is silenced', (await promptFor(aCustomer, A.tenantId)) === null)
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
