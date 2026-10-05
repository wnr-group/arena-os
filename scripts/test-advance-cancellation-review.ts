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

  async function makeBooking(t: typeof G, advancePaid: number) {
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
      advanceTenders: advancePaid > 0 ? [{ method: 'cash' as const, amount: advancePaid }] : [],
      slots: [{ resourceId: t.resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }],
    })
    if (!r.bookingId) throw new Error(`createBooking failed: ${r.error}`)
    return r.bookingId
  }

  async function readBooking(bookingId: string) {
    const row = await owner.query<{
      status: string
      deposit_review_required: boolean
      advance_paid: string
      advance_applied: boolean
      cancellation_reason: string | null
      cancelled_at: Date | null
    }>(
      `select status, deposit_review_required, advance_paid, advance_applied, cancellation_reason, cancelled_at
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
    // (called from issueInvoiceForBooking) flips advance_applied to true.
    const ownerRow = await owner.query<{ id: string }>(`select id from users where email = $1`, [
      `owner-gaming_cafe-${tag}@example.test`,
    ])
    await withUser(ownerRow.rows[0].id, (tx) => issueInvoiceForBooking(tx, { id: G.tenantId, timezone: TZ }, { bookingId }))

    const beforeCancel = await readBooking(bookingId)
    check('advance_applied is true before cancelling', beforeCancel.advance_applied === true)

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

  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
