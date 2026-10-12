/**
 * Staff cancel of a booking holding a PAID ONLINE DEPOSIT.
 *
 * setBookingStatus('cancelled') used to raise deposit_review_required only for
 * a gaming-cafe cash advance, and wrote `cancelled` without locking the row —
 * so (1) a staff-cancelled advance/full-paid online booking left no refund
 * marker, and (2) a cancel that read the status before the Razorpay webhook
 * confirmed the booking overwrote `confirmed`, leaving a paid intent, a
 * cancelled booking and no flag. Now the cancel takes the webhook's row lock,
 * re-reads under it, and flags any paid booking_deposit intent.
 *
 *   flag      paid booking_deposit -> flagged, for every role that can cancel
 *   no flag   no intent / pending intent / paid order_payment intent
 *   idempotent  re-cancel changes nothing (reason, cancelled_at, flag)
 *   race      cancel blocks behind a held row lock, then sees the committed
 *             confirm + paid intent and flags; mirror: staff first, then the
 *             real webhook takes the late-payment path (flag, one paid intent)
 *   pending   cancelling an unpaid pending_payment hold frees the slot, no flag
 *   cash      gaming-cafe cash-advance flagging unchanged
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-staff-cancel-paid-deposit.ts
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../app/api/webhooks/razorpay/route')
  const { createBooking, setBookingStatus } = await import('../lib/actions/bookings')
  const { createPublicBooking } = await import('../lib/actions/public-booking')
  const { createBookingPaymentIntent } = await import('../lib/payments/booking-payment')
  const { withPublicTenant } = await import('../db')
  const { encryptSecret } = await import('../lib/security/encryption')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const tag = randomBytes(3).toString('hex')
  const digits = Number(String(randomInt(0, 1_000_000_000)).padStart(9, '0'))
  let phoneSeq = 0
  const nextPhone = () => `9${String(digits + ++phoneSeq).padStart(9, '0')}`
  const ROOT = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000').split(':')[0]
  const g = globalThis as { __ARENA_TEST_HEADERS?: Record<string, string>; __ARENA_TEST_SESSION?: string }

  async function makeTenant(industry: 'recording_studio' | 'gaming_cafe') {
    const slug = `cancel-paid-${industry === 'gaming_cafe' ? 'gc' : 'rs'}-${tag}`
    const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata',$3) returning id`, [slug, `${slug} co`, industry])).rows[0].id
    const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`, [tenantId])).rows[0].id
    const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','500.00') returning id`, [tenantId])).rows[0].id
    for (let dow = 0; dow <= 6; dow++) {
      await q(`insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed) values ($1,$2,$3,'09:00','22:00',false)`, [tenantId, branchId, dow])
    }
    const resourceId = (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set 1','available') returning id`, [tenantId, branchId, typeId])).rows[0].id
    const tokens: Record<string, string> = {}
    for (const role of ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff']) {
      const uid = (await q<{ id: string }>(`insert into users (email,password_hash,full_name) values ($1,'x',$2) returning id`, [`${role}-${industry}-${tag}@example.test`, role])).rows[0].id
      await q(`insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,$4::member_role,'active',$5)`, [tenantId, uid, branchId, role, role])
      const token = randomBytes(32).toString('hex')
      await q(`insert into sessions (id,user_id,expires_at) values ($1,$2,now()+interval '1 day')`, [createHash('sha256').update(token).digest('hex'), uid])
      tokens[role] = token
    }
    return { tenantId, slug, branchId, typeId, resourceId, tokens }
  }
  const T = await makeTenant('recording_studio')
  const G = await makeTenant('gaming_cafe')
  const WEBHOOK_SECRET = `whsec_${randomBytes(12).toString('hex')}`
  await seedRazorpay((t, p) => owner.query(t, p), T.tenantId, 'advance', { type: 'percent', value: 40 })
  await q(`update payment_settings set razorpay_webhook_secret_encrypted=$2 where tenant_id=$1`, [T.tenantId, encryptSecret(WEBHOOK_SECRET, T.tenantId)])

  const as = (t: typeof T, role: string) => {
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': t.slug }
    g.__ARENA_TEST_SESSION = t.tokens[role]
  }
  let dayOff = 3
  const nextWindow = () => {
    const s = new Date()
    s.setUTCDate(s.getUTCDate() + ++dayOff)
    s.setUTCHours(6, 0, 0, 0)
    return { startsAt: s.toISOString(), endsAt: new Date(s.getTime() + 3_600_000).toISOString() }
  }
  // A staff-created confirmed booking (stands in for a webhook-confirmed online one).
  async function mkBooking(t: typeof T, advance = 0) {
    as(t, 'owner')
    const r = await createBooking({
      branchId: t.branchId,
      customerName: 'QA',
      customerPhone: nextPhone(),
      source: 'staff',
      advanceTenders: advance > 0 ? [{ method: 'cash', amount: advance }] : [],
      slots: [{ resourceId: t.resourceId, ...nextWindow() }],
    })
    if (!r.bookingId) throw new Error(`createBooking failed: ${r.error}`)
    return r.bookingId
  }
  let intentSeq = 0
  const addIntent = (t: typeof T, bookingId: string, status: 'paid' | 'pending') =>
    q(
      `insert into payment_intents (tenant_id,branch_id,booking_id,purpose,gateway_order_id,gateway_payment_id,amount,status)
       values ($1,$2,$3,'booking_deposit',$4,$5,'200.00',$6)`,
      [t.tenantId, t.branchId, bookingId, `order_SC${tag}${++intentSeq}`, status === 'paid' ? `pay_SC${tag}${intentSeq}` : null, status],
    )
  const row = async (id: string) =>
    (await q<{ status: string; review: boolean; reason: string | null; cancelled_at: Date | null; active: boolean | null }>(
      `select b.status, b.deposit_review_required review, b.cancellation_reason reason, b.cancelled_at,
              (select bool_or(active) from booking_slots where booking_id=b.id) as active from bookings b where b.id=$1`,
      [id],
    )).rows[0]
  const audits = async (id: string) =>
    Number((await q<{ n: string }>(`select count(*) n from audit_log where entity_id=$1 and entity_type='booking' and action like '%cancel%'`, [id])).rows[0].n)

  // ══ 1. paid deposit -> flagged, for every role ═══════════════════════════
  console.log('\n── paid booking_deposit: flagged, any role ──')
  for (const role of ['manager', 'cashier', 'receptionist', 'floor_staff', 'owner']) {
    const id = await mkBooking(T)
    await addIntent(T, id, 'paid')
    as(T, role)
    const r = await setBookingStatus(id, 'cancelled', 'Customer asked')
    const b = await row(id)
    check(`${role}: cancel succeeds`, !r.error, r.error)
    check(`${role}: cancelled with reason + timestamp`, b.status === 'cancelled' && b.reason === 'Customer asked' && b.cancelled_at !== null, b)
    check(`${role}: refund flag raised`, b.review === true, b.review)
    check(`${role}: slot freed`, b.active === false, b.active)
  }

  // ══ 2-4. nothing paid for the booking -> no flag ═════════════════════════
  console.log('\n── no paid deposit: not flagged ──')
  {
    const id = await mkBooking(T)
    as(T, 'manager')
    await setBookingStatus(id, 'cancelled', 'x')
    check('no intent: flag stays false', (await row(id)).review === false)
  }
  {
    const id = await mkBooking(T)
    await addIntent(T, id, 'pending')
    as(T, 'manager')
    await setBookingStatus(id, 'cancelled', 'x')
    check('pending (unpaid) intent: flag stays false', (await row(id)).review === false)
  }
  {
    const id = await mkBooking(T)
    // A paid intent of the other purpose pointing at this booking row (the
    // schema allows the shape): only booking_deposit money is a booking refund.
    await q(
      `insert into payment_intents (tenant_id,branch_id,booking_id,purpose,gateway_order_id,gateway_payment_id,amount,status)
       values ($1,$2,$3,'order_payment',$4,$5,'50.00','paid')`,
      [T.tenantId, T.branchId, id, `order_OP${tag}`, `pay_OP${tag}`],
    )
    as(T, 'manager')
    await setBookingStatus(id, 'cancelled', 'x')
    const flagged = (await row(id)).review
    check('paid order_payment-purpose intent does not flag', flagged === false, flagged)
  }

  // ══ idempotent re-cancel ═════════════════════════════════════════════════
  console.log('\n── re-cancel is a no-op ──')
  {
    const id = await mkBooking(T)
    await addIntent(T, id, 'paid')
    as(T, 'manager')
    await setBookingStatus(id, 'cancelled', 'first reason')
    const first = await row(id)
    await sleep(15)
    const again = await setBookingStatus(id, 'cancelled', 'second reason')
    const second = await row(id)
    check('second cancel returns no error', !again.error, again.error)
    check('reason and cancelled_at keep the first values', second.reason === 'first reason' && String(second.cancelled_at) === String(first.cancelled_at), second)
    check('flag still raised', second.review === true)
    check('no second cancel audit row', (await audits(id)) <= 1, await audits(id))
  }

  // ══ 5. race: cancel vs the webhook's row lock ════════════════════════════
  console.log('\n── race: cancel waits for the webhook lock ──')
  {
    const id = await mkBooking(T)
    // Make it look like an unpaid online hold, as the public flow leaves it.
    await q(`update bookings set status='pending_payment', payment_hold_expires_at = now() + interval '20 minutes' where id=$1`, [id])
    const holder = await owner.connect()
    try {
      await holder.query('begin')
      await holder.query('select id from bookings where id=$1 for update', [id]) // what the webhook does
      as(T, 'cashier')
      let settled = false
      const pending = setBookingStatus(id, 'cancelled', 'Staff cancel').then((r) => ((settled = true), r))
      await sleep(900)
      check('cancel BLOCKS while the webhook holds the row', settled === false)
      // webhook commits: confirm + paid intent
      await holder.query(`update bookings set status='confirmed', payment_hold_expires_at=null where id=$1`, [id])
      await holder.query(
        `insert into payment_intents (tenant_id,branch_id,booking_id,purpose,gateway_order_id,gateway_payment_id,amount,status)
         values ($1,$2,$3,'booking_deposit',$4,$5,'200.00','paid')`,
        [T.tenantId, T.branchId, id, `order_RC${tag}`, `pay_RC${tag}`],
      )
      await holder.query('commit')
      const r = await pending
      const b = await row(id)
      check('cancel then succeeds', !r.error, r.error)
      check('ends cancelled WITH the refund flag (saw the committed paid intent)', b.status === 'cancelled' && b.review === true, b)
    } finally {
      holder.release()
    }
  }
  console.log('\n── mirror: staff first, then the real webhook ──')
  {
    const slug = T.slug
    g.__ARENA_TEST_SESSION = undefined
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug, 'x-forwarded-for': `10.7.${tag.charCodeAt(0)}.1` }
    const w = nextWindow()
    const pb = await createPublicBooking({ resourceId: T.resourceId, ...w, customerName: 'QA', customerPhone: nextPhone(), website: '' } as never)
    const id = pb.bookingId!
    check('public advance booking is pending_payment', (await row(id)).status === 'pending_payment', pb)
    let orderId = ''
    const co = await createBookingPaymentIntent(
      { bookingId: id },
      {
        runInTx: (fn) => withPublicTenant(T.tenantId, fn),
        credentials: { keyId: 'k', keySecret: 's' } as never,
        createOrder: async (_c, o) => {
          orderId = `order_SC${randomBytes(6).toString('hex')}`
          return { id: orderId, amount: o.amountPaise, currency: 'INR', status: 'created', receipt: o.receipt ?? null }
        },
        actor: { tenantId: T.tenantId },
      },
    )
    as(T, 'receptionist')
    const r = await setBookingStatus(id, 'cancelled', 'Staff first')
    check('staff cancel of the unpaid hold succeeds', !r.error, r.error)
    const mid = await row(id)
    check('unpaid pending_payment cancel: slot freed, no flag', mid.status === 'cancelled' && mid.active === false && mid.review === false, mid)
    const raw = JSON.stringify({ entity: 'event', event: 'payment.captured', contains: ['payment'], payload: { payment: { entity: { id: `pay_MR${tag}`, entity: 'payment', amount: co.amount, currency: 'INR', status: 'captured', order_id: orderId, method: 'upi' } } }, created_at: 1755500000 })
    const res = await POST(
      new NextRequest(`https://${slug}.${ROOT}/api/webhooks/razorpay`, {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json', 'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw, 'utf8').digest('hex'), 'x-razorpay-event-id': `evt_${tag}_mr`, host: `${slug}.${ROOT}` }),
        body: raw,
      }),
    )
    const b = await row(id)
    const paid = Number((await q<{ n: string }>(`select count(*) n from payment_intents where booking_id=$1 and status='paid'`, [id])).rows[0].n)
    check('webhook accepted', res.status === 200, res.status)
    check('late payment: stays cancelled, refund flag raised, one paid intent', b.status === 'cancelled' && b.review === true && paid === 1, { b, paid })
  }

  // ══ 7. gaming-cafe cash advance unchanged ════════════════════════════════
  console.log('\n── gaming_cafe cash advance still flags ──')
  {
    const id = await mkBooking(G, 300)
    as(G, 'cashier')
    await setBookingStatus(id, 'cancelled', 'x')
    check('unconsumed cash advance flags', (await row(id)).review === true)
    const id2 = await mkBooking(G, 0)
    as(G, 'cashier')
    await setBookingStatus(id2, 'cancelled', 'x')
    check('no advance, no deposit: no flag', (await row(id2)).review === false)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
