/**
 * M36 #2 — createPublicBooking / getPublicBookingQuote enforce the venue's
 * online-payment mode server-side. Real actions as arena_app; the owner pool
 * only seeds and inspects.
 *
 *   modes       venue / full / advance (fixed, percent, capped) / legacy
 *   tampering   payNow:false in full mode, payNow:true in venue mode, extra
 *               amount/deposit fields — none change the charge or skip payment
 *   fail closed advance/full with unusable Razorpay credentials -> no booking row
 *   quote       returns the same mode / chargeNow / balanceDue the booking persists
 *   gateway     the Razorpay order amount == bookings.deposit in paise
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-public-booking-payment-modes.ts
 */
import { randomBytes, randomInt } from 'node:crypto'
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
  const { getPublicBookingQuote, createPublicBooking } = await import('../lib/actions/public-booking')
  const { createBookingPaymentIntent } = await import('../lib/payments/booking-payment')
  const { withPublicTenant } = await import('../db')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const tag = randomBytes(3).toString('hex')
  const digits = Number(String(randomInt(0, 1_000_000_000)).padStart(9, '0'))
  let phoneSeq = 0
  const nextPhone = () => `9${String(digits + ++phoneSeq).padStart(9, '0')}`
  const slug = `pay-modes-${tag}`
  const g = globalThis as { __ARENA_TEST_HEADERS?: Record<string, string> }
  let ipSeq = 0
  const freshIp = () => {
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug, 'x-forwarded-for': `10.8.${tag.charCodeAt(0)}.${++ipSeq}` }
  }

  const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,'Pay Modes QA','active','Asia/Kolkata','recording_studio') returning id`, [slug])).rows[0].id
  const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`, [tenantId])).rows[0].id
  const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','500.00') returning id`, [tenantId])).rows[0].id
  const zeroTypeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Free','0.00') returning id`, [tenantId])).rows[0].id
  const mkRes = async (name: string, type = typeId) =>
    (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`, [tenantId, branchId, type, name])).rows[0].id
  for (let dow = 0; dow <= 6; dow++) {
    await q(`insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed) values ($1,$2,$3,'09:00','22:00',false)`, [tenantId, branchId, dow])
  }
  // One resource per scenario so bookings never collide; 2h at ₹500 = ₹1000.
  let seq = 0
  const win = async (type = typeId) => {
    const resourceId = await mkRes(`Set ${++seq}`, type)
    const s = new Date()
    s.setUTCDate(s.getUTCDate() + 3)
    s.setUTCHours(4, 0, 0, 0)
    return { resourceId, startsAt: s.toISOString(), endsAt: new Date(s.getTime() + 2 * 3_600_000).toISOString() }
  }
  const setMode = (mode: string, adv?: { type: 'fixed' | 'percent'; value: number }) =>
    seedRazorpay((t, p) => owner.query(t, p), tenantId, mode as never, adv)
  const book = async (w: Awaited<ReturnType<typeof win>>, extra: Record<string, unknown> = {}) => {
    freshIp()
    return createPublicBooking({ ...w, customerName: 'QA', customerPhone: nextPhone(), website: '', ...extra } as never)
  }
  const dep = async (id: string) =>
    (await q<{ deposit: string; total: string; status: string }>(`select deposit,total,status from bookings where id=$1`, [id])).rows[0]
  const count = async () => Number((await q<{ n: string }>(`select count(*) n from bookings where tenant_id=$1`, [tenantId])).rows[0].n)

  console.log('\n── venue ──')
  await setMode('venue')
  let w = await win()
  let r = await book(w, { payNow: true })
  check('venue + payNow:true: booking confirmed, no payment awaited', Boolean(r.bookingId) && r.awaitingOnlinePayment === false, r)
  check('…deposit 0 and status confirmed', (await dep(r.bookingId!)).deposit === '0.00' && (await dep(r.bookingId!)).status === 'confirmed')
  check('…no payment intent exists', Number((await q<{ n: string }>(`select count(*) n from payment_intents where booking_id=$1`, [r.bookingId])).rows[0].n) === 0)

  console.log('\n── full ──')
  await setMode('full')
  w = await win()
  freshIp()
  const quoteFull = await getPublicBookingQuote(w)
  check('quote (full): mode, chargeNow = total, balance 0, required', quoteFull.mode === 'full' && quoteFull.chargeNow === 1000 && quoteFull.balanceDue === 0 && quoteFull.paymentRequired === true, quoteFull)
  r = await book(w, { payNow: false, deposit: 1, amount: 1, chargeNow: 1, discount: 999 })
  const bf = await dep(r.bookingId!)
  check('full + payNow:false + tampered amount fields: still charges the full 1000.00', r.awaitingOnlinePayment === true && bf.deposit === '1000.00' && bf.total === '1000.00', { r, bf })
  w = await win()
  r = await book(w)
  check('full with no payNow field at all: charged in full', r.awaitingOnlinePayment === true && (await dep(r.bookingId!)).deposit === '1000.00', r)

  console.log('\n── advance ──')
  await setMode('advance', { type: 'percent', value: 25 })
  w = await win()
  freshIp()
  const quoteAdv = await getPublicBookingQuote(w)
  check('quote (25%): chargeNow 250, balance 750', quoteAdv.mode === 'advance' && quoteAdv.chargeNow === 250 && quoteAdv.balanceDue === 750, quoteAdv)
  r = await book(w, { payNow: false })
  check('advance 25%: deposit 250.00, total 1000.00, awaiting payment', r.awaitingOnlinePayment === true && (await dep(r.bookingId!)).deposit === '250.00' && (await dep(r.bookingId!)).total === '1000.00', r)
  let gatewayPaise = -1
  const checkout = await createBookingPaymentIntent(
    { bookingId: r.bookingId! },
    {
      runInTx: (fn) => withPublicTenant(tenantId, fn),
      credentials: { keyId: 'k', keySecret: 's' } as never,
      createOrder: async (_c, o) => {
        gatewayPaise = o.amountPaise
        return { id: 'order_pm', amount: o.amountPaise, currency: 'INR', status: 'created', receipt: o.receipt ?? null }
      },
      actor: { tenantId },
    },
  )
  check('Razorpay order amount == bookings.deposit in paise (25000)', gatewayPaise === 25000 && checkout.amount === 25000, { gatewayPaise, checkout })
  await setMode('advance', { type: 'fixed', value: 400 })
  w = await win()
  r = await book(w)
  check('advance fixed ₹400 of 1000', (await dep(r.bookingId!)).deposit === '400.00', r)
  await setMode('advance', { type: 'fixed', value: 5000 })
  w = await win()
  r = await book(w)
  check('advance fixed ₹5000 on a 1000 booking is capped at 1000', (await dep(r.bookingId!)).deposit === '1000.00', r)
  await setMode('advance', { type: 'percent', value: 33.333 })
  w = await win()
  r = await book(w)
  check('advance 33.33% (value is stored to 2dp) of 1000 = 333.30', (await dep(r.bookingId!)).deposit === '333.30', r)
  await setMode('full')
  w = await win(zeroTypeId)
  r = await book(w)
  check('zero-total booking in full mode: confirmed, nothing to charge', Boolean(r.bookingId) && r.awaitingOnlinePayment === false && (await dep(r.bookingId!)).deposit === '0.00', r)

  console.log('\n── history is not rewritten by later setting changes ──')
  const before = await dep(r.bookingId!)
  await setMode('venue')
  check('changing the venue mode leaves the stored deposit/total alone', JSON.stringify(await dep(r.bookingId!)) === JSON.stringify(before))

  console.log('\n── fail closed ──')
  for (const mode of ['full', 'advance'] as const) {
    await setMode(mode, mode === 'advance' ? { type: 'percent', value: 50 } : undefined)
    // Valid shape, wrong key: exactly what a changed master key looks like.
    await q(`update payment_settings set razorpay_key_secret_encrypted = 'v1:AAAA:BBBB:CCCC' where tenant_id=$1`, [tenantId])
    w = await win()
    const n = await count()
    r = await book(w)
    check(`${mode} with undecryptable credentials: refused, no booking row`, Boolean(r.error) && /not available/i.test(r.error!) && (await count()) === n, r)
  }
  await setMode('optional_full')
  await q(`update payment_settings set razorpay_key_secret_encrypted = 'v1:AAAA:BBBB:CCCC' where tenant_id=$1`, [tenantId])
  w = await win()
  const n0 = await count()
  r = await book(w, { payNow: true })
  check('legacy payNow with unusable credentials: refused rather than creating an unpayable deposit', Boolean(r.error) && (await count()) === n0, r)
  w = await win()
  r = await book(w)
  check('legacy without payNow still books normally with unusable credentials', Boolean(r.bookingId) && r.awaitingOnlinePayment === false, r)

  console.log('\n── legacy optional_full ──')
  await setMode('optional_full')
  w = await win()
  r = await book(w)
  check('no payNow: deposit 0, nothing awaited', r.awaitingOnlinePayment === false && (await dep(r.bookingId!)).deposit === '0.00', r)
  w = await win()
  r = await book(w, { payNow: true })
  check('payNow:true: full total as deposit, payment awaited', r.awaitingOnlinePayment === true && (await dep(r.bookingId!)).deposit === '1000.00', r)
  freshIp()
  const quoteLegacy = await getPublicBookingQuote(await win())
  check('quote (legacy): not required, chargeNow = full if the customer opts in', quoteLegacy.mode === 'optional_full' && quoteLegacy.paymentRequired === false && quoteLegacy.chargeNow === 1000, quoteLegacy)

  await q('delete from tenants where id=$1', [tenantId])
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
