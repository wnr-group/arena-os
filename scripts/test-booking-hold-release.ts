/**
 * M36 #4 — releasing unpaid holds, and money that arrives after the release.
 * Real createPublicBooking, real booking-payment intent (stub gateway order),
 * the REAL signed webhook route and the REAL sweep.
 *
 *   release     an expired unpaid hold is cancelled ("Payment not completed",
 *               audited, no refund review), the slot is bookable at once and the
 *               add-on units return to stock; confirmed / legacy / unexpired
 *               bookings are untouched; the public actions release on demand
 *   race        sweep and webhook fired together on one booking: one coherent
 *               outcome, one paid intent, no double processing
 *   late pay    slot free -> reinstated + confirmed once; slot taken / add-on
 *               stock gone / staff-cancelled -> stays cancelled, refund review
 *               raised, payment recorded, no phantom revenue
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-booking-hold-release.ts
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
  const { createPublicBooking } = await import('../lib/actions/public-booking')
  const { createBookingPaymentIntent } = await import('../lib/payments/booking-payment')
  const { setBookingStatus } = await import('../lib/actions/bookings')
  const { releaseExpiredHolds } = await import('../lib/booking/payment-hold')
  const { withPublicTenant } = await import('../db')
  const { encryptSecret } = await import('../lib/security/encryption')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const tag = randomBytes(3).toString('hex')
  const digits = Number(String(randomInt(0, 1_000_000_000)).padStart(9, '0'))
  let phoneSeq = 0
  const nextPhone = () => `9${String(digits + ++phoneSeq).padStart(9, '0')}`
  const slug = `hold-rel-${tag}`
  const ROOT = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000').split(':')[0]
  const g = globalThis as { __ARENA_TEST_HEADERS?: Record<string, string>; __ARENA_TEST_SESSION?: string }
  let ipSeq = 0
  const publicCtx = () => {
    g.__ARENA_TEST_SESSION = undefined
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug, 'x-forwarded-for': `10.6.${tag.charCodeAt(0)}.${++ipSeq}` }
  }

  const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,'Hold QA','active','Asia/Kolkata','recording_studio') returning id`, [slug])).rows[0].id
  const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`, [tenantId])).rows[0].id
  const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','500.00') returning id`, [tenantId])).rows[0].id
  for (let dow = 0; dow <= 6; dow++) {
    await q(`insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed) values ($1,$2,$3,'09:00','22:00',false)`, [tenantId, branchId, dow])
  }
  const mkAddon = async (stock: number) =>
    (await q<{ id: string }>(`insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity,is_active) values ($1,$2,$3,$4,'100.00','hour',$5,true) returning id`, [tenantId, branchId, typeId, `Cam ${randomBytes(2).toString('hex')}`, stock])).rows[0].id
  const WEBHOOK_SECRET = `whsec_${randomBytes(12).toString('hex')}`
  await seedRazorpay((t, p) => owner.query(t, p), tenantId, 'advance', { type: 'percent', value: 40 })
  await q(`update payment_settings set razorpay_webhook_secret_encrypted=$2 where tenant_id=$1`, [tenantId, encryptSecret(WEBHOOK_SECRET, tenantId)])

  const u = (await q<{ id: string }>(`insert into users (email,password_hash,full_name) values ($1,'x','Owner') returning id`, [`hold-${tag}@example.test`])).rows[0].id
  await q(`insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'owner','active','Owner')`, [tenantId, u, branchId])
  const staffToken = randomBytes(32).toString('hex')
  await q(`insert into sessions (id,user_id,expires_at) values ($1,$2,now()+interval '1 day')`, [createHash('sha256').update(staffToken).digest('hex'), u])

  let seq = 0
  const mkRes = async () =>
    (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`, [tenantId, branchId, typeId, `Set ${++seq}`])).rows[0].id
  const slotFor = (resourceId: string, dayOff = 4) => {
    const s = new Date()
    s.setUTCDate(s.getUTCDate() + dayOff)
    s.setUTCHours(4, 0, 0, 0)
    return { resourceId, startsAt: s.toISOString(), endsAt: new Date(s.getTime() + 2 * 3_600_000).toISOString() }
  }
  type W = ReturnType<typeof slotFor>
  const book = async (w: W, extra: Record<string, unknown> = {}) => {
    publicCtx()
    return createPublicBooking({ ...w, customerName: 'QA', customerPhone: nextPhone(), website: '', ...extra } as never)
  }
  const row = async (id: string) =>
    (await q<{ status: string; review: boolean; reason: string | null; hold: Date | null; active: boolean }>(
      `select b.status, b.deposit_review_required review, b.cancellation_reason reason, b.payment_hold_expires_at hold, (select bool_and(active) from booking_slots where booking_id=b.id) as active from bookings b where b.id=$1`,
      [id],
    )).rows[0]
  const expire = (id: string) => q(`update bookings set payment_hold_expires_at = now() - interval '1 minute' where id=$1`, [id])
  const auditCount = async (id: string, action: string) =>
    Number((await q<{ n: string }>(`select count(*) n from audit_log where entity_id=$1 and action=$2`, [id, action])).rows[0].n)
  const notifCount = async (id: string, kind: string) =>
    Number((await q<{ n: string }>(`select count(*) n from notifications n join bookings b on b.customer_phone = n.recipient_phone where b.id=$1 and n.kind=$2`, [id, kind])).rows[0].n)

  const startIntent = async (bookingId: string) => {
    let orderId = ''
    const co = await createBookingPaymentIntent(
      { bookingId },
      {
        runInTx: (fn) => withPublicTenant(tenantId, fn),
        credentials: { keyId: 'k', keySecret: 's' } as never,
        createOrder: async (_c, o) => {
          orderId = `order_HR${randomBytes(6).toString('hex')}`
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
  const paidIntents = async (id: string) =>
    Number((await q<{ n: string }>(`select count(*) n from payment_intents where booking_id=$1 and status='paid'`, [id])).rows[0].n)

  // ══ release ═══════════════════════════════════════════════════════════════
  console.log('\n── release ──')
  const cam = await mkAddon(1)
  const resA = await mkRes()
  const wA = slotFor(resA)
  const a = await book(wA, { addons: [{ addonId: cam, quantity: 1 }] })
  check('advance booking with the only camera is pending', (await row(a.bookingId!)).status === 'pending_payment', a)
  const blocked = await book(slotFor(await mkRes()), { addons: [{ addonId: cam, quantity: 1 }] })
  check('…and the camera is held: a second booking cannot take it', Boolean(blocked.error), blocked)

  // an unexpired hold, a confirmed legacy booking and a venue booking must survive the sweep
  const keepPending = await book(slotFor(await mkRes()))
  await seedRazorpay((t, p) => owner.query(t, p), tenantId, 'venue')
  const keepVenue = await book(slotFor(await mkRes()))
  await seedRazorpay((t, p) => owner.query(t, p), tenantId, 'optional_full')
  const keepLegacy = await book(slotFor(await mkRes()), { payNow: true })
  await seedRazorpay((t, p) => owner.query(t, p), tenantId, 'advance', { type: 'percent', value: 40 })
  await q(`update payment_settings set razorpay_webhook_secret_encrypted=$2 where tenant_id=$1`, [tenantId, encryptSecret(WEBHOOK_SECRET, tenantId)])

  const early = await releaseExpiredHolds({ tenantId })
  check('sweep before expiry releases nothing', early.released === 0, early)
  await expire(a.bookingId!)
  const sweep = await releaseExpiredHolds({ tenantId })
  const ra = await row(a.bookingId!)
  check('sweep releases exactly the expired hold', sweep.released === 1 && ra.status === 'cancelled' && ra.reason === 'Payment not completed', { sweep, ra })
  check('…audited, no refund review (nothing was paid), slot inactive', (await auditCount(a.bookingId!, 'booking.payment_hold_released')) === 1 && ra.review === false && ra.active === false, ra)
  check('…unexpired pending, venue and legacy bookings are untouched', (await row(keepPending.bookingId!)).status === 'pending_payment' && (await row(keepVenue.bookingId!)).status === 'confirmed' && (await row(keepLegacy.bookingId!)).status === 'confirmed')
  const again = await releaseExpiredHolds({ tenantId })
  check('sweep is idempotent', again.released === 0 && (await auditCount(a.bookingId!, 'booking.payment_hold_released')) === 1, again)
  const rebook = await book(wA, { addons: [{ addonId: cam, quantity: 1 }] })
  check('another customer can immediately book the slot AND the camera is back in stock', Boolean(rebook.bookingId) && !rebook.error, rebook)

  // on demand: no sweep call, the public action releases the expired hold itself
  const resB = await mkRes()
  const wB = slotFor(resB, 5)
  const b = await book(wB)
  await expire(b.bookingId!)
  const onDemand = await book(wB)
  check('on-demand: an expired hold never blocks a real customer, even before the sweep runs', Boolean(onDemand.bookingId) && (await row(b.bookingId!)).status === 'cancelled', onDemand)

  // ══ late payment: slot free ═══════════════════════════════════════════════
  console.log('\n── late payment, slot free ──')
  const wC = slotFor(await mkRes(), 6)
  const c = await book(wC)
  const ic = await startIntent(c.bookingId!)
  await expire(c.bookingId!)
  await releaseExpiredHolds({ tenantId })
  check('hold released before the customer paid', (await row(c.bookingId!)).status === 'cancelled')
  const lc = await deliver(ic.orderId, 'pay_HR1' + tag, ic.amountPaise, 'evt_hr1_' + tag)
  const rc = await row(c.bookingId!)
  check('late payment, slot free: booking re-confirmed and slots active again', lc.body.status === 'processed' && rc.status === 'confirmed' && rc.active === true && rc.review === false && rc.reason === null && rc.hold === null, { lc, rc })
  check('…audited, customer told once', (await auditCount(c.bookingId!, 'booking.reinstated_after_late_payment')) === 1 && (await notifCount(c.bookingId!, 'booking_confirmed')) === 1)
  await deliver(ic.orderId, 'pay_HR1' + tag, ic.amountPaise, 'evt_hr1_' + tag)
  await deliver(ic.orderId, 'pay_HR1' + tag, ic.amountPaise, 'evt_hr1b_' + tag)
  check('redeliveries change nothing and send nothing', (await notifCount(c.bookingId!, 'booking_confirmed')) === 1 && (await paidIntents(c.bookingId!)) === 1 && (await row(c.bookingId!)).status === 'confirmed')

  // ══ late payment: slot taken ══════════════════════════════════════════════
  console.log('\n── late payment, slot taken ──')
  const wD = slotFor(await mkRes(), 7)
  const d = await book(wD)
  const id_ = await startIntent(d.bookingId!)
  await expire(d.bookingId!)
  await releaseExpiredHolds({ tenantId })
  const taker = await book(wD)
  check('someone else takes the freed slot', Boolean(taker.bookingId), taker)
  const ld = await deliver(id_.orderId, 'pay_HR2' + tag, id_.amountPaise, 'evt_hr2_' + tag)
  const rd = await row(d.bookingId!)
  check('late payment, slot taken: stays cancelled and flagged for refund', ld.body.status === 'processed' && rd.status === 'cancelled' && rd.review === true, { ld, rd })
  check('…the payment is recorded (intent paid) and the taker is undisturbed', (await paidIntents(d.bookingId!)) === 1 && (await row(taker.bookingId!)).status === 'pending_payment')
  check('…audited and the customer told a refund will follow, once', (await auditCount(d.bookingId!, 'booking.paid_after_release')) === 1 && (await notifCount(d.bookingId!, 'booking_refund_pending')) === 1)
  const revenue = Number((await q<{ n: string }>(`select count(*) n from payments where tenant_id=$1`, [tenantId])).rows[0].n)
  check('no phantom revenue: no payments row was created for any of it', revenue === 0, revenue)
  const flagged = await q<{ id: string }>(`select id from bookings where tenant_id=$1 and deposit_review_required and status='cancelled'`, [tenantId])
  check('staff can find it: exactly this booking carries the refund flag', flagged.rows.length === 1 && flagged.rows[0].id === d.bookingId, flagged.rows)

  // ══ late payment: add-on stock gone ═══════════════════════════════════════
  console.log('\n── late payment, add-on stock gone ──')
  const cam2 = await mkAddon(1)
  const wE = slotFor(await mkRes(), 8)
  const e = await book(wE, { addons: [{ addonId: cam2, quantity: 1 }] })
  const ie = await startIntent(e.bookingId!)
  await expire(e.bookingId!)
  await releaseExpiredHolds({ tenantId })
  const eTaker = await book(slotFor(await mkRes(), 8), { addons: [{ addonId: cam2, quantity: 1 }] })
  check('the camera is taken by someone on another set', Boolean(eTaker.bookingId), eTaker)
  const le = await deliver(ie.orderId, 'pay_HR3' + tag, ie.amountPaise, 'evt_hr3_' + tag)
  const re = await row(e.bookingId!)
  check('add-on stock gone: stays cancelled and flagged, money recorded', le.body.status === 'processed' && re.status === 'cancelled' && re.review === true && (await paidIntents(e.bookingId!)) === 1, { le, re })

  // ══ late payment: staff had cancelled it ══════════════════════════════════
  console.log('\n── late payment after a staff cancel ──')
  const wF = slotFor(await mkRes(), 9)
  const f = await book(wF)
  const iff = await startIntent(f.bookingId!)
  g.__ARENA_TEST_SESSION = staffToken
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
  await setBookingStatus(f.bookingId!, 'cancelled', 'customer called')
  const lf = await deliver(iff.orderId, 'pay_HR4' + tag, iff.amountPaise, 'evt_hr4_' + tag)
  const rf = await row(f.bookingId!)
  check('staff-cancelled then paid: never silently re-confirmed, flagged for refund', lf.body.status === 'processed' && rf.status === 'cancelled' && rf.review === true, { lf, rf })

  // ══ race: sweep and webhook together ══════════════════════════════════════
  console.log('\n── sweep vs webhook race ──')
  let coherent = 0
  const N = 6
  for (let i = 0; i < N; i++) {
    const w = slotFor(await mkRes(), 10 + i)
    const bk = await book(w)
    const it = await startIntent(bk.bookingId!)
    await expire(bk.bookingId!)
    const [, hook] = await Promise.all([releaseExpiredHolds({ tenantId }), deliver(it.orderId, `pay_RACE${i}${tag}`, it.amountPaise, `evt_race${i}_${tag}`)])
    const r = await row(bk.bookingId!)
    const released = await auditCount(bk.bookingId!, 'booking.payment_hold_released')
    const reinstated = await auditCount(bk.bookingId!, 'booking.reinstated_after_late_payment')
    const ok =
      hook.status === 200 &&
      r.status === 'confirmed' &&
      r.active === true &&
      (await paidIntents(bk.bookingId!)) === 1 &&
      released <= 1 &&
      // exactly one story: webhook won outright, or sweep won and the webhook reinstated
      ((released === 0 && reinstated === 0) || (released === 1 && reinstated === 1))
    if (ok) coherent++
    else console.log('   race detail', { i, hook, r, released, reinstated })
  }
  check(`all ${N} simultaneous sweep/webhook runs ended in one coherent outcome (paid booking confirmed once)`, coherent === N, coherent)

  await q('delete from tenants where id=$1', [tenantId])
  await q(`delete from users where email=$1`, [`hold-${tag}@example.test`])
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
