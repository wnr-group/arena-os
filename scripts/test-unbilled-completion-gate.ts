/**
 * M26 #3 — closing the "complete a NEVER-billed booking" loophole.
 *
 * assertBookingFullyPaid and completeBookingIfFullySettled (both
 * lib/booking/service.ts) used to skip their check entirely whenever
 * findLiveBilling found no invoice at all — harmless before a gaming-cafe
 * booking could carry a cash advance (bookings.advance_paid, M26 #1), since
 * an unbilled booking could not owe anything. Once it can, that became a real
 * hole: collect part of the money up front, never raise a bill, mark it
 * completed anyway. Drives both functions directly against a real database,
 * exactly as scripts/test-split-bill.ts already does for assertBookingFullyPaid.
 *
 * Covers:
 *   - blocked when the advance is short of the booking's known total
 *   - allowed once the advance covers it, still with no invoice ever raised
 *   - allowed when a real invoice already fully settles it (pre-existing
 *     behaviour — must not regress)
 *   - a non-gaming_cafe tenant is untouched even with an advance recorded
 *   - a gaming_cafe booking with advance_paid = 0 is untouched
 *   - a STILL-RUNNING walk-in is untouched (its slot_total isn't frozen yet,
 *     so it must never be read as "trivially covered")
 *   - a CHECKED-OUT walk-in is gated exactly like a reserved booking (fixed
 *     post-review, PR #35 — the original cut of this ticket only covered
 *     channel='reserved', leaving a checked-out walk-in — the primary
 *     real-world case for a cash advance — with zero enforcement)
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-unbilled-completion-gate.ts
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
  const { assertBookingFullyPaid, completeBookingIfFullySettled, BookingError } = await import('../lib/booking/service')
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { recordPaymentForInvoice } = await import('../lib/billing/payments')
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
      resourceTypeId: rt.rows[0].id,
    }
  }

  const A = await makeTenant('testgatea', 'gaming_cafe')
  const R = await makeTenant('testgater', 'restaurant')
  for (const t of [A, R]) {
    await owner.query('delete from invoices where tenant_id=$1', [t.tenantId])
    await owner.query('delete from bookings where tenant_id=$1', [t.tenantId])
    await owner.query('delete from sequences where tenant_id=$1', [t.tenantId])
  }

  let seq = 0
  /** A confirmed booking worth `total` rupees (2h at total/2 an hour), with an optional advance and channel. */
  /** M30 #4: the gate sums the advance_payments ledger live; the superseded
   *  bookings.advance_paid is left at 0. Seeded as two tenders (cash + UPI) so
   *  the SUM is exercised, not just one row. */
  async function seedLedger(t: typeof A, bookingId: string, advancePaid: number) {
    if (advancePaid <= 0) return
    const first = Math.round(advancePaid * 100) / 200
    for (const [method, amount] of [['cash', first], ['upi', advancePaid - first]] as const) {
      await owner.query(
        `insert into advance_payments (tenant_id,branch_id,booking_id,method,amount) values ($1,$2,$3,$4,$5)`,
        [t.tenantId, t.branchId, bookingId, method, amount.toFixed(2)],
      )
    }
  }

  async function makeBooking(
    t: typeof A,
    total = 1000,
    advancePaid = 0,
    channel: 'reserved' | 'walkin' = 'reserved',
  ) {
    const n = ++seq
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total,advance_paid,channel,created_by)
       values ($1,$2,$3,'confirmed','0','0',$4,$5,$6) returning id`,
      [t.tenantId, t.branchId, `GT-${n}`, '0.00', channel, t.membershipId],
    )
    const bookingId = bk.rows[0].id
    await seedLedger(t, bookingId, advancePaid)
    const s = new Date(Date.UTC(2042, 0, 1 + (n % 27), 4, 0, 0))
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,$6,$7,'S1','PS5',true)`,
      [t.tenantId, bookingId, t.resourceId, s, new Date(s.getTime() + 2 * 3600_000), (total / 2).toFixed(2), total.toFixed(2)],
    )
    return bookingId
  }

  /** A walk-in booking, either still running (slot_total unfrozen, as
   *  startWalkinCore leaves it) or checked out (frozen, as checkoutWalkinCore
   *  leaves it) — mirrors reopenWalkinCore's own isCheckedOut shape: an
   *  open-tab is checked out once its slot's ends_at is stamped; a timed
   *  session is checked out once its slot_total is actually priced. Own
   *  dedicated resource per call — an open (not-checked-out) tab's ends_at is
   *  null, i.e. an UNBOUNDED range under the GiST exclusion constraint, which
   *  would otherwise collide with every later fixture on a shared resource. */
  async function makeWalkinBooking(t: typeof A, total: number, advancePaid: number, checkedOut: boolean) {
    const n = ++seq
    const res = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,$4)
       on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [t.tenantId, t.branchId, t.resourceTypeId, `WI-${n}`],
    )
    const resourceId = res.rows[0].id
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total,advance_paid,channel,billing_mode,created_by)
       values ($1,$2,$3,'checked_in','0','0',$4,'walkin','open_tab',$5) returning id`,
      [t.tenantId, t.branchId, `GT-${n}`, '0.00', t.membershipId],
    )
    const bookingId = bk.rows[0].id
    await seedLedger(t, bookingId, advancePaid)
    const s = new Date(Date.UTC(2042, 0, 1 + (n % 27), 4, 0, 0))
    const ends = checkedOut ? new Date(s.getTime() + 2 * 3600_000) : null
    const slotTotal = checkedOut ? total : 0
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,$6,$7,'S1','PS5',true)`,
      [t.tenantId, bookingId, resourceId, s, ends, (total / 2).toFixed(2), slotTotal.toFixed(2)],
    )
    return bookingId
  }

  const assertThrows = async (fn: () => Promise<void>) => {
    try {
      await fn()
      return { threw: false, message: '', isBookingError: false }
    } catch (e) {
      return { threw: true, message: e instanceof Error ? e.message : String(e), isBookingError: e instanceof BookingError }
    }
  }

  const bookingStatus = async (bookingId: string) => (await owner.query(`select status from bookings where id=$1`, [bookingId])).rows[0].status

  // ══ 1. blocked when short ═══════════════════════════════════════════════
  console.log('\n── blocked when the advance is short ──')
  {
    const bookingId = await makeBooking(A, 1000, 400, 'reserved')

    const r = await withUser(A.userId, (tx) => assertThrows(() => assertBookingFullyPaid(tx, A.tenantId, bookingId)))
    check('assertBookingFullyPaid throws — this booking was never billed at all', r.threw)
    check('…as a BookingError the caller may show verbatim', r.isBookingError)
    check('…naming the exact shortfall', r.message.includes('600.00'))

    const done = await withUser(A.userId, (tx) => completeBookingIfFullySettled(tx, A.tenantId, bookingId))
    check('completeBookingIfFullySettled returns false — same as its other refusal cases', done === false)
    check('…and writes nothing', (await bookingStatus(bookingId)) === 'confirmed')
  }

  // ══ 2. allowed once the advance covers it, no invoice ever raised ═══════
  console.log('\n── allowed once the advance covers it ──')
  {
    const bookingId = await makeBooking(A, 1000, 1000, 'reserved')

    const r = await withUser(A.userId, (tx) => assertThrows(() => assertBookingFullyPaid(tx, A.tenantId, bookingId)))
    check('assertBookingFullyPaid lets it through — no throw', !r.threw)

    const done = await withUser(A.userId, (tx) => completeBookingIfFullySettled(tx, A.tenantId, bookingId))
    check('completeBookingIfFullySettled actually completes it, still with no invoice', done === true)
    check('…the booking row reflects it', (await bookingStatus(bookingId)) === 'completed')

    // An advance LARGER than the total is covered too (same cap-not-track-
    // excess rule as M26 #2's invoice-time fold-in).
    const over = await makeBooking(A, 800, 1000, 'reserved')
    const overDone = await withUser(A.userId, (tx) => completeBookingIfFullySettled(tx, A.tenantId, over))
    check('an advance LARGER than the total is covered too', overDone === true)
  }

  // ══ 3. a real invoice already fully settles it — must not regress ═══════
  console.log('\n── a real invoice fully settles it (pre-existing behaviour) ──')
  {
    const bookingId = await makeBooking(A, 1000, 0, 'reserved')
    const inv = await withUser(A.userId, (tx) => issueInvoiceForBooking(tx, { id: A.tenantId, timezone: TZ }, { bookingId }))
    await withUser(A.userId, (tx) =>
      recordPaymentForInvoice(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { invoiceId: inv.invoiceId, method: 'cash', amount: 1000 }),
    )

    const r = await withUser(A.userId, (tx) => assertThrows(() => assertBookingFullyPaid(tx, A.tenantId, bookingId)))
    check('a fully-paid invoice still lets assertBookingFullyPaid through, unchanged', !r.threw)

    // Same settlement seam lib/actions/payments.ts calls right after a
    // tender — prove the booking completes via the INVOICE path (pre-
    // existing behaviour), not the new unbilled one.
    const done = await withUser(A.userId, (tx) => completeBookingIfFullySettled(tx, A.tenantId, bookingId))
    check('…and completeBookingIfFullySettled completes it via the normal paid-invoice path', done === true)
    check('…the booking row reflects it', (await bookingStatus(bookingId)) === 'completed')
  }
  {
    // The other half: an ISSUED-but-unpaid invoice must still block, same as always.
    const bookingId = await makeBooking(A, 1000, 0, 'reserved')
    await withUser(A.userId, (tx) => issueInvoiceForBooking(tx, { id: A.tenantId, timezone: TZ }, { bookingId }))
    const r = await withUser(A.userId, (tx) => assertThrows(() => assertBookingFullyPaid(tx, A.tenantId, bookingId)))
    check('an unpaid REAL invoice still blocks completion, exactly as before this ticket', r.threw)
    check('…with its own pre-existing message, not the new advance one', r.message.includes('outstanding balance') && !r.message.includes('is still due'))
    const done = await withUser(A.userId, (tx) => completeBookingIfFullySettled(tx, A.tenantId, bookingId))
    check('…and completeBookingIfFullySettled still refuses it too', done === false)
  }

  // ══ 4. a non-gaming_cafe tenant is untouched, even with an advance ═══════
  console.log('\n── restaurant tenant: untouched ──')
  {
    const bookingId = await makeBooking(R, 1000, 400, 'reserved')
    const r = await withUser(R.userId, (tx) => assertThrows(() => assertBookingFullyPaid(tx, R.tenantId, bookingId)))
    check('a short advance never blocks a non-gaming_cafe tenant — the gate does not apply', !r.threw)
    // completeBookingIfFullySettled already excludes restaurants outright
    // (the pre-existing industry check at its top), independent of billing.
    const done = await withUser(R.userId, (tx) => completeBookingIfFullySettled(tx, R.tenantId, bookingId))
    check('…and completeBookingIfFullySettled is still unconditionally false for a restaurant', done === false)
  }

  // ══ 5. advance_paid = 0 is untouched ══════════════════════════════════════
  console.log('\n── advance_paid = 0 ──')
  {
    const bookingId = await makeBooking(A, 1000, 0, 'reserved')
    const r = await withUser(A.userId, (tx) => assertThrows(() => assertBookingFullyPaid(tx, A.tenantId, bookingId)))
    check('no advance recorded — the never-billed booking passes through exactly as before', !r.threw)
    const done = await withUser(A.userId, (tx) => completeBookingIfFullySettled(tx, A.tenantId, bookingId))
    check('…and completeBookingIfFullySettled still refuses to auto-complete an unbilled booking', done === false)
  }

  // ══ 6. a walk-in: gated once checked out, not before (adversarial review) ═
  console.log('\n── a walk-in, still running: untouched ──')
  {
    // Still running (never checked out) — slot_total reads 0 either way, so
    // this must NOT be read as "trivially covered" by any advance, however
    // small. The gate simply does not apply yet.
    const bookingId = await makeWalkinBooking(A, 1000, 1, false)
    const r = await withUser(A.userId, (tx) => assertThrows(() => assertBookingFullyPaid(tx, A.tenantId, bookingId)))
    check('a still-running walk-in is not newly blocked — nothing is known yet', !r.threw)
    const done = await withUser(A.userId, (tx) => completeBookingIfFullySettled(tx, A.tenantId, bookingId))
    check('…and completeBookingIfFullySettled still refuses it (unbilled, not via the new gate)', done === false)
  }

  console.log('\n── a walk-in, checked out: gated exactly like a reserved booking ──')
  {
    // Checked out (slot_total frozen) with a SHORT advance — this is the gap
    // the adversarial review on PR #35 found: a checked-out walk-in used to
    // sail through setBookingStatus(..., 'completed') with an uncounted
    // shortfall, since the original cut of this ticket only covered
    // channel='reserved'.
    const bookingId = await makeWalkinBooking(A, 1000, 400, true)
    const r = await withUser(A.userId, (tx) => assertThrows(() => assertBookingFullyPaid(tx, A.tenantId, bookingId)))
    check('a checked-out walk-in with a short advance is now blocked', r.threw)
    check('…as a BookingError', r.isBookingError)
    check('…naming the exact shortfall', r.message.includes('600.00'))
    const done = await withUser(A.userId, (tx) => completeBookingIfFullySettled(tx, A.tenantId, bookingId))
    check('completeBookingIfFullySettled returns false too', done === false)
    check('…and writes nothing', (await bookingStatus(bookingId)) === 'checked_in')
  }
  {
    // Checked out with an advance that COVERS the frozen total — completes
    // via the unbilled path, same permissive outcome a covered reserved
    // booking already gets.
    const bookingId = await makeWalkinBooking(A, 1000, 1000, true)
    const r = await withUser(A.userId, (tx) => assertThrows(() => assertBookingFullyPaid(tx, A.tenantId, bookingId)))
    check('a checked-out walk-in fully covered by its advance is not blocked', !r.threw)
    const done = await withUser(A.userId, (tx) => completeBookingIfFullySettled(tx, A.tenantId, bookingId))
    check('…and completeBookingIfFullySettled completes it, still with no invoice ever raised', done === true)
    check('…the booking row reflects it', (await bookingStatus(bookingId)) === 'completed')
  }

  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
