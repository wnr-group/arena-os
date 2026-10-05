/**
 * M26 #7 — QA & regression for the gaming-cafe cash-advance epic (#1-#6).
 *
 * Where the other M26 scripts each pin ONE seam (advance-settlement.ts's
 * capping/idempotency, the unbilled-completion gate, the cancellation
 * safety net, core-level industry refusal), this one drives the WHOLE
 * lifecycle through the REAL SERVER ACTIONS a staff member actually
 * clicks — createBooking/startWalkin/checkoutWalkin (lib/actions/bookings.ts),
 * createInvoiceForBooking (lib/actions/billing.ts) — the same shape
 * scripts/test-checkout-walkin.ts already uses for M21. This is the layer
 * none of the other M26 scripts exercise end-to-end: zod validation,
 * requireContext()/role gates, and the action-to-core wiring itself, not
 * just the core functions in isolation.
 *
 * Covers:
 *   1. staff wizard path: create with an advance, bill it, capped SHORT of
 *      the total — and a second bill attempt on the same booking is refused
 *      (the action layer's own guard against ever billing twice, which is
 *      what actually prevents a double-apply in real usage)
 *   2. staff wizard path: an advance LARGER than the total caps at the
 *      total and auto-completes the booking
 *   3. walk-in path: start with an advance, close the tab, bill it — capped
 *      SHORT of the elapsed total
 *   4. walk-in path: an advance that covers the elapsed total caps and
 *      auto-completes
 *   5. the unbilled-completion refusal (#3), via the real setBookingStatus
 *      action: blocked when short, allowed (with no invoice ever raised)
 *      when covered
 *   6. cross-tenant/cross-industry fail-closed via the real action layer —
 *      a restaurant tenant's createBooking/startWalkin and a
 *      recording_studio tenant's createBooking/startWalkin (which, unlike a
 *      restaurant, IS allowed to walk-in at all) all refuse a forged
 *      advancePaid, no booking ever written
 *   7. the cancellation safety net (#6), via the real setBookingStatus
 *      action: an unconsumed advance raises depositReviewRequired; an
 *      advance already folded into an invoice (reusing #2's own booking)
 *      does not
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-advance-cash-payment.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, got?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()
  const { createBooking, startWalkin, checkoutWalkin, setBookingStatus } = await import('../lib/actions/bookings')
  const { createInvoiceForBooking } = await import('../lib/actions/billing')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  async function makeTenant(industry: 'gaming_cafe' | 'restaurant' | 'recording_studio') {
    const slug = `advcash-${industry.replace(/_/g, '')}-${tag}`
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
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Console','500.00') returning id`,
      [tenantId],
    )
    async function mintResource(name: string) {
      const r = await owner.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
        [tenantId, branchId, rt.rows[0].id, name],
      )
      return r.rows[0].id
    }
    const email = `owner-${industry}-${tag}@example.test`
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash, full_name) values ($1,'x','Owner') returning id`,
      [email],
    )
    const userId = u.rows[0].id
    await owner.query(`insert into memberships (tenant_id,user_id,role,status,full_name) values ($1,$2,'owner','active','Owner')`, [
      tenantId,
      userId,
    ])
    return { tenantId, slug, branchId, mintResource, userId }
  }

  const G = await makeTenant('gaming_cafe')
  const R = await makeTenant('restaurant')
  const S = await makeTenant('recording_studio')

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  async function signInAs(userId: string, tenantSlug: string) {
    const token = randomBytes(32).toString('hex')
    await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
      createHash('sha256').update(token).digest('hex'),
      userId,
    ])
    g.__ARENA_TEST_SESSION = token
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': tenantSlug }
  }

  let daySeq = 0
  const nextSlot = () => {
    const start = new Date(Date.UTC(2048, 0, 1 + ++daySeq, 4, 0, 0))
    return { start, end: new Date(start.getTime() + 2 * 3600_000) } // 2h @ 500/hr => 1000.00
  }
  let phoneSeq = 0
  const nextPhone = () => `98700${String(10000 + phoneSeq++).padStart(5, '0')}`

  const bookingRow = async (id: string) =>
    (
      await owner.query<{ status: string; advance_paid: string; advance_applied: boolean; deposit_review_required: boolean }>(
        `select status, advance_paid, advance_applied, deposit_review_required from bookings where id=$1`,
        [id],
      )
    ).rows[0]
  const paymentsFor = async (invoiceId: string) =>
    (await owner.query(`select method, amount, status from payments where invoice_id=$1`, [invoiceId])).rows
  const invoiceCountFor = async (bookingId: string) =>
    (await owner.query(`select count(*)::int n from invoices where booking_id=$1`, [bookingId])).rows[0].n
  const bookingCount = async (tenantId: string) =>
    (await owner.query(`select count(*)::int n from bookings where tenant_id=$1`, [tenantId])).rows[0].n

  await signInAs(G.userId, G.slug)
  const stationA = await G.mintResource('Reserved-A')

  // ══ 1. staff wizard: advance SHORT of the total ═════════════════════════
  console.log('\n── staff wizard path: advance short of the total ──')
  let shortBookingId = ''
  {
    const { start, end } = nextSlot()
    const r = await createBooking({
      branchId: G.branchId,
      customerName: 'Rahul',
      customerPhone: nextPhone(),
      source: 'staff',
      advanceTenders: [{ method: 'cash', amount: 400 }],
      slots: [{ resourceId: stationA, startsAt: start.toISOString(), endsAt: end.toISOString() }],
    })
    check('booking created via the real createBooking action', !r.error && Boolean(r.bookingId), r.error)
    shortBookingId = r.bookingId!
    check('advance_paid landed correctly', (await bookingRow(shortBookingId)).advance_paid === '400.00')

    const billed = await createInvoiceForBooking({ bookingId: shortBookingId })
    check('the bill screen raises the invoice', !billed.error && Boolean(billed.invoiceId), billed.error)
    const rows = await paymentsFor(billed.invoiceId!)
    check('exactly one cash payment row for the capped advance amount', rows.length === 1 && rows[0].amount === '400.00', rows)
    check('booking is still confirmed — ₹600 remains owed', (await bookingRow(shortBookingId)).status === 'confirmed')

    const second = await createInvoiceForBooking({ bookingId: shortBookingId })
    check('a second bill attempt on the same booking is refused', Boolean(second.error), second)
    check('…so exactly one invoice exists — the action layer is what stops a double-apply in real usage', (await invoiceCountFor(shortBookingId)) === 1)
  }

  // ══ 2. staff wizard: advance LARGER than the total ══════════════════════
  console.log('\n── staff wizard path: advance larger than the total ──')
  let coveredBookingId = ''
  {
    const { start, end } = nextSlot()
    const r = await createBooking({
      branchId: G.branchId,
      customerName: 'Priya',
      customerPhone: nextPhone(),
      source: 'staff',
      advanceTenders: [{ method: 'cash', amount: 1500 }],
      slots: [{ resourceId: stationA, startsAt: start.toISOString(), endsAt: end.toISOString() }],
    })
    check('booking created', !r.error && Boolean(r.bookingId), r.error)
    coveredBookingId = r.bookingId!

    const billed = await createInvoiceForBooking({ bookingId: coveredBookingId })
    check('billed', !billed.error && Boolean(billed.invoiceId), billed.error)
    const rows = await paymentsFor(billed.invoiceId!)
    check('capped at the ₹1000 total, not the raw ₹1500 advance', rows.length === 1 && rows[0].amount === '1000.00', rows)
    check('a fully-covered advance auto-completes the booking', (await bookingRow(coveredBookingId)).status === 'completed')
  }

  // ══ 3. walk-in path: advance SHORT of the elapsed total ═════════════════
  console.log('\n── walk-in path: advance short of the elapsed total ──')
  let walkinShortId = ''
  {
    const stationW1 = await G.mintResource('Walkin-1')
    const started = await startWalkin({
      branchId: G.branchId,
      resourceId: stationW1,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
      advanceTenders: [{ method: 'cash', amount: 100 }],
    })
    check('walk-in started via the real startWalkin action', !started.error && Boolean(started.bookingId), started.error)
    walkinShortId = started.bookingId!
    // 10-min backdate lands on the 30-min minimum: 500/hr * 0.5h = 250.00.
    await owner.query(`update booking_slots set starts_at = now() - interval '10 minutes' where booking_id = $1`, [walkinShortId])

    const closed = await checkoutWalkin({ bookingId: walkinShortId })
    check('tab closed, priced at the 30-min minimum', !closed.error && closed.total === 250, closed)

    const billed = await createInvoiceForBooking({ bookingId: walkinShortId })
    check('billed via the same bill-screen action a reserved booking uses', !billed.error && Boolean(billed.invoiceId), billed.error)
    const rows = await paymentsFor(billed.invoiceId!)
    check('₹100 advance applied, ₹150 left owing', rows.length === 1 && rows[0].amount === '100.00', rows)
    check('walk-in stays checked_in — not fully settled', (await bookingRow(walkinShortId)).status === 'checked_in')
  }

  // ══ 4. walk-in path: advance covers the elapsed total ═══════════════════
  console.log('\n── walk-in path: advance covers the elapsed total ──')
  {
    const stationW2 = await G.mintResource('Walkin-2')
    const started = await startWalkin({
      branchId: G.branchId,
      resourceId: stationW2,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
      advanceTenders: [{ method: 'cash', amount: 400 }],
    })
    check('walk-in started', !started.error && Boolean(started.bookingId), started.error)
    const bookingId = started.bookingId!
    await owner.query(`update booking_slots set starts_at = now() - interval '10 minutes' where booking_id = $1`, [bookingId])

    const closed = await checkoutWalkin({ bookingId })
    check('tab closed at the 30-min minimum', !closed.error && closed.total === 250, closed)

    const billed = await createInvoiceForBooking({ bookingId })
    check('billed', !billed.error && Boolean(billed.invoiceId), billed.error)
    const rows = await paymentsFor(billed.invoiceId!)
    check('capped at ₹250, not the ₹400 advance', rows.length === 1 && rows[0].amount === '250.00', rows)
    check('fully covered — auto-completed', (await bookingRow(bookingId)).status === 'completed')
  }

  // ══ 5. unbilled-completion refusal (#3), via the real action ════════════
  console.log('\n── unbilled-completion gate via setBookingStatus ──')
  {
    const { start, end } = nextSlot()
    const shortR = await createBooking({
      branchId: G.branchId,
      customerName: 'Amit',
      customerPhone: nextPhone(),
      source: 'staff',
      advanceTenders: [{ method: 'cash', amount: 400 }],
      slots: [{ resourceId: stationA, startsAt: start.toISOString(), endsAt: end.toISOString() }],
    })
    const complete1 = await setBookingStatus(shortR.bookingId!, 'completed')
    check('completing a NEVER-billed booking is refused when the advance falls short', Boolean(complete1.error), complete1)
    check('…naming the exact shortfall', (complete1.error ?? '').includes('600.00'))
    check('…and nothing was written', (await bookingRow(shortR.bookingId!)).status === 'confirmed')

    const { start: s2, end: e2 } = nextSlot()
    const coveredR = await createBooking({
      branchId: G.branchId,
      customerName: 'Sana',
      customerPhone: nextPhone(),
      source: 'staff',
      advanceTenders: [{ method: 'cash', amount: 1000 }],
      slots: [{ resourceId: stationA, startsAt: s2.toISOString(), endsAt: e2.toISOString() }],
    })
    const complete2 = await setBookingStatus(coveredR.bookingId!, 'completed')
    check('completing is ALLOWED once the advance covers the known total', !complete2.error, complete2)
    check('…still with no invoice ever raised', (await invoiceCountFor(coveredR.bookingId!)) === 0)
    check('…the booking row reflects it', (await bookingRow(coveredR.bookingId!)).status === 'completed')
  }

  // ══ 6. cross-tenant/cross-industry fail-closed, via the real actions ════
  console.log('\n── cross-industry fail-closed, via real action calls (no UI in the way) ──')
  {
    await signInAs(R.userId, R.slug)
    const stationR = await R.mintResource('Table-1')
    const beforeR = await bookingCount(R.tenantId)
    const { start, end } = nextSlot()
    const restBooking = await createBooking({
      branchId: R.branchId,
      customerName: 'Test',
      customerPhone: nextPhone(),
      source: 'staff',
      advanceTenders: [{ method: 'cash', amount: 500 }],
      slots: [{ resourceId: stationR, startsAt: start.toISOString(), endsAt: end.toISOString() }],
    })
    check('a restaurant tenant calling createBooking with a forged advance is refused', Boolean(restBooking.error), restBooking)
    check('…mentioning gaming-cafe, not a generic error', (restBooking.error ?? '').toLowerCase().includes('gaming-cafe'))
    check('…and no booking was written at all', (await bookingCount(R.tenantId)) === beforeR)

    const restWalkin = await startWalkin({
      branchId: R.branchId,
      resourceId: stationR,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
      advanceTenders: [{ method: 'cash', amount: 500 }],
    })
    check('a restaurant tenant cannot even reach the advance gate — walk-ins are refused outright', Boolean(restWalkin.error), restWalkin)

    await signInAs(S.userId, S.slug)
    const stationS = await S.mintResource('Room-1')
    const beforeS = await bookingCount(S.tenantId)
    const { start: ss, end: se } = nextSlot()
    const studioBooking = await createBooking({
      branchId: S.branchId,
      customerName: 'Test',
      customerPhone: nextPhone(),
      source: 'staff',
      advanceTenders: [{ method: 'cash', amount: 500 }],
      slots: [{ resourceId: stationS, startsAt: ss.toISOString(), endsAt: se.toISOString() }],
    })
    check('a recording_studio tenant calling createBooking with a forged advance is refused', Boolean(studioBooking.error), studioBooking)
    check('…and no booking was written at all', (await bookingCount(S.tenantId)) === beforeS)

    // Unlike a restaurant, a studio tenant IS allowed to walk-in at all — so
    // this specifically proves startWalkinCore's OWN advance/industry gate
    // fires (not the earlier restaurant-only walk-in block).
    const studioWalkin = await startWalkin({
      branchId: S.branchId,
      resourceId: stationS,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
      advanceTenders: [{ method: 'cash', amount: 500 }],
    })
    check('a recording_studio tenant reaches (and is refused by) the advance gate itself', Boolean(studioWalkin.error), studioWalkin)
    check('…mentioning gaming-cafe', (studioWalkin.error ?? '').toLowerCase().includes('gaming-cafe'))
    check('…and no walk-in was written at all', (await bookingCount(S.tenantId)) === beforeS)
  }

  // ══ 7. the cancellation safety net (#6), via the real action ════════════
  console.log('\n── cancellation safety net, via setBookingStatus ──')
  {
    await signInAs(G.userId, G.slug)
    const { start, end } = nextSlot()
    const r = await createBooking({
      branchId: G.branchId,
      customerName: 'Neha',
      customerPhone: nextPhone(),
      source: 'staff',
      advanceTenders: [{ method: 'cash', amount: 250 }],
      slots: [{ resourceId: stationA, startsAt: start.toISOString(), endsAt: end.toISOString() }],
    })
    const cancelled = await setBookingStatus(r.bookingId!, 'cancelled', 'Testing the cash-advance safety net')
    check('cancellation succeeds', !cancelled.error, cancelled)
    check('an unconsumed cash advance raises deposit_review_required on cancel', (await bookingRow(r.bookingId!)).deposit_review_required === true)

    // Reuse #2's OWN booking, whose advance was already folded into a real
    // invoice (advance_applied = true) when it auto-completed above —
    // proves the flag stays down across the full real lifecycle, not just
    // in a script that sets advance_applied by hand.
    const beforeCancel = await bookingRow(coveredBookingId)
    check('sanity: that booking really does have advance_applied = true already', beforeCancel.advance_applied === true)
    const cancelled2 = await setBookingStatus(coveredBookingId, 'cancelled', 'Refund correction')
    check('cancelling an already-completed, already-settled booking still succeeds', !cancelled2.error, cancelled2)
    check(
      'deposit_review_required stays false — that advance is already on a real payment record, not orphaned',
      (await bookingRow(coveredBookingId)).deposit_review_required === false,
    )
  }

  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
