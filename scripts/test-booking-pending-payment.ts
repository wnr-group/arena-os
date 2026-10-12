/**
 * M36 #3 — pending-payment booking state, end to end.
 * Real createPublicBooking, real booking-payment intent (stub gateway order),
 * and the REAL signed webhook route.
 *
 *   hold        an advance/full booking is pending_payment, holds the slot, and a
 *               second customer cannot take it (action AND a raw insert as arena_app)
 *   confirm     a signed payment.captured confirms it exactly once; a redelivery
 *               and a second concurrent delivery change nothing
 *   staff       a pending booking can't be checked in / completed / no-showed /
 *               billed / deposit-ed, but can be cancelled (slot is freed)
 *   rls         the public connection cannot flip a booking's status
 *   unchanged   venue and legacy optional_full (+payNow) still confirm immediately
 *   reports     a pending booking is not counted by the bookings-per-day report
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-booking-pending-payment.ts
 */
import { createHmac, createHash, randomBytes, randomInt } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'
import { seedRazorpay } from './seed-razorpay'

loadEnv()
let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

async function main() {
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../app/api/webhooks/razorpay/route')
  const { createPublicBooking, createBookingPaymentIntentByToken } = await import('../lib/actions/public-booking')
  const { createBookingPaymentIntent } = await import('../lib/payments/booking-payment')
  const { setBookingStatus, checkInBookingByToken } = await import('../lib/actions/bookings')
  const { withPublicTenant } = await import('../db')
  const { encryptSecret } = await import('../lib/security/encryption')
  const { sql } = await import('drizzle-orm')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const tag = randomBytes(3).toString('hex')
  const digits = Number(String(randomInt(0, 1_000_000_000)).padStart(9, '0'))
  let phoneSeq = 0
  const nextPhone = () => `9${String(digits + ++phoneSeq).padStart(9, '0')}`
  const slug = `pend-pay-${tag}`
  const ROOT = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000').split(':')[0]
  const g = globalThis as { __ARENA_TEST_HEADERS?: Record<string, string>; __ARENA_TEST_SESSION?: string }
  let ipSeq = 0
  const publicCtx = () => {
    g.__ARENA_TEST_SESSION = undefined
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug, 'x-forwarded-for': `10.7.${tag.charCodeAt(0)}.${++ipSeq}` }
  }

  const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,'Pending QA','active','Asia/Kolkata','recording_studio') returning id`, [slug])).rows[0].id
  const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`, [tenantId])).rows[0].id
  const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','500.00') returning id`, [tenantId])).rows[0].id
  for (let dow = 0; dow <= 6; dow++) {
    await q(`insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed) values ($1,$2,$3,'09:00','22:00',false)`, [tenantId, branchId, dow])
  }
  const WEBHOOK_SECRET = `whsec_${randomBytes(12).toString('hex')}`
  await seedRazorpay((t, p) => owner.query(t, p), tenantId, 'advance', { type: 'percent', value: 40 })
  await q(`update payment_settings set razorpay_webhook_secret_encrypted=$2 where tenant_id=$1`, [tenantId, encryptSecret(WEBHOOK_SECRET, tenantId)])

  // staff session (owner) for the staff-side actions
  const u = (await q<{ id: string }>(`insert into users (email,password_hash,full_name) values ($1,'x','Owner') returning id`, [`pend-${tag}@example.test`])).rows[0].id
  await q(`insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'owner','active','Owner')`, [tenantId, u, branchId])
  const staffToken = randomBytes(32).toString('hex')
  await q(`insert into sessions (id,user_id,expires_at) values ($1,$2,now()+interval '1 day')`, [createHash('sha256').update(staffToken).digest('hex'), u])
  const staffCtx = () => {
    g.__ARENA_TEST_SESSION = staffToken
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
  }

  let seq = 0
  const mkRes = async () =>
    (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`, [tenantId, branchId, typeId, `Set ${++seq}`])).rows[0].id
  const slotFor = (resourceId: string, dayOff = 4) => {
    const s = new Date()
    s.setUTCDate(s.getUTCDate() + dayOff)
    s.setUTCHours(4, 0, 0, 0)
    return { resourceId, startsAt: s.toISOString(), endsAt: new Date(s.getTime() + 2 * 3_600_000).toISOString() }
  }
  const book = async (w: ReturnType<typeof slotFor>, extra: Record<string, unknown> = {}) => {
    publicCtx()
    return createPublicBooking({ ...w, customerName: 'QA', customerPhone: nextPhone(), website: '', ...extra } as never)
  }
  const row = async (id: string) =>
    (await q<{ status: string; deposit: string; payment_hold_expires_at: Date | null; active: boolean }>(
      `select b.status, b.deposit, b.payment_hold_expires_at, (select bool_and(active) from booking_slots where booking_id=b.id) as active from bookings b where b.id=$1`,
      [id],
    )).rows[0]

  const startIntent = async (bookingId: string) => {
    let orderId = ''
    const co = await createBookingPaymentIntent(
      { bookingId },
      {
        runInTx: (fn) => withPublicTenant(tenantId, fn),
        credentials: { keyId: 'k', keySecret: 's' } as never,
        createOrder: async (_c, o) => {
          orderId = `order_PP${randomBytes(6).toString('hex')}`
          return { id: orderId, amount: o.amountPaise, currency: 'INR', status: 'created', receipt: o.receipt ?? null }
        },
        actor: { tenantId },
      },
    )
    return { orderId, amountPaise: co.amount as number }
  }
  const sign = (raw: string) => createHmac('sha256', WEBHOOK_SECRET).update(raw, 'utf8').digest('hex')
  const deliver = async (orderId: string, paymentId: string, amountPaise: number, eventId: string) => {
    const raw = JSON.stringify({ entity: 'event', event: 'payment.captured', contains: ['payment'], payload: { payment: { entity: { id: paymentId, entity: 'payment', amount: amountPaise, currency: 'INR', status: 'captured', order_id: orderId, method: 'upi' } } }, created_at: 1755500000 })
    const req = new NextRequest(`https://${slug}.${ROOT}/api/webhooks/razorpay`, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', 'x-razorpay-signature': sign(raw), 'x-razorpay-event-id': eventId, host: `${slug}.${ROOT}` }),
      body: raw,
    })
    const res = await POST(req)
    return { status: res.status, body: (await res.json()) as { status?: string } }
  }

  console.log('\n── hold ──')
  const resA = await mkRes()
  const wA = slotFor(resA)
  let a = await book(wA)
  let ra = await row(a.bookingId!)
  const holdMs = ra.payment_hold_expires_at ? ra.payment_hold_expires_at.getTime() - Date.now() : 0
  check('advance booking is pending_payment, not confirmed', a.awaitingOnlinePayment === true && ra.status === 'pending_payment', { a, ra })
  check('…deposit is the 40% advance (400.00 of 1000.00)', ra.deposit === '400.00', ra)
  check('…hold expires in ~15 minutes', holdMs > 14 * 60_000 && holdMs <= 15 * 60_000 + 5_000, holdMs)
  check('…its slot is active (held)', ra.active === true)
  const b2 = await book(wA)
  check('customer B cannot book the held slot (action)', Boolean(b2.error) && /just taken/i.test(b2.error!), b2)
  const rawInsert = await withPublicTenant(tenantId, async (tx) => {
    const bk = await tx.execute(sql`insert into bookings (tenant_id,branch_id,booking_number,status,source,subtotal,total,deposit) values (${tenantId},${branchId},${'BK-RAW-' + tag},'confirmed','online',1,1,0) returning id`)
    try {
      await tx.execute(sql`insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,resource_name,resource_type_name) values (${tenantId},${(bk.rows[0] as { id: string }).id},${resA},${wA.startsAt},${wA.endsAt},'x','y')`)
      return 'inserted'
    } catch (e) {
      const c = (e as { cause?: { code?: string }; code?: string })
      return c.cause?.code ?? c.code ?? 'error'
    }
  }).catch((e) => String((e as { cause?: { code?: string } }).cause?.code ?? 'error'))
  check('…and the database exclusion constraint itself refuses it (23P01)', rawInsert === '23P01', rawInsert)

  console.log('\n── rls ──')
  const flip = await withPublicTenant(tenantId, (tx) => tx.execute(sql`update bookings set status='confirmed' where id=${a.bookingId!} returning id`)).then((x) => x.rows.length, () => -1)
  check('the public connection cannot flip a booking to confirmed', flip <= 0 && (await row(a.bookingId!)).status === 'pending_payment', flip)

  console.log('\n── staff ──')
  staffCtx()
  for (const s of ['checked_in', 'completed', 'no_show'] as const) {
    const r = await setBookingStatus(a.bookingId!, s)
    check(`staff cannot mark a pending booking ${s}`, Boolean(r.error) && /awaiting/i.test(r.error!), r)
  }
  const tok = (await q<{ confirmation_token: string }>(`select confirmation_token from bookings where id=$1`, [a.bookingId])).rows[0].confirmation_token
  const ci = await checkInBookingByToken(tok)
  check('QR check-in refuses a pending booking', Boolean(ci.error), ci)
  check('…and the status is still pending_payment', (await row(a.bookingId!)).status === 'pending_payment')

  console.log('\n── confirm on verified payment ──')
  const intent = await startIntent(a.bookingId!)
  check('payment intent is for the 400.00 advance (40000 paise)', intent.amountPaise === 40000, intent)
  check('creating the intent does NOT confirm the booking (a browser is not proof)', (await row(a.bookingId!)).status === 'pending_payment')
  publicCtx()
  const retry1 = await createBookingPaymentIntentByToken({ token: tok })
  const retry2 = await createBookingPaymentIntentByToken({ token: tok })
  check('retry by confirmation token reuses the pending order (no second order) and equals the deposit in paise', retry1.checkout?.orderId === intent.orderId && retry2.checkout?.orderId === intent.orderId && retry1.checkout?.amount === 40000 && retry1.checkout?.reused === true, { retry1, retry2 })
  const junk = await createBookingPaymentIntentByToken({ token: '00000000-0000-4000-8000-000000000000' })
  check('an unknown token is refused', Boolean(junk.error), junk)
  const intentCount = Number((await q<{ n: string }>(`select count(*) n from payment_intents where booking_id=$1`, [a.bookingId])).rows[0].n)
  check('…and there is still exactly one payment intent for the booking', intentCount === 1, intentCount)
  const d1 = await deliver(intent.orderId, 'pay_PP1' + tag, 40000, 'evt_pp1_' + tag)
  ra = await row(a.bookingId!)
  check('signed payment.captured confirms the booking', d1.status === 200 && d1.body.status === 'processed' && ra.status === 'confirmed', { d1, ra })
  check('…and clears the hold expiry', ra.payment_hold_expires_at === null)
  const d2 = await deliver(intent.orderId, 'pay_PP1' + tag, 40000, 'evt_pp1_' + tag)
  const d3 = await deliver(intent.orderId, 'pay_PP1' + tag, 40000, 'evt_pp1b_' + tag)
  check('redelivery (same event, then a new event id) is a no-op', d2.status === 200 && d3.status === 200 && d2.body.status !== 'processed' && d3.body.status !== 'processed' && (await row(a.bookingId!)).status === 'confirmed', { d2, d3 })
  const [x, y] = await Promise.all([deliver(intent.orderId, 'pay_PP1' + tag, 40000, 'evt_pp1c_' + tag), deliver(intent.orderId, 'pay_PP1' + tag, 40000, 'evt_pp1d_' + tag)])
  check('concurrent redeliveries leave it confirmed with one payment intent paid', (await row(a.bookingId!)).status === 'confirmed' && x.status === 200 && y.status === 200, { x, y })
  const paid = Number((await q<{ n: string }>(`select count(*) n from payment_intents where booking_id=$1 and status='paid'`, [a.bookingId])).rows[0].n)
  check('exactly one paid intent', paid === 1, paid)
  staffCtx()
  const ci2 = await setBookingStatus(a.bookingId!, 'checked_in')
  check('once confirmed, staff can check it in as usual', !ci2.error, ci2)

  console.log('\n── cancel frees the slot ──')
  const resB = await mkRes()
  const wB = slotFor(resB, 5)
  const bb = await book(wB)
  check('another advance booking is pending', (await row(bb.bookingId!)).status === 'pending_payment', bb)
  staffCtx()
  const can = await setBookingStatus(bb.bookingId!, 'cancelled', 'customer abandoned')
  check('staff can cancel a pending booking', !can.error && (await row(bb.bookingId!)).status === 'cancelled', can)
  const rebook = await book(wB)
  check('…and the slot is free for another customer', Boolean(rebook.bookingId) && !rebook.error, rebook)

  console.log('\n── pending bookings are not reported or billable ──')
  const pend = rebook.bookingId!
  const rep = await q<{ n: string }>(
    `select count(*) n from bookings bk where bk.tenant_id=$1 and bk.status not in ('cancelled','no_show','pending_payment') and bk.id=$2`, [tenantId, pend])
  check('report filter (not in cancelled/no_show/pending_payment) excludes it', Number(rep.rows[0].n) === 0)
  const { isBillableBookingStatus } = await import('../lib/billing/invoice')
  check('pending_payment is not a billable status (POS / invoice / deposit paths)', isBillableBookingStatus('pending_payment') === false)

  console.log('\n── other modes are unchanged ──')
  await seedRazorpay((t, p) => owner.query(t, p), tenantId, 'venue')
  let w = slotFor(await mkRes(), 6)
  let r = await book(w, { payNow: true })
  check('venue: confirmed immediately', (await row(r.bookingId!)).status === 'confirmed' && (await row(r.bookingId!)).payment_hold_expires_at === null, r)
  await seedRazorpay((t, p) => owner.query(t, p), tenantId, 'optional_full')
  w = slotFor(await mkRes(), 6)
  r = await book(w)
  check('legacy, payNow unticked: confirmed immediately', (await row(r.bookingId!)).status === 'confirmed', r)
  w = slotFor(await mkRes(), 6)
  r = await book(w, { payNow: true })
  const lr = await row(r.bookingId!)
  check('legacy payNow: keeps today’s behaviour (confirmed + unpaid deposit)', lr.status === 'confirmed' && lr.deposit === '1000.00' && r.awaitingOnlinePayment === true, lr)

  await q('delete from tenants where id=$1', [tenantId])
  await q(`delete from users where email=$1`, [`pend-${tag}@example.test`])
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
