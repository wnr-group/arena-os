/**
 * M36 #7 — adversarial + reconciliation QA for online booking payment,
 * through the real actions, the real signed webhook and the real billing code.
 *
 *   race          two customers hitting one slot at the same instant: one wins
 *   tampering     payNow:false / injected amounts / mode override / replay
 *   reconcile     tax 18% + add-ons + an odd 33.33% advance: advance paid online +
 *                 the POS remainder == the final invoice total, to the paisa
 *   db guard      the credentials CHECK stops advance/full without a secret even
 *                 when written out-of-band
 *   notify        exactly one customer message after payment; none for a hold
 *                 that was released unpaid
 *   reports       pending-payment holds are not counted by booking metrics or
 *                 occupancy; the paid advance exists as exactly one payment row
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-m36-qa.ts
 */
import { createHmac, randomBytes, randomInt } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'
import { seedRazorpay } from './seed-razorpay'
import { entitleTenant } from './entitle-fixture'

loadEnv()
type Db = NodePgDatabase<typeof schema>
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
  const { createPublicBooking, createBookingPaymentIntentByToken, createBookingPaymentIntent: createIntentAction } =
    await import('../lib/actions/public-booking')
  const { createBookingPaymentIntent } = await import('../lib/payments/booking-payment')
  const { releaseExpiredHolds } = await import('../lib/booking/payment-hold')
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { getInvoiceSettlement, recordPaymentForInvoice } = await import('../lib/billing/payments')
  const { getBookingMetrics } = await import('../lib/reports/bookings')
  const { withPublicTenant } = await import('../db')
  const { encryptSecret } = await import('../lib/security/encryption')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  const app = drizzle(appPool, { schema })
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const withUser = <T,>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })

  const tag = randomBytes(3).toString('hex')
  const digits = Number(String(randomInt(0, 1_000_000_000)).padStart(9, '0'))
  let phoneSeq = 0
  const nextPhone = () => `9${String(digits + ++phoneSeq).padStart(9, '0')}`
  const slug = `m36-qa-${tag}`
  const ROOT = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000').split(':')[0]
  const g = globalThis as { __ARENA_TEST_HEADERS?: Record<string, string>; __ARENA_TEST_SESSION?: string }
  let ipSeq = 0
  const publicCtx = () => {
    g.__ARENA_TEST_SESSION = undefined
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug, 'x-forwarded-for': `10.5.${tag.charCodeAt(0)}.${++ipSeq}` }
  }

  const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,'M36 QA','active','Asia/Kolkata','recording_studio') returning id`, [slug])).rows[0].id
  const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`, [tenantId])).rows[0].id
  const taxId = (await q<{ id: string }>(`insert into tax_rates (tenant_id,name,percent,applies_to) values ($1,'GST18',18,'resources') returning id`, [tenantId])).rows[0].id
  const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate,tax_rate_id) values ($1,'Studio','500.00',$2) returning id`, [tenantId, taxId])).rows[0].id
  await entitleTenant(owner, tenantId)
  for (let dow = 0; dow <= 6; dow++) {
    await q(`insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed) values ($1,$2,$3,'09:00','22:00',false)`, [tenantId, branchId, dow])
  }
  const userId = (await q<{ id: string }>(`insert into users (email,password_hash,full_name) values ($1,'x','Owner') returning id`, [`m36-${tag}@example.test`])).rows[0].id
  const membershipId = (await q<{ id: string }>(`insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'owner','active','Owner') returning id`, [tenantId, userId, branchId])).rows[0].id
  const WEBHOOK_SECRET = `whsec_${randomBytes(12).toString('hex')}`
  const setMode = async (mode: string, adv?: { type: 'fixed' | 'percent'; value: number }) => {
    await seedRazorpay((t, p) => owner.query(t, p), tenantId, mode as never, adv)
    await q(`update payment_settings set razorpay_webhook_secret_encrypted=$2 where tenant_id=$1`, [tenantId, encryptSecret(WEBHOOK_SECRET, tenantId)])
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
  type W = ReturnType<typeof slotFor>
  const book = async (w: W, extra: Record<string, unknown> = {}) => {
    publicCtx()
    return createPublicBooking({ ...w, customerName: 'QA', customerPhone: nextPhone(), website: '', ...extra } as never)
  }
  const row = async (id: string) =>
    (await q<{ status: string; deposit: string; total: string }>(`select status, deposit, total from bookings where id=$1`, [id])).rows[0]
  const startIntent = async (bookingId: string) => {
    let orderId = ''
    const co = await createBookingPaymentIntent(
      { bookingId },
      {
        runInTx: (fn) => withPublicTenant(tenantId, fn),
        credentials: { keyId: 'k', keySecret: 's' } as never,
        createOrder: async (_c, o) => {
          orderId = `order_QA${randomBytes(6).toString('hex')}`
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
    return (await POST(req)).json() as Promise<{ status?: string }>
  }
  const notifications = async (bookingId: string) =>
    Number((await q<{ n: string }>(`select count(*) n from notifications n join bookings b on b.customer_phone = n.recipient_phone and b.tenant_id = n.tenant_id where b.id=$1`, [bookingId])).rows[0].n)

  // ══ race ══════════════════════════════════════════════════════════════════
  console.log('\n── two customers, one slot, same instant ──')
  await setMode('full')
  const wRace = slotFor(await mkRes())
  const [r1, r2] = await Promise.all([book(wRace), book(wRace)])
  const winners = [r1, r2].filter((r) => r.bookingId)
  const losers = [r1, r2].filter((r) => r.error)
  check('exactly one booking wins and the other is told the time was taken', winners.length === 1 && losers.length === 1 && /just taken/i.test(losers[0].error ?? ''), [r1, r2])
  const rows = Number((await q<{ n: string }>(`select count(*) n from booking_slots where resource_id=$1 and active`, [wRace.resourceId])).rows[0].n)
  check('…and the database holds one active slot for it', rows === 1, rows)

  // ══ tampering ═════════════════════════════════════════════════════════════
  console.log('\n── tampering with the storefront call ──')
  await setMode('advance', { type: 'percent', value: 25 })
  const wT = slotFor(await mkRes(), 5)
  const t1 = await book(wT, { payNow: false, mode: 'venue', paymentMode: 'venue', onlinePaymentMode: 'venue', deposit: 0, amount: 1, chargeNow: 0, balanceDue: 99999, advanceValue: 1, status: 'confirmed', total: 1 })
  const bt = await row(t1.bookingId!)
  check('payNow:false + mode/amount/status overrides: still pending and charged the 25% advance', bt.status === 'pending_payment' && bt.deposit === '250.00' && t1.awaitingOnlinePayment === true, { t1, bt })
  const replay = await book(wT, { payNow: false })
  check('replaying the same booking call cannot create a second booking or a cheaper one', Boolean(replay.error) && Number((await q<{ n: string }>(`select count(*) n from bookings where tenant_id=$1 and status in ('pending_payment','confirmed') and id in (select booking_id from booking_slots where resource_id=$2)`, [tenantId, wT.resourceId])).rows[0].n) === 1, replay)
  await setMode('venue')
  const wV = slotFor(await mkRes(), 5)
  const tv = await book(wV, { payNow: true, deposit: 5000 })
  check('venue mode: a crafted payNow:true / deposit never creates a charge', (await row(tv.bookingId!)).deposit === '0.00' && tv.awaitingOnlinePayment === false, tv)

  // ══ db guard ══════════════════════════════════════════════════════════════
  console.log('\n── Razorpay credentials guard ──')
  await setMode('full')
  const clear = await owner.query(`update payment_settings set razorpay_key_secret_encrypted=null where tenant_id=$1`, [tenantId]).then(() => 'ok', (e) => String(e.code))
  check('out-of-band removal of the secret while mode=full is refused by the DB (23514)', clear === '23514', clear)
  await setMode('venue')

  // ══ reconciliation ════════════════════════════════════════════════════════
  console.log('\n── advance + POS remainder == invoice total (tax 18%, add-on, 33.33%) ──')
  const cam = (await q<{ id: string }>(`insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity,is_active) values ($1,$2,$3,'Cam','333.00','hour',5,true) returning id`, [tenantId, branchId, typeId])).rows[0].id
  for (const [label, pct, addon] of [['33.33% with tax', 33.33, false], ['33.33% with tax + add-on', 33.33, true], ['7% with tax + add-on', 7, true]] as const) {
    await setMode('advance', { type: 'percent', value: pct })
    const w = slotFor(await mkRes(), 6 + seq)
    const b = await book(w, addon ? { addons: [{ addonId: cam, quantity: 2 }] } : {})
    const before = await row(b.bookingId!)
    const it = await startIntent(b.bookingId!)
    check(`${label}: Razorpay amount == bookings.deposit (paise)`, it.amountPaise === Math.round(Number(before.deposit) * 100), { it, before })
    const hook = await deliver(it.orderId, `pay_QA${seq}${tag}`, it.amountPaise, `evt_qa${seq}_${tag}`)
    check(`${label}: webhook confirms the held booking`, hook.status === 'processed' && (await row(b.bookingId!)).status === 'confirmed', hook)
    const inv = await withUser(userId, (tx) => issueInvoiceForBooking(tx, { id: tenantId, timezone: 'Asia/Kolkata' }, { bookingId: b.bookingId! }))
    let s = (await withUser(userId, (tx) => getInvoiceSettlement(tx, tenantId, inv.invoiceId)))!
    const depositPaise = Math.round(Number(before.deposit) * 100)
    check(`${label}: the invoice carries exactly the deposit as an online payment`, Math.round(s.paid * 100) === depositPaise && s.payments[0]?.method === 'online', s)
    check(`${label}: invoice total is above the pre-tax booking total (tax applied)`, s.total > Number(before.total), { total: s.total, pre: before.total })
    check(`${label}: advance + balance == invoice total, to the paisa`, depositPaise + Math.round(s.balance * 100) === Math.round(s.total * 100), s)
    const tender = await withUser(userId, (tx) => recordPaymentForInvoice(tx, { tenantId, membershipId }, { invoiceId: inv.invoiceId, method: 'cash', amount: s.balance }))
    s = (await withUser(userId, (tx) => getInvoiceSettlement(tx, tenantId, inv.invoiceId)))!
    check(`${label}: paying the remainder settles the bill exactly`, tender.settled === true && s.balance === 0 && s.status === 'paid', { tender, s })
    const payRows = Number((await q<{ n: string }>(`select count(*) n from payments where invoice_id=$1 and gateway_payment_id is not null`, [inv.invoiceId])).rows[0].n)
    check(`${label}: the advance is on the books exactly once`, payRows === 1, payRows)
  }

  // ══ notifications ═════════════════════════════════════════════════════════
  console.log('\n── notifications ──')
  await setMode('advance', { type: 'percent', value: 50 })
  const wN = slotFor(await mkRes(), 30)
  const n1 = await book(wN)
  const nInt = await startIntent(n1.bookingId!)
  check('no customer message while the booking is only held', (await notifications(n1.bookingId!)) === 0)
  await deliver(nInt.orderId, `pay_N${tag}`, nInt.amountPaise, `evt_n_${tag}`)
  const sent = await q<{ message_body: string }>(`select n.message_body from notifications n join bookings b on b.customer_phone = n.recipient_phone and b.tenant_id=n.tenant_id where b.id=$1`, [n1.bookingId])
  check('exactly one message after payment, and it states the balance due', sent.rows.length === 1 && /confirmed/i.test(sent.rows[0].message_body) && /Balance of .* [(]before tax[)] is due at the venue/.test(sent.rows[0].message_body), sent.rows)
  await deliver(nInt.orderId, `pay_N${tag}`, nInt.amountPaise, `evt_n2_${tag}`)
  check('a redelivery sends nothing more', (await notifications(n1.bookingId!)) === 1)
  const wN2 = slotFor(await mkRes(), 31)
  const n2 = await book(wN2)
  await q(`update bookings set payment_hold_expires_at = now() - interval '1 minute' where id=$1`, [n2.bookingId])
  await releaseExpiredHolds({ tenantId })
  check('a hold released unpaid sends no message at all', (await row(n2.bookingId!)).status === 'cancelled' && (await notifications(n2.bookingId!)) === 0)

  // ══ already paid ══════════════════════════════════════════════════════════
  console.log('\n── a booking that is already paid online cannot be paid again ──')
  await setMode('full')
  const intentRows = async (bookingId: string) =>
    Number((await q<{ n: string }>(`select count(*) n from payment_intents where booking_id=$1`, [bookingId])).rows[0].n)
  /** createBookingPaymentIntent with a counting gateway, so a refused call is proven to have made no order. */
  const countedIntent = async (bookingId: string) => {
    let orders = 0
    const r = await createBookingPaymentIntent(
      { bookingId },
      {
        runInTx: (fn) => withPublicTenant(tenantId, fn),
        credentials: { keyId: 'k', keySecret: 's' } as never,
        createOrder: async (_c, o) => {
          orders++
          return { id: `order_QA${randomBytes(6).toString('hex')}`, amount: o.amountPaise, currency: 'INR', status: 'created', receipt: o.receipt ?? null }
        },
        actor: { tenantId },
      },
    ).then((checkout) => ({ checkout, error: null as string | null }), (e) => ({ checkout: null, error: e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e) }))
    return { ...r, orders }
  }
  const wP = slotFor(await mkRes(), 50)
  const paidBk = await book(wP)
  const paidInt = await startIntent(paidBk.bookingId!)
  check('a pending intent is reused on a second call and makes no new order', await (async () => {
    const again = await countedIntent(paidBk.bookingId!)
    return again.checkout?.reused === true && again.checkout.orderId === paidInt.orderId && again.orders === 0 && (await intentRows(paidBk.bookingId!)) === 1
  })())
  await deliver(paidInt.orderId, `pay_PD${tag}`, paidInt.amountPaise, `evt_pd_${tag}`)
  check('the webhook confirmed and paid the booking', (await row(paidBk.bookingId!)).status === 'confirmed')
  const again = await countedIntent(paidBk.bookingId!)
  check('createBookingPaymentIntent refuses a paid booking with the customer-safe message', again.error === 'BookingPaymentError: This booking has already been paid.', again)
  check('…no gateway order was created and no intent row was added', again.orders === 0 && (await intentRows(paidBk.bookingId!)) === 1, again)
  const tok = (await q<{ confirmation_token: string }>(`select confirmation_token from bookings where id=$1`, [paidBk.bookingId])).rows[0].confirmation_token
  publicCtx()
  const byTok = await createBookingPaymentIntentByToken({ token: tok })
  check('the by-token retry action returns the clean error, not a generic failure', 'error' in byTok && byTok.error === 'This booking has already been paid.', byTok)
  publicCtx()
  const byId = await createIntentAction({ bookingId: paidBk.bookingId! })
  check('the by-id action returns the same clean error', 'error' in byId && byId.error === 'This booking has already been paid.', byId)
  check('…and still no new intent row', (await intentRows(paidBk.bookingId!)) === 1)

  // Not paid: still payable.
  const wU = slotFor(await mkRes(), 51)
  const unpaid = await book(wU)
  const first = await countedIntent(unpaid.bookingId!)
  check('an unpaid pending_payment booking still gets an intent', first.checkout?.reused === false && first.orders === 1 && (await intentRows(unpaid.bookingId!)) === 1, first)
  const wF = slotFor(await mkRes(), 52)
  const failedBk = await book(wF)
  await startIntent(failedBk.bookingId!)
  await q(`update payment_intents set status='failed' where booking_id=$1`, [failedBk.bookingId])
  const afterFail = await countedIntent(failedBk.bookingId!)
  check('a booking whose only intent failed is still payable (new order)', afterFail.checkout?.reused === false && afterFail.orders === 1 && (await intentRows(failedBk.bookingId!)) === 2, afterFail)
  await q(`update payment_intents set status='cancelled' where booking_id=$1 and status='pending'`, [failedBk.bookingId])
  const afterCancel = await countedIntent(failedBk.bookingId!)
  check('…and so is one whose intents are failed/cancelled', afterCancel.checkout?.reused === false && afterCancel.orders === 1, afterCancel)

  // Race: the webhook pays the booking AFTER the first validation but BEFORE
  // the persist step. The persist-step re-check must refuse with the clean
  // message (not the orphaned-order error), leave the one gateway order inert
  // and write no intent row of its own.
  const wRc = slotFor(await mkRes(), 53)
  const raceBk = await book(wRc)
  let raceOrders = 0
  let raceOrderId = ''
  const errLogs: string[] = []
  const origErr = console.error
  console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(' ')) }
  const raced = await createBookingPaymentIntent(
    { bookingId: raceBk.bookingId! },
    {
      runInTx: (fn) => withPublicTenant(tenantId, fn),
      credentials: { keyId: 'k', keySecret: 's' } as never,
      createOrder: async (_c, o) => {
        raceOrders++
        raceOrderId = `order_QA${randomBytes(6).toString('hex')}`
        // While "creating the order", a parallel request's order is paid by the webhook.
        const other = await startIntent(raceBk.bookingId!)
        await deliver(other.orderId, `pay_RC${tag}`, other.amountPaise, `evt_rc_${tag}`)
        return { id: raceOrderId, amount: o.amountPaise, currency: 'INR', status: 'created', receipt: o.receipt ?? null }
      },
      actor: { tenantId },
    },
  ).then(() => 'resolved', (e) => (e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)))
  console.error = origErr
  check('a payment landing mid-request is refused with the clean already-paid error, not the orphaned one', raced === 'BookingPaymentError: This booking has already been paid.', raced)
  check('…exactly one gateway order was created by the racing call and it was not stored', raceOrders === 1 && (await q(`select 1 from payment_intents where gateway_order_id=$1`, [raceOrderId])).rowCount === 0)
  check('…only the paid intent exists for the booking and the booking is confirmed', (await intentRows(raceBk.bookingId!)) === 1 && (await row(raceBk.bookingId!)).status === 'confirmed')
  check('…the unstored order id is logged exactly once for reconciliation', errLogs.filter((l) => l.includes(raceOrderId)).length === 1, errLogs)

  // A paid intent for a DIFFERENT booking of the same tenant does not block this one.
  const wD = slotFor(await mkRes(), 54)
  const otherBk = await book(wD)
  const unrelated = await countedIntent(otherBk.bookingId!)
  check('a paid intent on another booking of the tenant does not block this booking', unrelated.checkout?.reused === false && unrelated.orders === 1 && (await intentRows(otherBk.bookingId!)) === 1, unrelated)

  // A paid intent of another purpose (order_payment) on the SAME booking does
  // not block a booking deposit — the guard is scoped to booking_deposit.
  const wP2 = slotFor(await mkRes(), 55)
  const opBk = await book(wP2)
  await q(
    `insert into payment_intents (tenant_id,branch_id,booking_id,purpose,gateway_order_id,amount,currency,status)
     values ($1,$2,$3,'order_payment',$4,'1.00','INR','paid')`,
    [tenantId, branchId, opBk.bookingId, `order_QAop${randomBytes(4).toString('hex')}`],
  )
  const afterOp = await countedIntent(opBk.bookingId!)
  check('a paid order_payment intent on the same booking does not block a booking deposit', afterOp.checkout?.reused === false && afterOp.orders === 1 && (await intentRows(opBk.bookingId!)) === 2, afterOp)

  // ══ reports ═══════════════════════════════════════════════════════════════
  console.log('\n── reports ──')
  await setMode('full')
  const wR = slotFor(await mkRes(), 40)
  const pend = await book(wR)
  const day = new Date(wR.startsAt).toISOString().slice(0, 10)
  const ctx = { user: { id: userId }, tenant: { id: tenantId, timezone: 'Asia/Kolkata', slug }, role: 'owner', membershipId, branchId } as never
  const metrics = await getBookingMetrics(ctx, { range: { start: day, end: day } as never, branchId }).catch((e) => ({ error: String(e) }))
  if ('error' in metrics) {
    check('booking metrics could be read for the QA tenant', false, metrics.error)
  } else {
    const dayRow = metrics.daily.find((d) => d.day === day)
    check('a pending-payment hold is not a booking in the report and books no occupancy', (dayRow?.bookings ?? 0) === 0 && (dayRow?.bookedMinutes ?? 0) === 0, dayRow)
    const pIt = await startIntent(pend.bookingId!)
    await deliver(pIt.orderId, `pay_R${tag}`, pIt.amountPaise, `evt_r_${tag}`)
    const after = await getBookingMetrics(ctx, { range: { start: day, end: day } as never, branchId })
    const dayAfter = after.daily.find((d) => d.day === day)
    check('once paid and confirmed it counts once (1 booking, 120 booked minutes)', dayAfter?.bookings === 1 && dayAfter?.bookedMinutes === 120, dayAfter)
  }

  await q('delete from tenants where id=$1', [tenantId])
  await q('delete from users where id=$1', [userId])
  await owner.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
