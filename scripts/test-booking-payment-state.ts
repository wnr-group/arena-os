/**
 * Booking payment state — the badge on the booking list and detail panel.
 *
 * listBookingPaymentStates() answers "where does this booking stand with the
 * till?" for a whole day in one pair of queries. What matters is that it says
 * the SAME thing the payment panel and the receipt say about the same bill, so
 * this drives all three against the real billing code rather than asserting the
 * badge in isolation:
 *
 *   - unbilled, unpaid, part paid and settled each read correctly
 *   - `paid` counts CAPTURED tenders only — pending and failed are not money
 *   - refunded money is its own state, not a silent return to "unpaid"
 *   - a voided bill returns the booking to unbilled, so it can be re-billed
 *   - a zero-total bill is settled the moment it is raised
 *   - the balance never goes negative on an over-payment
 *   - one tenant's bookings are invisible to another
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-booking-payment-state.ts
 *
 * (The server-only hook is required: lib/billing/data.ts is `server-only`.)
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { ActiveContext } from '../lib/tenant/context'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()
  const { listBookingPaymentStates } = await import('../lib/billing/data')
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { recordPaymentForInvoice, getInvoiceSettlement } = await import('../lib/billing/payments')
  const { recordRefund } = await import('../lib/billing/refunds')
  const { withUser } = await import('../db')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} co`, TZ])
    const tenantId = t.rows[0].id
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`, [tenantId])
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`, [`owner@${slug}.test`])
    const m = await owner.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [tenantId, u.rows[0].id])
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','400.00')
       on conflict (tenant_id,name) do update set hourly_rate='400.00' returning id`, [tenantId])
    const res = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'S1')
       on conflict (tenant_id,name) do update set name='S1' returning id`,
      [tenantId, b.rows[0].id, rt.rows[0].id])
    const ctx: ActiveContext = {
      user: { id: u.rows[0].id, email: `owner@${slug}.test`, fullName: null, isPlatformAdmin: false },
      tenant: { id: tenantId, slug, name: `${slug} co`, industry: 'gaming', status: 'active',
        currency: 'INR', timezone: TZ },
      role: 'owner',
      membershipId: m.rows[0].id,
      branchId: b.rows[0].id,
    }
    return { ctx, tenantId, branchId: b.rows[0].id, userId: u.rows[0].id, membershipId: m.rows[0].id,
      resourceId: res.rows[0].id }
  }

  const A = await makeTenant('testpaystatea')
  const B = await makeTenant('testpaystateb')
  for (const t of [A, B]) {
    await owner.query('delete from invoices where tenant_id=$1', [t.tenantId])
    await owner.query('delete from bookings where tenant_id=$1', [t.tenantId])
    await owner.query('delete from sequences where tenant_id=$1', [t.tenantId])
  }

  let seq = 0
  /** A confirmed booking worth `total` rupees (2h at total/2 an hour). */
  async function makeBooking(t: typeof A, total = 1000) {
    const n = ++seq
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
       values ($1,$2,$3,'confirmed','0','0') returning id`, [t.tenantId, t.branchId, `PS-${n}`])
    const s = new Date(Date.UTC(2039, 0, 1 + (n % 27), 4, 0, 0))
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,$6,$7,'S1','PS5',true)`,
      [t.tenantId, bk.rows[0].id, t.resourceId, s, new Date(s.getTime() + 2 * 3600_000),
       (total / 2).toFixed(2), total.toFixed(2)])
    return bk.rows[0].id
  }

  const bill = (t: typeof A, bookingId: string, discount?: number) =>
    withUser(t.userId, (tx) =>
      issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId, discount }))

  const pay = (t: typeof A, invoiceId: string, amount: number, method: 'cash' | 'upi' = 'cash') =>
    withUser(t.userId, (tx) =>
      recordPaymentForInvoice(tx, { tenantId: t.tenantId, membershipId: t.membershipId },
        { invoiceId, method, amount }))

  const refund = (t: typeof A, paymentId: string, amount: number) =>
    withUser(t.userId, (tx) =>
      recordRefund(tx, { tenantId: t.tenantId, membershipId: t.membershipId },
        { paymentId, amount, reason: 'test' }))

  const stateOf = async (t: typeof A, bookingId: string) =>
    (await listBookingPaymentStates(t.ctx, [bookingId]))[bookingId]

  // ══ 1. not billed yet ════════════════════════════════════════════════════
  console.log('\n── an unbilled booking ──')
  {
    const bookingId = await makeBooking(A)
    check('no entry at all, which the UI reads as "Unbilled"',
      (await stateOf(A, bookingId)) === undefined)
    check('an empty id list short-circuits to {}',
      Object.keys(await listBookingPaymentStates(A.ctx, [])).length === 0)
  }

  // ══ 2. billed, nothing tendered ══════════════════════════════════════════
  console.log('\n── billed, unpaid ──')
  {
    const bookingId = await makeBooking(A, 1000)
    const inv = await bill(A, bookingId)
    const s = await stateOf(A, bookingId)
    check('status is "issued" — the badge reads Unpaid', s?.status === 'issued')
    check('…the invoice is named, so the row can link to it',
      s?.invoiceId === inv.invoiceId && s?.invoiceNumber === inv.invoiceNumber)
    check('…billed ₹1000, paid ₹0, ₹1000 due',
      s?.total === 1000 && s?.paid === 0 && s?.balance === 1000)
  }

  // ══ 3. part paid ═════════════════════════════════════════════════════════
  console.log('\n── part paid ──')
  {
    const bookingId = await makeBooking(A, 1000)
    const inv = await bill(A, bookingId)
    await pay(A, inv.invoiceId, 400)
    const s = await stateOf(A, bookingId)
    check('status is "partially_paid"', s?.status === 'partially_paid')
    check('…₹400 paid, ₹600 still due', s?.paid === 400 && s?.balance === 600)

    // The figures the payment panel shows for the same bill.
    const settlement = await withUser(A.userId, (tx) =>
      getInvoiceSettlement(tx, A.tenantId, inv.invoiceId))
    check('…and they match the payment panel exactly',
      settlement?.paid === s?.paid && settlement?.balance === s?.balance &&
      settlement?.total === s?.total)
  }

  // ══ 4. settled ═══════════════════════════════════════════════════════════
  console.log('\n── settled ──')
  {
    const bookingId = await makeBooking(A, 1000)
    const inv = await bill(A, bookingId)
    await pay(A, inv.invoiceId, 600)
    await pay(A, inv.invoiceId, 400, 'upi')
    const s = await stateOf(A, bookingId)
    check('two tenders that add to the total read as "paid"', s?.status === 'paid')
    check('…with nothing due', s?.balance === 0 && s?.paid === 1000)
  }

  // ══ 5. only CAPTURED money counts ════════════════════════════════════════
  console.log('\n── pending and failed tenders ──')
  {
    const bookingId = await makeBooking(A, 1000)
    const inv = await bill(A, bookingId)
    // Written straight to the table: the action only ever records captured
    // tenders, but an online payment sits 'pending' until its webhook lands.
    await owner.query(
      `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status)
       values ($1,$2,$3,'online','1000.00','pending'), ($1,$2,$3,'card','1000.00','failed')`,
      [A.tenantId, A.branchId, inv.invoiceId])
    const s = await stateOf(A, bookingId)
    check('a pending and a failed tender leave it Unpaid', s?.status === 'issued')
    check('…paid is still ₹0', s?.paid === 0 && s?.balance === 1000)

    await owner.query(`update payments set status='captured' where invoice_id=$1 and method='online'`,
      [inv.invoiceId])
    const after = await stateOf(A, bookingId)
    check('…and capturing the online one settles it', after?.status === 'paid' && after?.balance === 0)
  }

  // ══ 5b. refunds ══════════════════════════════════════════════════════════
  // Driven through recordRefund(), not by writing refund rows: a FULL refund
  // flips its payment to 'refunded' (so it leaves `paid` entirely) while a
  // partial one leaves it 'captured' at the full amount. Those two shapes are
  // what the status derivation has to tell apart.
  console.log('\n── refunded ──')
  {
    const bookingId = await makeBooking(A, 1000)
    const inv = await bill(A, bookingId)
    const p = await pay(A, inv.invoiceId, 1000)
    check('paid before the refund', (await stateOf(A, bookingId))?.status === 'paid')

    await refund(A, p.paymentId, 1000)
    const s = await stateOf(A, bookingId)
    check('a full refund reads "refunded", not "unpaid"', s?.status === 'refunded')
    check('…reporting ₹1000 refunded', s?.refunded === 1000)
    // The payment left 'captured', so paid drops out — exactly what the
    // payment panel shows for the same bill, which is the point.
    const settlement = await withUser(A.userId, (tx) =>
      getInvoiceSettlement(tx, A.tenantId, inv.invoiceId))
    check('…and paid/balance still agree with the payment panel',
      settlement?.paid === s?.paid && settlement?.balance === s?.balance)
  }
  {
    const bookingId = await makeBooking(A, 1000)
    const inv = await bill(A, bookingId)
    const p = await pay(A, inv.invoiceId, 1000)
    await refund(A, p.paymentId, 400)
    const s = await stateOf(A, bookingId)
    check('a partial refund reads "partially_refunded"', s?.status === 'partially_refunded')
    check('…reporting ₹400 refunded', s?.refunded === 400)
    check('…while the payment is still captured in full', s?.paid === 1000)
  }
  {
    // Two tenders, one handed back whole. Half the money is still held, so
    // this is NOT a refunded bill — the case that comparing refunds against
    // `paid` alone gets wrong, since a fully refunded payment is not in `paid`.
    const bookingId = await makeBooking(A, 1000)
    const inv = await bill(A, bookingId)
    const first = await pay(A, inv.invoiceId, 600)
    await pay(A, inv.invoiceId, 400, 'upi')
    await refund(A, first.paymentId, 600)
    const s = await stateOf(A, bookingId)
    check('one of two tenders refunded is "partially_refunded", not "refunded"',
      s?.status === 'partially_refunded')
    check('…₹600 back, ₹400 still held', s?.refunded === 600 && s?.paid === 400)
  }
  {
    const bookingId = await makeBooking(A, 1000)
    const inv = await bill(A, bookingId)
    const first = await pay(A, inv.invoiceId, 600)
    const second = await pay(A, inv.invoiceId, 400, 'upi')
    await refund(A, first.paymentId, 600)
    await refund(A, second.paymentId, 400)
    const s = await stateOf(A, bookingId)
    check('both tenders back reads "refunded"', s?.status === 'refunded')
    check('…₹1000 refunded, nothing held', s?.refunded === 1000 && s?.paid === 0)
  }

  // ══ 6. a voided bill ═════════════════════════════════════════════════════
  console.log('\n── a voided bill ──')
  {
    const bookingId = await makeBooking(A, 1000)
    const inv = await bill(A, bookingId)
    check('billed first', (await stateOf(A, bookingId))?.status === 'issued')
    await owner.query(`update invoices set status='void' where id=$1`, [inv.invoiceId])
    check('a voided invoice returns the booking to unbilled, ready to re-bill',
      (await stateOf(A, bookingId)) === undefined)
  }

  // ══ 7. a bill for nothing, and an over-payment ═══════════════════════════
  console.log('\n── edge amounts ──')
  {
    const freeBooking = await makeBooking(A, 1000)
    await bill(A, freeBooking, 1000) // discounted to zero
    const s = await stateOf(A, freeBooking)
    check('a ₹0 bill is settled the moment it is raised',
      s?.status === 'paid' && s?.total === 0 && s?.balance === 0)

    const bookingId = await makeBooking(A, 500)
    const inv = await bill(A, bookingId)
    await owner.query(
      `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status)
       values ($1,$2,$3,'cash','900.00','captured')`,
      [A.tenantId, A.branchId, inv.invoiceId])
    const over = await stateOf(A, bookingId)
    check('an over-captured bill reads Paid with ₹0 due, never negative',
      over?.status === 'paid' && over?.balance === 0)
  }

  // ══ 8. a split bill (M18) — several checks on one booking ═════════════════
  console.log('\n── a split bill aggregates every check ──')
  {
    const bookingId = await makeBooking(A, 1000)
    const groupId = randomUUID()
    // Two ₹500 checks sharing one bill_group_id, as issueSplitBillForBooking
    // writes them. Inserted directly because issueInvoiceForBooking refuses a
    // second live invoice for a booking.
    const c1 = await owner.query<{ id: string }>(
      `insert into invoices (tenant_id,branch_id,invoice_number,booking_id,status,subtotal,
         tax_total,total,bill_group_id,bill_group_seq)
       values ($1,$2,$3,$4,'issued','500','0','500',$5,1) returning id`,
      [A.tenantId, A.branchId, `SP-${++seq}-1`, bookingId, groupId])
    await owner.query(
      `insert into invoices (tenant_id,branch_id,invoice_number,booking_id,status,subtotal,
         tax_total,total,bill_group_id,bill_group_seq)
       values ($1,$2,$3,$4,'issued','500','0','500',$5,2)`,
      [A.tenantId, A.branchId, `SP-${seq}-2`, bookingId, groupId])
    // Settle the first check, leave the second unpaid.
    await pay(A, c1.rows[0].id, 500)

    const s = await stateOf(A, bookingId)
    check('one check paid, one unpaid reads "partially_paid" for the booking',
      s?.status === 'partially_paid')
    check('…totals are the whole table: ₹1000 billed, ₹500 paid, ₹500 due',
      s?.total === 1000 && s?.paid === 500 && s?.balance === 500)
    check('…and it reports 2 checks', s?.invoiceCount === 2)
    check('…linking the first check deterministically', s?.invoiceNumber === `SP-${seq}-1`)
  }

  // ══ 9. batching and isolation ════════════════════════════════════════════
  console.log('\n── a whole day at once ──')
  {
    const one = await makeBooking(A, 200)
    const two = await makeBooking(A, 300)
    const three = await makeBooking(A, 400)
    const invTwo = await bill(A, two)
    await pay(A, invTwo.invoiceId, 300)
    await bill(A, three)

    const states = await listBookingPaymentStates(A.ctx, [one, two, three])
    check('one query covers the day: unbilled / paid / unpaid',
      states[one] === undefined && states[two].status === 'paid' && states[three].status === 'issued')

    const bBooking = await makeBooking(B, 100)
    await bill(B, bBooking)
    const cross = await listBookingPaymentStates(A.ctx, [bBooking])
    check("tenant A cannot see tenant B's billed booking", cross[bBooking] === undefined)
    const own = await listBookingPaymentStates(B.ctx, [bBooking])
    check('…and tenant B can see its own (the refusal was not incidental)',
      own[bBooking]?.status === 'issued')
  }

  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
