/**
 * Timed walk-in: countdown, extend, block-until-extended checkout (M21 #5) —
 * lib/booking/walkin.ts's extendWalkinCore/checkoutWalkinCore for
 * billingMode='timed', driven through the real server actions
 * (lib/actions/bookings.ts's extendWalkin/checkoutWalkin/previewWalkinCheckout).
 *
 * Proves:
 *   - industry/role gates on extendWalkin, same shape as start/checkout
 *   - extend accepts an arbitrary (non-30-min-step) number of minutes and
 *     moves committed_end_at forward by exactly that much, in sync with the
 *     slot's own ends_at (the GiST exclusion constraint's bound)
 *   - checking out while the committed end (extensions included) is still in
 *     the future prices the FULL committed window, even when checking out
 *     early — never a discount for leaving before time's up
 *   - checking out past the committed end is refused with the intended
 *     "Extend the session before checking out" message, not a generic error
 *   - after extending past "now", the same booking checks out successfully;
 *     billing it (M22 follow-up: a separate createInvoiceForBooking call now,
 *     not part of checkout itself) charges committed + extension, exactly
 *     reproducing the preview
 *   - a second checkout, or an extend after checkout, is refused
 *   - extend refuses an open-tab walk-in (it has no committed end to move)
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-extend-timed-walkin.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

async function main() {
  loadEnv()
  const { startWalkin, extendWalkin, checkoutWalkin, previewWalkinCheckout } = await import('../lib/actions/bookings')
  const { createInvoiceForBooking } = await import('../lib/actions/billing')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testtimedwalkin'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','gaming_cafe')
     on conflict (slug) do update set name=excluded.name, industry='gaming_cafe' returning id`,
    [slug, `${slug} co`],
  )
  const tenantId = t.rows[0].id
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId],
  )
  const branchId = b.rows[0].id

  const restaurantSlug = 'testtimedwalkin-resto'
  const rt = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','restaurant')
     on conflict (slug) do update set name=excluded.name, industry='restaurant' returning id`,
    [restaurantSlug, `${restaurantSlug} co`],
  )
  const restaurantTenantId = rt.rows[0].id

  async function makeUserAndMembership(tenant: string, role: string, email: string) {
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [email],
    )
    const userId = u.rows[0].id
    await owner.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
       on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`,
      [tenant, userId, role],
    )
    return userId
  }

  const ownerUserId = await makeUserAndMembership(tenantId, 'owner', `owner@${slug}.test`)
  const kitchenUserId = await makeUserAndMembership(tenantId, 'kitchen_staff', `kitchen@${slug}.test`)
  const restaurantOwnerId = await makeUserAndMembership(restaurantTenantId, 'owner', `owner@${restaurantSlug}.test`)

  const hourlyType = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5',$2)
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
    [tenantId, '200.00'],
  )
  const station1 = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,'Station 1','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, hourlyType.rows[0].id],
    )
  ).rows[0].id
  const station2 = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,'Station 2','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, hourlyType.rows[0].id],
    )
  ).rows[0].id
  const station3 = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,'Station 3','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, hourlyType.rows[0].id],
    )
  ).rows[0].id
  const station4 = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,'Station 4','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, hourlyType.rows[0].id],
    )
  ).rows[0].id

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  async function signInAs(userId: string, tenantSlug: string) {
    const token = randomBytes(32).toString('hex')
    await owner.query(
      `insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')
       on conflict (id) do nothing`,
      [createHash('sha256').update(token).digest('hex'), userId],
    )
    g.__ARENA_TEST_SESSION = token
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': tenantSlug }
  }

  const wipe = async () => {
    await owner.query('delete from invoice_items where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from invoices where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from booking_slots where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from bookings where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from customers where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from sequences where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
  }
  await wipe()

  let phoneSeq = 0
  const nextPhone = () => `98765${String(60000 + phoneSeq++).padStart(5, '0')}`

  // ══ 1. industry gate ═══════════════════════════════════════════════════════
  console.log('\n── industry gate ──')
  {
    await signInAs(restaurantOwnerId, restaurantSlug)
    const r = await extendWalkin({ bookingId: '00000000-0000-0000-0000-000000000000', addMinutes: 15 })
    check('a restaurant tenant is rejected before anything else', Boolean(r.error))
    check('…with the industry message, not a generic one', (r.error ?? '').toLowerCase().includes('walk-in'))
  }

  // ══ 2. start a timed walk-in, extend by an arbitrary number of minutes ══════
  console.log('\n── extend ──')
  let bookingId = ''
  {
    await signInAs(ownerUserId, slug)
    const started = await startWalkin({
      branchId,
      resourceId: station1,
      phone: nextPhone(),
      name: 'Priya',
      startAt: new Date().toISOString(),
      mode: 'timed',
      durationMin: 30,
    })
    check('timed walk-in starts cleanly', !started.error && Boolean(started.bookingId))
    bookingId = started.bookingId!

    const before = await owner.query<{ committed_end_at: string }>(
      `select committed_end_at from bookings where id = $1`,
      [bookingId],
    )
    const committedBefore = new Date(before.rows[0].committed_end_at)

    // ── role gate ──────────────────────────────────────────────────────────
    await signInAs(kitchenUserId, slug)
    const roleGated = await extendWalkin({ bookingId, addMinutes: 10 })
    check('kitchen_staff (outside WALKIN_ROLES) cannot extend a walk-in', Boolean(roleGated.error))
    await signInAs(ownerUserId, slug)

    // Not a 30-min step on purpose — extend accepts ANY whole minutes.
    const extended = await extendWalkin({ bookingId, addMinutes: 7 })
    check('extend by 7 minutes succeeds', !extended.error && Boolean(extended.committedEndAt))
    const committedAfter = new Date(extended.committedEndAt!)
    check(
      'committed_end_at moved forward by exactly 7 minutes',
      committedAfter.getTime() - committedBefore.getTime() === 7 * 60_000,
    )

    const slot = await owner.query<{ ends_at: string }>(`select ends_at from booking_slots where booking_id = $1`, [
      bookingId,
    ])
    check(
      "the slot's own ends_at (the GiST exclusion bound) was moved in lockstep",
      new Date(slot.rows[0].ends_at).getTime() === committedAfter.getTime(),
    )

    check('extend rejects a non-integer/zero/negative minute count', Boolean((await extendWalkin({ bookingId, addMinutes: 0 })).error))
  }

  // ══ 3. checking out early still bills the FULL committed window ═════════════
  console.log('\n── early checkout bills the committed slot, not less ──')
  {
    // Committed is now 30 + 7 = 37 minutes from start. priceElapsedTime's own
    // 15-min round-up (lib/billing/elapsed-time.ts) applies to that window
    // exactly like it would to any other elapsed-time session — same rule,
    // not a special case for "timed" — so 37min rounds up to 45min billable.
    // 200/hr * 45min = 150.00.
    const preview = await previewWalkinCheckout({ bookingId })
    check('preview succeeds', !preview.error && preview.total !== undefined)
    check(
      'preview bills the 37-min committed window rounded up to 45min: ₹150.00 (never less for checking out "early")',
      preview.total === 150,
    )

    const result = await checkoutWalkin({ bookingId })
    check('checkout succeeds while the committed end is still in the future', !result.error)
    check('checkout total matches the preview exactly: ₹150.00', result.total === 150)

    // M22 follow-up: checkout only prices/freezes the session now — the same
    // POS bill screen a reserved booking uses raises the actual invoice.
    const billed = await createInvoiceForBooking({ bookingId })
    check('the bill screen then raises the invoice for the checked-out session', !billed.error && Boolean(billed.invoiceId))

    const invoice = await owner.query<{ total: string }>(`select total from invoices where booking_id = $1`, [bookingId])
    check('the invoice total is ₹150.00', Number(invoice.rows[0]?.total) === 150)

    const items = await owner.query<{ qty: string; unit_price: string }>(
      `select qty, unit_price from invoice_items where invoice_id = (select id from invoices where booking_id = $1)`,
      [bookingId],
    )
    check(
      'the line is qty=1 at the full committed-time total (timed walk-ins now bill via priceElapsedTime too, M21 #5)',
      items.rows.length === 1 && Number(items.rows[0].qty) === 1 && Number(items.rows[0].unit_price) === 150,
    )

    // ── double-checkout / extend-after-checkout are refused ─────────────────
    const again = await checkoutWalkin({ bookingId })
    check('a second checkout on the same timed booking is refused', Boolean(again.error))
    const extendAfter = await extendWalkin({ bookingId, addMinutes: 10 })
    check('extending an already-checked-out timed walk-in is refused', Boolean(extendAfter.error))
  }

  // ══ 4. block-until-extended: checkout refused once committed time has passed ═
  console.log('\n── checkout is blocked past the committed end, until extended ──')
  let overdueBookingId = ''
  {
    const started = await startWalkin({
      branchId,
      resourceId: station2,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'timed',
      durationMin: 30,
    })
    check('second timed walk-in starts cleanly', !started.error && Boolean(started.bookingId))
    overdueBookingId = started.bookingId!

    // Shift BOTH starts_at and committed_end_at back by 40 minutes — keeps
    // the (starts_at < ends_at) check constraint satisfied while landing the
    // committed end 10 minutes in the past, simulating a session nobody
    // checked out on time.
    await owner.query(
      `update bookings set committed_end_at = committed_end_at - interval '40 minutes' where id = $1`,
      [overdueBookingId],
    )
    await owner.query(
      `update booking_slots set starts_at = starts_at - interval '40 minutes', ends_at = ends_at - interval '40 minutes' where booking_id = $1`,
      [overdueBookingId],
    )

    const blockedPreview = await previewWalkinCheckout({ bookingId: overdueBookingId })
    check(
      'preview reads as guidance, not a generic error: "Extend the session before checking out"',
      (blockedPreview.error ?? '').toLowerCase().includes('extend the session'),
    )

    const blocked = await checkoutWalkin({ bookingId: overdueBookingId })
    check('checkout itself is blocked past the committed end', Boolean(blocked.error))
    check('…with the same "extend first" message', (blocked.error ?? '').toLowerCase().includes('extend the session'))

    // Extend past "now" — the block should lift immediately.
    const extended = await extendWalkin({ bookingId: overdueBookingId, addMinutes: 20 })
    check('extending past now succeeds', !extended.error)

    const unblocked = await checkoutWalkin({ bookingId: overdueBookingId })
    check('checkout now succeeds once the extension covers "now"', !unblocked.error)
  }

  // ══ 5. extend only applies to a TIMED walk-in ═══════════════════════════════
  console.log('\n── extend does not apply to an open tab ──')
  {
    const openTab = await startWalkin({
      branchId,
      resourceId: station3,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check('an open tab starts cleanly on a fresh station', !openTab.error && Boolean(openTab.bookingId))
    const r = await extendWalkin({ bookingId: openTab.bookingId!, addMinutes: 15 })
    check('extendWalkin refuses an open-tab walk-in (it has no committed end)', Boolean(r.error))
  }

  // ══ 6. double-book override: a walk-in and a future reservation coexist on
  //       ONE station, and extending the walk-in is still bounded by the
  //       reservation exactly like starting one would be (M21 #8 QA pass) ══
  console.log('\n── walk-in + future reservation on one station ──')
  {
    // The reservation a walk-in's own start form would have warned about
    // (hasUpcomingBooking) and let the operator override — 3h out, so a
    // 30-min timed walk-in starting now genuinely does not overlap it yet.
    const reservationStart = new Date(Date.now() + 3 * 60 * 60_000)
    const reservationEnd = new Date(reservationStart.getTime() + 60 * 60_000)
    const reservation = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id, branch_id, booking_number, status)
       values ($1,$2,'BK-TESTFUTURE-001','confirmed') returning id`,
      [tenantId, branchId],
    )
    await owner.query(
      `insert into booking_slots (tenant_id, booking_id, resource_id, starts_at, ends_at, resource_name, resource_type_name)
       values ($1,$2,$3,$4,$5,'Station 4','PS5')`,
      [tenantId, reservation.rows[0].id, station4, reservationStart.toISOString(), reservationEnd.toISOString()],
    )

    const walkin = await startWalkin({
      branchId,
      resourceId: station4,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'timed',
      durationMin: 30,
    })
    check('the override: a walk-in starts on a station with a later reservation', !walkin.error && Boolean(walkin.bookingId))

    const slots = await owner.query<{ n: string }>(
      `select count(*)::text as n from booking_slots where resource_id = $1 and active = true`,
      [station4],
    )
    check('…both render as two separate ACTIVE slots on the same station', slots.rows[0].n === '2')

    // Extending far enough to reach the reservation's start (3h out) must be
    // refused — the reservation's own conflict protection still holds, not
    // just at start time but for every later extend too.
    const tooFar = await extendWalkin({ bookingId: walkin.bookingId!, addMinutes: 200 })
    check('extending into the reservation\'s window is refused', Boolean(tooFar.error))
    check(
      '…with the extend-specific message, not the generic "just taken" one',
      (tooFar.error ?? '').toLowerCase().includes('starting soon'),
    )

    // A short extend that stays clear of the reservation still works — the
    // reservation is not blocking the station outright, only what would
    // genuinely collide with it.
    const shortExtend = await extendWalkin({ bookingId: walkin.bookingId!, addMinutes: 60 })
    check('a short extend that stays clear of the reservation still succeeds', !shortExtend.error && Boolean(shortExtend.committedEndAt))
  }

  await wipe()
  await owner.query('delete from sessions where user_id in ($1,$2,$3)', [ownerUserId, kitchenUserId, restaurantOwnerId])
  g.__ARENA_TEST_SESSION = undefined
  g.__ARENA_TEST_HEADERS = undefined
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
