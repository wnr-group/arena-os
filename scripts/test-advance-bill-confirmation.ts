/**
 * M36 #6 — paid advance and balance due, on the POS bill and the customer's
 * confirmation page. Real billing code (issueInvoiceForBooking, the M1
 * settlement calculator, completeBookingIfFullySettled) and the real public
 * confirmation reader.
 *
 *   pos          ₹500 online advance on a ₹4,000 booking: the bill shows ₹500
 *                captured (an online tender) and ₹3,500 due; the advance ALONE
 *                never completes the booking; paying the ₹3,500 does
 *   refund due   a bill smaller than the advance reports the advance as
 *                unapplied (visible on the bill screen's data), not lost
 *   page         /b/[token]: paid + balance == total for venue, advance, full
 *                and an unpaid advance; no gateway ids leave the reader
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-advance-bill-confirmation.ts
 */
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

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
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { getInvoiceSettlement, recordPaymentForInvoice } = await import('../lib/billing/payments')
  const { completeBookingIfFullySettled } = await import('../lib/booking/service')
  const { summarizeOnlineAdvance } = await import('../lib/payments/deposit-settlement')
  const { getBillableForBooking } = await import('../lib/billing/data')
  const { getPublicBookingByToken } = await import('../lib/booking/public-confirmation')

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
  const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,currency) values ($1,'Adv QA','active','Asia/Kolkata','INR') returning id`, [`adv-bill-${tag}`])).rows[0].id
  const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])).rows[0].id
  const userId = (await q<{ id: string }>(`insert into users (email,password_hash) values ($1,'x') returning id`, [`adv-${tag}@example.test`])).rows[0].id
  const membershipId = (await q<{ id: string }>(`insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active') returning id`, [tenantId, userId])).rows[0].id
  const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Bay','400.00') returning id`, [tenantId])).rows[0].id
  const resourceId = (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'Bay 1') returning id`, [tenantId, branchId, typeId])).rows[0].id

  let seq = 0
  /** A booking of `hours` × ₹400 with an optional PAID online intent. */
  async function makeBooking(hours: number, o: { paid?: string; unpaidIntent?: string } = {}) {
    seq++
    const total = (hours * 400).toFixed(2)
    const bk = await q<{ id: string; confirmation_token: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_name,status,source,subtotal,total,deposit)
       values ($1,$2,$3,'Guest','confirmed','online',$4,$4,$5) returning id, confirmation_token`,
      [tenantId, branchId, `BK-ADV-${tag}-${seq}`, total, o.paid ?? o.unpaidIntent ?? '0.00'],
    )
    const bookingId = bk.rows[0].id
    const start = new Date(Date.now() + (seq + 2) * 86_400_000)
    await q(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,resource_name,resource_type_name)
       values ($1,$2,$3,$4,$5,'400.00',$6,'Bay 1','Bay')`,
      [tenantId, bookingId, resourceId, start, new Date(start.getTime() + hours * 3_600_000), total],
    )
    if (o.paid) {
      await q(
        `insert into payment_intents (tenant_id,branch_id,booking_id,gateway_order_id,gateway_payment_id,amount,currency,status)
         values ($1,$2,$3,$4,$5,$6,'INR','paid')`,
        [tenantId, branchId, bookingId, `order_ADV${tag}${seq}`, `pay_ADV${tag}${seq}`, o.paid],
      )
    }
    if (o.unpaidIntent) {
      await q(
        `insert into payment_intents (tenant_id,branch_id,booking_id,gateway_order_id,amount,currency,status)
         values ($1,$2,$3,$4,$5,'INR','pending')`,
        [tenantId, branchId, bookingId, `order_ADV${tag}${seq}`, o.unpaidIntent],
      )
    }
    return { bookingId, token: bk.rows[0].confirmation_token }
  }
  const status = async (id: string) => (await q<{ status: string }>(`select status from bookings where id=$1`, [id])).rows[0].status
  const bill = (bookingId: string) =>
    withUser(userId, (tx) => issueInvoiceForBooking(tx, { id: tenantId, timezone: 'Asia/Kolkata' }, { bookingId }))
  const settlementOf = (invoiceId: string) => withUser(userId, (tx) => getInvoiceSettlement(tx, tenantId, invoiceId))

  console.log('\n── POS: ₹500 advance on a ₹4,000 booking ──')
  const a = await makeBooking(10, { paid: '500.00' })
  const inv = await bill(a.bookingId)
  let s = (await settlementOf(inv.invoiceId))!
  check('the bill is ₹4,000 with ₹500 already captured and ₹3,500 due', s.total === 4000 && s.paid === 500 && s.balance === 3500, s)
  check('…the advance is an already-captured ONLINE payment', s.payments.length === 1 && s.payments[0].method === 'online' && s.payments[0].status === 'captured')
  await withUser(userId, (tx) => completeBookingIfFullySettled(tx, tenantId, a.bookingId))
  check('the advance alone does NOT complete the booking', (await status(a.bookingId)) === 'confirmed')
  const billable = await getBillableForBooking({ user: { id: userId }, tenant: { id: tenantId } } as never, a.bookingId)
  check('the bill screen data reports the advance as paid and nothing unapplied', billable?.booking.onlineAdvance.paid === 500 && billable?.booking.onlineAdvance.unapplied === 0, billable?.booking.onlineAdvance)
  const tender = await withUser(userId, (tx) => recordPaymentForInvoice(tx, { tenantId, membershipId }, { invoiceId: inv.invoiceId, method: 'cash', amount: 3500 }))
  check('collecting the remaining ₹3,500 settles the bill', tender.settled === true && tender.balance === 0, tender)
  await withUser(userId, (tx) => completeBookingIfFullySettled(tx, tenantId, a.bookingId))
  check('…and only now is the booking completed', (await status(a.bookingId)) === 'completed')

  console.log('\n── POS: bill smaller than the advance -> refund due, not lost ──')
  const over = await makeBooking(1, { paid: '900.00' })
  const invOver = await bill(over.bookingId)
  check('a ₹400 bill cannot absorb the ₹900 advance', invOver.deposits.applied.length === 0 && invOver.deposits.unapplied[0]?.amount === 900, invOver.deposits)
  const sum = await withUser(userId, (tx) => summarizeOnlineAdvance(tx, tenantId, over.bookingId))
  check('summarizeOnlineAdvance reports ₹900 paid, all of it unapplied', sum.paid === 900 && sum.unapplied === 900, sum)
  const bo = await getBillableForBooking({ user: { id: userId }, tenant: { id: tenantId } } as never, over.bookingId)
  check('the bill screen data carries the refund-due amount (₹900)', bo?.booking.onlineAdvance.unapplied === 900, bo?.booking.onlineAdvance)
  const pre = await makeBooking(2, { paid: '500.00' })
  const bp = await getBillableForBooking({ user: { id: userId }, tenant: { id: tenantId } } as never, pre.bookingId)
  check('before any bill exists a waiting advance is not flagged as refund due', bp?.booking.onlineAdvance.paid === 500 && bp?.booking.onlineAdvance.unapplied === 0, bp?.booking.onlineAdvance)

  console.log('\n── /b/[token]: paid + balance == total ──')
  const cases: [string, Awaited<ReturnType<typeof makeBooking>>, string, string][] = [
    ['venue (nothing paid online)', await makeBooking(10), '0.00', '4000.00'],
    ['advance ₹500 paid', await makeBooking(10, { paid: '500.00' }), '500.00', '3500.00'],
    ['full ₹4,000 paid', await makeBooking(10, { paid: '4000.00' }), '4000.00', '0.00'],
    ['advance owed but not paid yet', await makeBooking(10, { unpaidIntent: '500.00' }), '0.00', '4000.00'],
  ]
  for (const [label, b, wantPaid, wantBalance] of cases) {
    const page = await getPublicBookingByToken(tenantId, b.token)
    const ok = page && page.paidOnline === wantPaid && page.balanceDue === wantBalance && Math.round((Number(page.paidOnline) + Number(page.balanceDue)) * 100) === Math.round(Number(page.total) * 100)
    check(`${label}: paid ${wantPaid} + balance ${wantBalance} == total`, Boolean(ok), page && { paid: page.paidOnline, balance: page.balanceDue, total: page.total })
  }
  const leak = JSON.stringify(await getPublicBookingByToken(tenantId, cases[1][1].token))
  check('the public reader exposes no intent or gateway ids', !/order_ADV|pay_ADV|gateway|intent/i.test(leak), leak.slice(0, 200))

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
