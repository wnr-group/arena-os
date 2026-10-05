/**
 * M26 #2 — folding a gaming-cafe cash advance into the invoice ledger at
 * billing time (applyAdvancePaymentToInvoice, called from
 * issueInvoiceForBooking).
 *
 * Drives issueInvoiceForBooking exactly as the cashier's "raise bill" action
 * does, on bookings with bookings.advance_paid set directly (M26 #1 — no
 * staff UI writes this column yet), and reads the result back through
 * listBookingPaymentStates() with ZERO changes to that function, proving the
 * ticket's own claim: once the advance is a real payments row, the existing
 * badge logic just works.
 *
 * Covers:
 *   - an advance smaller than the total → "Part paid", capped correctly
 *   - an advance that exactly covers the total → "Paid", booking auto-completes
 *   - an advance LARGER than the total → capped at the total, no excess tracked
 *   - advance_applied guards against ever applying the same cash twice
 *   - advance_paid = 0 is a true no-op — no payment row, advance_applied stays false
 *   - a non-gaming_cafe tenant (e.g. restaurant) is a no-op even with advance_paid > 0
 *   - a ₹0 (fully comped) bill leaves the tender genuinely unconsumed (no ₹0
 *     payment, invoice_id stays null) — adversarial review of PR #38 found the
 *     earlier shape stamped it anyway "for nothing," hiding real cash from the
 *     cancellation-review safety net; see advance-settlement.ts's doc comment
 *   - the audit_log row lands in the SAME transaction as the invoice
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-advance-payment.ts
 *
 * (Both hooks: issueInvoiceForBooking's completeBookingIfFullySettled call
 * reaches revalidatePath()/cookies() indirectly through lib/booking/service.ts
 * in some paths — same rule as every other M16/M21 both-hooks suite.)
 */
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
  const { Pool } = await import('pg')
  const { listBookingPaymentStates } = await import('../lib/billing/data')
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { withUser } = await import('../db')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  async function makeTenant(slug: string, industry: 'gaming_cafe' | 'restaurant' = 'gaming_cafe') {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,$4)
       on conflict (slug) do update set name=excluded.name, industry=excluded.industry returning id`,
      [slug, `${slug} co`, TZ, industry],
    )
    const tenantId = t.rows[0].id
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
    const m = await owner.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [tenantId, u.rows[0].id],
    )
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','400.00')
       on conflict (tenant_id,name) do update set hourly_rate='400.00' returning id`,
      [tenantId],
    )
    const res = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'S1')
       on conflict (tenant_id,name) do update set name='S1' returning id`,
      [tenantId, b.rows[0].id, rt.rows[0].id],
    )
    const ctx: ActiveContext = {
      user: { id: u.rows[0].id, email: `owner@${slug}.test`, fullName: null, isPlatformAdmin: false },
      tenant: { id: tenantId, slug, name: `${slug} co`, industry, status: 'active', currency: 'INR', timezone: TZ },
      role: 'owner',
      membershipId: m.rows[0].id,
      branchId: b.rows[0].id,
    }
    return {
      ctx,
      tenantId,
      branchId: b.rows[0].id,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      resourceId: res.rows[0].id,
    }
  }

  const A = await makeTenant('testadva', 'gaming_cafe')
  const R = await makeTenant('testadvr', 'restaurant')
  for (const t of [A, R]) {
    await owner.query('delete from invoices where tenant_id=$1', [t.tenantId])
    await owner.query('delete from bookings where tenant_id=$1', [t.tenantId])
    await owner.query('delete from sequences where tenant_id=$1', [t.tenantId])
  }

  let seq = 0
  /** A confirmed booking worth `total` rupees (2h at total/2 an hour), with an optional advance already recorded on it. */
  type Tender = { method: 'cash' | 'card' | 'upi'; amount: number }
  async function makeBooking(t: typeof A, total = 1000, advance: number | Tender[] = 0) {
    // M30 #3/#4: the fold-in reads the advance_payments ledger; a bare number
    // is one cash tender, as the shipped M26 recorded. The superseded
    // bookings.advance_paid is deliberately left at 0 — nothing reads it.
    const tenders: Tender[] = typeof advance === 'number' ? (advance > 0 ? [{ method: 'cash', amount: advance }] : []) : advance
    const n = ++seq
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total,advance_paid,created_by)
       values ($1,$2,$3,'confirmed','0','0',$4,$5) returning id`,
      [t.tenantId, t.branchId, `AV-${n}`, '0.00', t.membershipId],
    )
    for (const [i, x] of tenders.entries()) {
      await owner.query(
        `insert into advance_payments (tenant_id,branch_id,booking_id,method,amount,collected_by,created_at)
         values ($1,$2,$3,$4,$5,$6, now() + ($7 || ' milliseconds')::interval)`,
        [t.tenantId, t.branchId, bk.rows[0].id, x.method, x.amount.toFixed(2), t.membershipId, String(i)],
      )
    }
    const s = new Date(Date.UTC(2041, 0, 1 + (n % 27), 4, 0, 0))
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,$6,$7,'S1','PS5',true)`,
      [t.tenantId, bk.rows[0].id, t.resourceId, s, new Date(s.getTime() + 2 * 3600_000), (total / 2).toFixed(2), total.toFixed(2)],
    )
    return bk.rows[0].id
  }

  const bill = (t: typeof A, bookingId: string, discount?: number) =>
    withUser(t.userId, (tx) => issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId, discount }))

  const stateOf = async (t: typeof A, bookingId: string) => (await listBookingPaymentStates(t.ctx, [bookingId]))[bookingId]

  const paymentsFor = async (invoiceId: string) =>
    (await owner.query(`select method, amount, status, collected_by from payments where invoice_id=$1`, [invoiceId])).rows

  const bookingRow = async (bookingId: string) =>
    (await owner.query(`select status from bookings where id=$1`, [bookingId])).rows[0]

  // ══ 1. an advance smaller than the total ═══════════════════════════════════
  console.log('\n── advance smaller than the total ──')
  {
    const bookingId = await makeBooking(A, 1000, 400)
    const inv = await bill(A, bookingId)
    check('billing succeeded', typeof inv.invoiceId === 'string')
    check("the ticket's own result shape reports what was applied", inv.advance?.amount === 400)

    const rows = await paymentsFor(inv.invoiceId)
    check('exactly one payments row was inserted for the advance', rows.length === 1)
    check("…method 'cash', status 'captured'", rows[0].method === 'cash' && rows[0].status === 'captured')
    check('…for exactly ₹400 — the advance, not the total', rows[0].amount === '400.00')
    check("…attributed to whoever collected it at the time (the tender's own collected_by)", rows[0].collected_by === A.membershipId)

    const s = await stateOf(A, bookingId)
    check('listBookingPaymentStates reports "partially_paid" — ZERO changes to that function', s?.status === 'partially_paid')
    check('…₹400 paid, ₹600 still due', s?.paid === 400 && s?.balance === 600)

    const b = await bookingRow(bookingId)
    const stamped = await owner.query(`select invoice_id from advance_payments where booking_id=$1`, [bookingId])
    check('the tender is stamped with the invoice (consumed)', stamped.rows.length === 1 && stamped.rows[0].invoice_id === inv.invoiceId)
    check('the booking is still active (not auto-completed — a balance remains)', b.status === 'confirmed')

    const audit = await owner.query(
      `select action, entity_type, entity_id, actor_membership_id from audit_log where tenant_id=$1 and action='booking.advance_applied' and entity_id=$2`,
      [A.tenantId, inv.invoiceId],
    )
    check('an audit_log row was written in the same transaction', audit.rows.length === 1)
    check("…entity_type is 'invoice', attributed to whoever created the booking", audit.rows[0].entity_type === 'invoice' && audit.rows[0].actor_membership_id === A.membershipId)
  }

  // ══ 2. an advance that exactly covers the total ════════════════════════════
  console.log('\n── advance exactly covers the total ──')
  {
    const bookingId = await makeBooking(A, 1000, 1000)
    const inv = await bill(A, bookingId)
    check('the invoice settles to "paid" the moment it is raised', inv.advance?.amount === 1000)

    const s = await stateOf(A, bookingId)
    check('listBookingPaymentStates reports "paid"', s?.status === 'paid')
    check('…nothing due', s?.balance === 0)

    const b = await bookingRow(bookingId)
    check('a fully-settled advance auto-completes the booking, same as a cashier\'s final tender', b.status === 'completed')
  }

  // ══ 3. an advance LARGER than the total — capped, no excess tracked ════════
  console.log('\n── advance larger than the total ──')
  {
    const bookingId = await makeBooking(A, 800, 1000)
    const inv = await bill(A, bookingId)
    check('the applied amount is capped at the invoice total, not the raw advance', inv.advance?.amount === 800)

    const rows = await paymentsFor(inv.invoiceId)
    check('only ₹800 was captured — the ₹200 difference is not recorded anywhere', rows.length === 1 && rows[0].amount === '800.00')

    const s = await stateOf(A, bookingId)
    check('the booking reads fully "paid", never overpaid or negative', s?.status === 'paid' && s?.balance === 0)
  }

  // ══ 4. advance_applied guards against ever applying the same cash twice ════
  console.log('\n── never applied twice ──')
  {
    const { applyAdvancePaymentToInvoice } = await import('../lib/payments/advance-settlement')
    const bookingId = await makeBooking(A, 1000, 400)
    const inv = await bill(A, bookingId)
    check('the first bill applied the advance once', inv.advance?.amount === 400)

    // Call the settlement core again directly, against the SAME invoice, the
    // way a retried/duplicated billing attempt would — this is the exact
    // regression the ticket asks for.
    const second = await withUser(A.userId, (tx) => applyAdvancePaymentToInvoice(tx, A.tenantId, bookingId, inv.invoiceId))
    check('a second attempt is a no-op — advance_applied already true', second === null)

    const rows = await paymentsFor(inv.invoiceId)
    check('still exactly ONE payments row — the cash was never applied twice', rows.length === 1)
    const s = await stateOf(A, bookingId)
    check('…and the booking still reads "partially_paid" at ₹400, not ₹800', s?.status === 'partially_paid' && s?.paid === 400)
  }

  // ══ 5. advance_paid = 0 is a true no-op ═════════════════════════════════════
  console.log('\n── advance_paid = 0 ──')
  {
    const bookingId = await makeBooking(A, 1000, 0)
    const inv = await bill(A, bookingId)
    check('billing behaves exactly as it did before this ticket', inv.advance === null)

    const rows = await paymentsFor(inv.invoiceId)
    check('no payments row was inserted', rows.length === 0)

    const none = await owner.query(`select 1 from advance_payments where booking_id=$1`, [bookingId])
    check('no ledger rows exist — nothing was ever collected or reckoned with', none.rowCount === 0)

    const s = await stateOf(A, bookingId)
    check('the booking reads "issued" (Unpaid), same as any other unpaid bill', s?.status === 'issued')
  }

  // ══ 6. a non-gaming_cafe tenant is byte-identical, even with advance_paid > 0 ══
  console.log('\n── restaurant tenant: byte-identical no-op ──')
  {
    const bookingId = await makeBooking(R, 1000, 400)
    const inv = await bill(R, bookingId)
    check('advance folding never runs for a non-gaming_cafe tenant', inv.advance === null)

    const rows = await paymentsFor(inv.invoiceId)
    check('no payments row was inserted, despite advance_paid = 400 sitting on the booking', rows.length === 0)

    const led = await owner.query(`select amount::text amount, invoice_id from advance_payments where booking_id=$1`, [bookingId])
    check('the ledger row is untouched — still ₹400, still unconsumed (invoice_id null)', led.rows.length === 1 && led.rows[0].amount === '400.00' && led.rows[0].invoice_id === null)

    const s = await stateOf(R, bookingId)
    check('the booking reads "issued" (Unpaid) — same as if advance_paid did not exist', s?.status === 'issued')
  }

  // ══ 7. a ₹0 (fully comped) bill: the tender is left genuinely unconsumed ═══
  // Adversarial review of PR #38: the earlier shape stamped the tender's
  // invoice_id anyway ("reckoned with once, for nothing"), which silently hid
  // real collected cash from hasUnconsumedAdvance (the cancellation-review
  // safety net) with zero audit trail for the mutation. Now it's left
  // unconsumed, same as any other tender an invoice had no room for.
  console.log('\n── a free bill with an advance already collected ──')
  {
    const bookingId = await makeBooking(A, 1000, 400)
    const inv = await bill(A, bookingId, 1000) // discounted to zero
    check('nothing was left to apply — reported as a no-op, same shape as advance_paid=0', inv.advance === null)

    const rows = await paymentsFor(inv.invoiceId)
    check('no ₹0 payments row was inserted', rows.length === 0)

    const stamped = await owner.query(`select invoice_id from advance_payments where booking_id=$1`, [bookingId])
    check('the tender is left UNCONSUMED, not silently written off', stamped.rows[0].invoice_id === null)

    const audit = await owner.query(`select 1 from audit_log where action='booking.advance_applied' and entity_id=$1`, [inv.invoiceId])
    check('…and no audit_log row was written for a mutation that never happened', audit.rows.length === 0)

    const s = await stateOf(A, bookingId)
    check('the booking still reads "paid" — a ₹0 bill, not a phantom balance (settled at invoice issue, not via the advance)', s?.status === 'paid' && s?.total === 0)
  }

  // ══ 7b. same, but with MULTIPLE tenders — none are sacrificed ══════════════
  console.log('\n── a free bill with a SPLIT advance already collected ──')
  {
    const bookingId = await makeBooking(A, 1000, [
      { method: 'cash', amount: 300 },
      { method: 'upi', amount: 100 },
    ])
    const inv = await bill(A, bookingId, 1000) // discounted to zero
    check('nothing was left to apply — reported as a no-op', inv.advance === null)

    const rows = await paymentsFor(inv.invoiceId)
    check('no ₹0 payments rows were inserted', rows.length === 0)

    const led = await owner.query(`select invoice_id from advance_payments where booking_id=$1`, [bookingId])
    check('every tender is left unconsumed — not just all-but-the-oldest', led.rows.length === 2 && led.rows.every((r: { invoice_id: string | null }) => r.invoice_id === null))
  }

  // ══ 7c. a deposit alone covers the bill; advance tenders stay untouched ════
  // The realistic repro the adversarial review traced: issueInvoiceForBooking
  // calls applyPaidDepositsToInvoice BEFORE applyAdvancePaymentToInvoice, so an
  // online deposit that already covers the total leaves `remaining = 0` before
  // this function ever looks at a single tender.
  console.log('\n── a deposit alone covers the bill; the advance is untouched ──')
  {
    const bookingId = await makeBooking(A, 500, [{ method: 'cash', amount: 200 }])
    await owner.query(
      `insert into payment_intents (tenant_id, branch_id, booking_id, purpose, status, gateway, gateway_order_id, gateway_payment_id, amount)
       values ($1, $2, $3, 'booking_deposit', 'paid', 'razorpay', $4, $5, '500.00')`,
      [A.tenantId, A.branchId, bookingId, `order_test_${bookingId}`, `pay_test_${bookingId}`],
    )
    const inv = await bill(A, bookingId, 0)
    check('the deposit alone settles the bill', inv.advance === null)
    const led = await owner.query(`select invoice_id from advance_payments where booking_id=$1`, [bookingId])
    check('the advance tender is untouched — still available for manual reconciliation', led.rows[0].invoice_id === null)
  }

  const ledgerFor = async (bookingId: string) =>
    (await owner.query(`select method, amount::text amount, invoice_id from advance_payments where booking_id=$1 order by created_at`, [bookingId])).rows
  const byAmountDesc = (a: { amount: string }, b: { amount: string }) => Number(b.amount) - Number(a.amount)

  // ══ 8. M30 #3 — each tender becomes its own payments row, own method ═══════
  console.log('\n── split advance: cash + card + UPI ──')
  {
    const bookingId = await makeBooking(A, 1000, [
      { method: 'cash', amount: 300 },
      { method: 'card', amount: 200 },
      { method: 'upi', amount: 100 },
    ])
    const inv = await bill(A, bookingId)
    const rows = (await paymentsFor(inv.invoiceId)).sort(byAmountDesc)
    check('three tenders → three payments rows', rows.length === 3)
    check(
      '…each with its own method and amount',
      rows[0].method === 'cash' && rows[0].amount === '300.00' && rows[1].method === 'card' && rows[1].amount === '200.00' && rows[2].method === 'upi' && rows[2].amount === '100.00',
    )
    check('…all captured', rows.every((r: { status: string }) => r.status === 'captured'))
    check('result reports the sum and each applied tender', inv.advance?.amount === 600 && inv.advance?.applied.length === 3)
    const led = await ledgerFor(bookingId)
    check('every tender is stamped with the invoice id', led.every((r: { invoice_id: string }) => r.invoice_id === inv.invoiceId))
    check('listBookingPaymentStates: ₹600 in', (await stateOf(A, bookingId))?.paid === 600)
    const audit = await owner.query(`select after from audit_log where action='booking.advance_applied' and entity_id=$1`, [inv.invoiceId])
    check(
      'one audit entry lists every tender with method + amounts',
      audit.rows.length === 1 && audit.rows[0].after.tenders.length === 3 && audit.rows[0].after.amount_applied === '600.00',
    )

    const { applyAdvancePaymentToInvoice } = await import('../lib/payments/advance-settlement')
    const again = await withUser(A.userId, (tx) => applyAdvancePaymentToInvoice(tx, A.tenantId, bookingId, inv.invoiceId))
    check('re-running the fold-in is a no-op, no double-apply', again === null && (await paymentsFor(inv.invoiceId)).length === 3)
  }

  console.log('\n── split advance larger than the bill: capped per tender, oldest first ──')
  {
    const bookingId = await makeBooking(A, 500, [
      { method: 'cash', amount: 300 },
      { method: 'upi', amount: 300 },
      { method: 'card', amount: 100 },
    ])
    const inv = await bill(A, bookingId)
    const rows = (await paymentsFor(inv.invoiceId)).sort(byAmountDesc)
    check(
      'oldest tender in full (₹300 cash), second capped to the ₹200 left',
      rows.length === 2 && rows[0].method === 'cash' && rows[0].amount === '300.00' && rows[1].method === 'upi' && rows[1].amount === '200.00',
    )
    const led = await ledgerFor(bookingId)
    check('the capped tender is still stamped (excess not tracked)', led[1].invoice_id === inv.invoiceId)
    check('the tender not reached stays unconsumed (invoice_id null)', led[2].invoice_id === null)
    check('the booking is fully paid', (await stateOf(A, bookingId))?.status === 'paid')
  }

  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
