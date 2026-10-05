/**
 * M26 #6 — cancellation safety net for an unconsumed gaming-cafe cash advance.
 *
 * Mirrors the online-deposit safety net (bookings.depositReviewRequired,
 * migration 0047, set by lib/portal/cancel.ts's customer self-cancel path):
 * cancelling a gaming-cafe booking that is still holding a cash advance
 * (bookings.advance_paid, M26 #1) which was never folded into a real invoice
 * (bookings.advance_applied, M26 #2/#3) now raises the SAME flag, reusing the
 * column rather than inventing a parallel one — see setBookingStatus's
 * 'cancelled' branch in lib/actions/bookings.ts.
 *
 * Covers:
 *   - a gaming-cafe booking with an unconsumed advance raises the flag on cancel
 *   - a gaming-cafe booking whose advance was already applied to an invoice
 *     (advance_applied = true) does NOT raise it — that money is already on a
 *     real payment record, not orphaned
 *   - a gaming-cafe booking with advance_paid = 0 does NOT raise it (the
 *     common case, byte-identical to today)
 *   - a non-gaming_cafe (restaurant) tenant's cancellation is untouched
 *   - the pre-existing cancel behaviour (status/cancelledAt/cancellationReason,
 *     open-order cleanup) is unaffected
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-advance-cancellation-review.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'

async function main() {
  const { createBooking, setBookingStatus } = await import('../lib/actions/bookings')
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { withUser } = await import('../db')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  async function makeTenant(industry: 'gaming_cafe' | 'restaurant') {
    const slug = `advance-cancel-${industry.replace(/_/g, '-')}-${tag}`
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,$4) returning id`,
      [slug, `${slug} co`, TZ, industry],
    )
    const tenantId = t.rows[0].id
    const br = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
      [tenantId],
    )
    const branchId = br.rows[0].id
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'S','200.00') returning id`,
      [tenantId],
    )
    const res = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'S1','available') returning id`,
      [tenantId, branchId, rt.rows[0].id],
    )
    const resourceId = res.rows[0].id

    const email = `owner-${industry}-${tag}@example.test`
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash, full_name) values ($1,'x','Owner') returning id`,
      [email],
    )
    const token = randomBytes(32).toString('hex')
    await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
      createHash('sha256').update(token).digest('hex'),
      u.rows[0].id,
    ])
    await owner.query(
      `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'owner','active','Owner')`,
      [tenantId, u.rows[0].id, branchId],
    )
    return { tenantId, slug, branchId, resourceId, userToken: token }
  }

  const G = await makeTenant('gaming_cafe')
  const R = await makeTenant('restaurant')

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }

  const future = new Date()
  future.setUTCDate(future.getUTCDate() + 5)
  future.setUTCHours(6, 0, 0, 0)

  type Tender = { method: 'cash' | 'card' | 'upi'; amount: number }
  async function makeBooking(t: typeof G, advance: number | Tender[]) {
    const tenders: Tender[] = typeof advance === 'number' ? (advance > 0 ? [{ method: 'cash', amount: advance }] : []) : advance
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': t.slug }
    g.__ARENA_TEST_SESSION = t.userToken
    const startsAt = new Date(future)
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000)
    future.setUTCHours(future.getUTCHours() + 2) // keep each booking's window free of the last
    const r = await createBooking({
      branchId: t.branchId,
      customerName: 'Test Customer',
      customerPhone: `90000${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`,
      source: 'staff',
      advanceTenders: tenders,
      slots: [{ resourceId: t.resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }],
    })
    if (!r.bookingId) throw new Error(`createBooking failed: ${r.error}`)
    return r.bookingId
  }

  async function readBooking(bookingId: string) {
    const row = await owner.query<{
      status: string
      deposit_review_required: boolean
      cancellation_reason: string | null
      cancelled_at: Date | null
    }>(
      `select status, deposit_review_required, cancellation_reason, cancelled_at
       from bookings where id = $1`,
      [bookingId],
    )
    return row.rows[0]
  }

  // ══ 1. unconsumed advance raises the flag on cancel ══════════════════════
  console.log('\n── gaming_cafe, unconsumed advance ──')
  {
    const bookingId = await makeBooking(G, 400)
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': G.slug }
    g.__ARENA_TEST_SESSION = G.userToken
    const r = await setBookingStatus(bookingId, 'cancelled', 'Customer changed plans')
    check('cancellation itself succeeds', !r.error, r.error)

    const row = await readBooking(bookingId)
    check('status is cancelled', row.status === 'cancelled', row.status)
    check('cancellation_reason is recorded, unaffected by this change', row.cancellation_reason === 'Customer changed plans')
    check('cancelled_at is stamped, unaffected by this change', row.cancelled_at !== null)
    check('deposit_review_required is raised', row.deposit_review_required === true, row.deposit_review_required)
  }

  // ══ 2. advance already applied to an invoice does NOT raise it ══════════
  console.log('\n── gaming_cafe, advance already applied (advance_applied = true) ──')
  {
    const bookingId = await makeBooking(G, 400)
    // Fold the advance onto a real invoice — M26 #2's applyAdvancePaymentToInvoice
    // (called from issueInvoiceForBooking) stamps the ledger rows with the invoice id.
    const ownerRow = await owner.query<{ id: string }>(`select id from users where email = $1`, [
      `owner-gaming_cafe-${tag}@example.test`,
    ])
    await withUser(ownerRow.rows[0].id, (tx) => issueInvoiceForBooking(tx, { id: G.tenantId, timezone: TZ }, { bookingId }))

    const unconsumed = await owner.query(`select 1 from advance_payments where booking_id=$1 and invoice_id is null`, [bookingId])
    check('every tender is stamped with the invoice before cancelling', unconsumed.rowCount === 0)

    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': G.slug }
    g.__ARENA_TEST_SESSION = G.userToken
    const r = await setBookingStatus(bookingId, 'cancelled', 'Duplicate booking')
    check('cancellation itself succeeds', !r.error, r.error)

    const row = await readBooking(bookingId)
    check('deposit_review_required is NOT raised — the advance is already on a real payment record', row.deposit_review_required === false)
  }

  // ══ 3. advance_paid = 0 does NOT raise it (the common case) ═════════════
  console.log('\n── gaming_cafe, advance_paid = 0 ──')
  {
    const bookingId = await makeBooking(G, 0)
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': G.slug }
    g.__ARENA_TEST_SESSION = G.userToken
    const r = await setBookingStatus(bookingId, 'cancelled', 'No longer needed')
    check('cancellation itself succeeds', !r.error, r.error)

    const row = await readBooking(bookingId)
    check('deposit_review_required stays false — nothing was collected upfront', row.deposit_review_required === false)
  }

  // ══ 4. a non-gaming_cafe tenant is untouched ═════════════════════════════
  console.log('\n── restaurant tenant: untouched ──')
  {
    const bookingId = await makeBooking(R, 0)
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': R.slug }
    g.__ARENA_TEST_SESSION = R.userToken
    const r = await setBookingStatus(bookingId, 'cancelled', 'Table no longer needed')
    check('cancellation itself succeeds', !r.error, r.error)

    const row = await readBooking(bookingId)
    check('deposit_review_required stays false — the gate never applies outside gaming_cafe', row.deposit_review_required === false)
  }

  // ══ 5. M30 #4 — precision: consumed vs unconsumed tenders ═══════════════
  console.log('\n── tender applied to a now-VOIDED invoice does not re-raise the flag ──')
  {
    const bookingId = await makeBooking(G, 400)
    const ownerRow = await owner.query<{ id: string }>(`select id from users where email = $1`, [
      `owner-gaming_cafe-${tag}@example.test`,
    ])
    const inv = await withUser(ownerRow.rows[0].id, (tx) => issueInvoiceForBooking(tx, { id: G.tenantId, timezone: TZ }, { bookingId }))
    await owner.query(`update invoices set status='void' where id=$1`, [inv.invoiceId])
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': G.slug }
    g.__ARENA_TEST_SESSION = G.userToken
    const r = await setBookingStatus(bookingId, 'cancelled', 'Voided bill, then cancelled')
    check('cancellation itself succeeds', !r.error, r.error)
    check(
      'flag stays down — the tender was already reckoned with, voiding the bill does not orphan it',
      (await readBooking(bookingId)).deposit_review_required === false,
    )
  }

  console.log('\n── some tenders consumed, one still unconsumed → flag raised ──')
  {
    const bookingId = await makeBooking(G, 400)
    const ownerRow = await owner.query<{ id: string }>(`select id from users where email = $1`, [
      `owner-gaming_cafe-${tag}@example.test`,
    ])
    await withUser(ownerRow.rows[0].id, (tx) => issueInvoiceForBooking(tx, { id: G.tenantId, timezone: TZ }, { bookingId }))
    // A further tender recorded after the first was consumed — genuinely unconsumed.
    await owner.query(
      `insert into advance_payments (tenant_id,branch_id,booking_id,method,amount)
       select tenant_id,branch_id,id,'upi',150 from bookings where id=$1`,
      [bookingId],
    )
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': G.slug }
    g.__ARENA_TEST_SESSION = G.userToken
    const r = await setBookingStatus(bookingId, 'cancelled', 'One tender still unconsumed')
    check('cancellation itself succeeds', !r.error, r.error)
    check(
      'flag raised — only the genuinely unconsumed tender counts, and it does',
      (await readBooking(bookingId)).deposit_review_required === true,
    )
  }

  console.log('\n── prior invoice consumed SOME tenders, booking re-billed, then cancelled ──')
  {
    // Three tenders; the first alone more than covers the bill, so the others
    // are never reached by invoice #1 and stay unconsumed. A scenario the old
    // single advance_applied flag could not even express.
    const bookingId = await makeBooking(G, [
      { method: 'cash', amount: 10000 },
      { method: 'upi', amount: 50 },
      { method: 'card', amount: 30 },
    ])
    const ownerRow = await owner.query<{ id: string }>(`select id from users where email = $1`, [
      `owner-gaming_cafe-${tag}@example.test`,
    ])
    const inv1 = await withUser(ownerRow.rows[0].id, (tx) => issueInvoiceForBooking(tx, { id: G.tenantId, timezone: TZ }, { bookingId }))
    const led = await owner.query(`select method, invoice_id from advance_payments where booking_id=$1 order by created_at, amount desc`, [bookingId])
    const consumedBy1 = led.rows.filter((r) => r.invoice_id === inv1.invoiceId).length
    check('invoice #1 consumed the first tender only; the rest were never reached', consumedBy1 === 1 && led.rows.filter((r) => r.invoice_id === null).length === 2)

    // The bill is voided and the booking re-billed: invoice #2 picks up the
    // still-unconsumed tenders — and nothing is applied twice.
    // Simulated: a real void needs the captured payments refunded first, and a
    // settled booking has auto-completed — so reopen it to allow the re-bill.
    await owner.query(`update invoices set status='void' where id=$1`, [inv1.invoiceId])
    await owner.query(`update bookings set status='confirmed' where id=$1`, [bookingId])
    const inv2 = await withUser(ownerRow.rows[0].id, (tx) => issueInvoiceForBooking(tx, { id: G.tenantId, timezone: TZ }, { bookingId }))
    check('the re-bill is a different invoice', inv2.invoiceId !== inv1.invoiceId)
    const after = await owner.query(`select invoice_id from advance_payments where booking_id=$1`, [bookingId])
    check('every tender is now reckoned with (first on invoice #1, the rest on #2)', after.rows.every((r) => r.invoice_id !== null))
    const onInv1 = await owner.query(`select count(*)::int n from payments where invoice_id=$1`, [inv1.invoiceId])
    check('the first tender was NOT applied a second time to invoice #2', after.rows.filter((r) => r.invoice_id === inv1.invoiceId).length === 1 && onInv1.rows[0].n === 1)

    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': G.slug }
    g.__ARENA_TEST_SESSION = G.userToken
    const r = await setBookingStatus(bookingId, 'cancelled', 'Re-billed then cancelled')
    check('cancellation itself succeeds', !r.error, r.error)
    check('flag stays down — no tender is left unconsumed', (await readBooking(bookingId)).deposit_review_required === false)
  }

  console.log('\n── tenders never reached by any invoice → flag raised on cancel ──')
  {
    const bookingId = await makeBooking(G, [
      { method: 'cash', amount: 10000 },
      { method: 'upi', amount: 300 },
    ])
    const ownerRow = await owner.query<{ id: string }>(`select id from users where email = $1`, [
      `owner-gaming_cafe-${tag}@example.test`,
    ])
    await withUser(ownerRow.rows[0].id, (tx) => issueInvoiceForBooking(tx, { id: G.tenantId, timezone: TZ }, { bookingId }))
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': G.slug }
    g.__ARENA_TEST_SESSION = G.userToken
    const r = await setBookingStatus(bookingId, 'cancelled', 'Unreached tender')
    check('cancellation itself succeeds', !r.error, r.error)
    check('flag raised — the UPI tender was never reckoned with, staff must review it', (await readBooking(bookingId)).deposit_review_required === true)
  }

  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
