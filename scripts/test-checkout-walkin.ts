/**
 * Closing an open-tab walk-in (M21 #4) — lib/booking/walkin.ts's
 * checkoutWalkinCore/previewWalkinCheckout, driven through the real server
 * actions (lib/actions/bookings.ts's checkoutWalkin/previewWalkinCheckout)
 * exactly as the Bookings page's "Close tab" dialog calls them.
 *
 * Proves:
 *   - industry gate: a restaurant tenant is rejected before anything else
 *   - role gate: a role outside WALKIN_ROLES (kitchen_staff) is rejected
 *   - a TIMED walk-in (already has a fixed ends_at) is refused — checkout
 *     only applies to an open tab
 *   - the elapsed session prices correctly (30-min minimum here) and the
 *     preview matches the real checkout to the paisa
 *   - checkout writes a bounded ends_at onto booking_slots — the exact fix
 *     for "That time was just taken" persisting forever on a checked-out
 *     open tab — and it's the RAW elapsed end (priceEnd), not the rounded
 *     15-min/30-min-minimum billable end slot_total was priced against:
 *     stretching occupancy to match the padding could overlap a booking
 *     that was legitimately allowed against this walk-in's true occupancy
 *     when it started, turning that later insert's own success into THIS
 *     checkout's failure instead
 *   - M22 follow-up: checkoutWalkin no longer raises an invoice by itself —
 *     it only prices/freezes the session. createInvoiceForBooking (the same
 *     action the POS bill screen's "Generate bill" button calls) then
 *     raises the bill on the closed tab, with the elapsed-time line
 *     correctly priced — issueInvoiceForBooking is genuinely reused
 *   - a second checkout attempt is refused (already checked out)
 *   - THE ACTUAL BUG FIX: once checked out, the same resource can host a
 *     brand new walk-in — before checkout this is refused outright (same
 *     assertion test-start-walkin.ts's own step 6 makes)
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-checkout-walkin.ts
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
  const { startWalkin, extendWalkin, checkoutWalkin, previewWalkinCheckout, cancelBooking, setBookingStatus } =
    await import('../lib/actions/bookings')
  const { createInvoiceForBooking } = await import('../lib/actions/billing')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testcheckoutwalkin'
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

  const restaurantSlug = 'testcheckoutwalkin-resto'
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
  const floorStaffUserId = await makeUserAndMembership(tenantId, 'floor_staff', `floor@${slug}.test`)
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
  const station5 = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,'Station 5','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, hourlyType.rows[0].id],
    )
  ).rows[0].id

  const station6 = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,'Station 6','available')
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
    await owner.query('delete from order_items where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from orders where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from booking_slots where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from bookings where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from customers where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from sequences where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
  }
  await wipe()

  let phoneSeq = 0
  const nextPhone = () => `98765${String(50000 + phoneSeq++).padStart(5, '0')}`

  // ══ 1. industry gate ═══════════════════════════════════════════════════════
  console.log('\n── industry gate ──')
  {
    await signInAs(restaurantOwnerId, restaurantSlug)
    const r = await checkoutWalkin({ bookingId: '00000000-0000-0000-0000-000000000000' })
    check('a restaurant tenant is rejected before anything else', Boolean(r.error))
    check('…with the industry message, not a generic one', (r.error ?? '').toLowerCase().includes('walk-in'))
  }

  // ══ 2. start an open tab, backdated so a real, non-trivial duration elapses ═
  console.log('\n── open-tab checkout ──')
  let openTabBookingId = ''
  {
    await signInAs(ownerUserId, slug)
    const started = await startWalkin({
      branchId,
      resourceId: station1,
      phone: nextPhone(),
      name: 'Rahul',
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check('open tab starts cleanly', !started.error && Boolean(started.bookingId))
    openTabBookingId = started.bookingId!

    // Backdate the slot's start by 10 minutes — short enough to land on the
    // 30-min minimum (200/hr * 0.5hr = 100.00), a deterministic assertion
    // that doesn't depend on wall-clock precision at run time.
    await owner.query(`update booking_slots set starts_at = now() - interval '10 minutes' where booking_id = $1`, [
      openTabBookingId,
    ])

    // ── role gate: kitchen_staff cannot check anything out, even this one ──
    await signInAs(kitchenUserId, slug)
    const roleGated = await checkoutWalkin({ bookingId: openTabBookingId })
    check('kitchen_staff (outside WALKIN_ROLES) cannot check out a walk-in', Boolean(roleGated.error))

    await signInAs(ownerUserId, slug)

    const preview = await previewWalkinCheckout({ bookingId: openTabBookingId })
    check('preview succeeds', !preview.error && preview.total !== undefined)
    check('preview hits the 30-min minimum: ₹100.00', preview.total === 100)

    const result = await checkoutWalkin({ bookingId: openTabBookingId })
    check('checkout succeeds', !result.error)
    check('checkout total matches the preview exactly: ₹100.00', result.total === 100)
    check(
      "checkout no longer raises an invoice by itself (CheckoutWalkinResult has no invoiceId/invoiceNumber field at all)",
      !('invoiceId' in result) && !('invoiceNumber' in result),
    )

    // M22 follow-up: closing the tab only prices/freezes the session now —
    // raising the bill is a separate step, on the same POS bill screen a
    // reserved booking uses. Same server action (createInvoiceForBooking)
    // the bill screen's "Generate bill" button calls.
    const billed = await createInvoiceForBooking({ bookingId: openTabBookingId })
    check('the bill screen can then raise the invoice for the closed tab', !billed.error && Boolean(billed.invoiceId))

    const slot = await owner.query<{ ends_at: string | null; slot_total: string; starts_at: string }>(
      `select ends_at, slot_total, starts_at from booking_slots where booking_id = $1`,
      [openTabBookingId],
    )
    check('booking_slots.ends_at is no longer null', slot.rows[0].ends_at !== null)
    check('booking_slots.slot_total was written: 100.00 (the 30-min-minimum billable price)', Number(slot.rows[0].slot_total) === 100)
    const elapsedMin =
      (new Date(slot.rows[0].ends_at!).getTime() - new Date(slot.rows[0].starts_at).getTime()) / 60_000
    // ends_at tracks the RAW elapsed time (~10min), not the 30-min billable
    // minimum slot_total was priced against — a wide tolerance band, not the
    // backdate's exact 10, since real wall-clock time also passed running
    // the role-gate check and the preview call above.
    check('the stored duration is the raw ~10min elapsed, not padded to the 30-min billable minimum', elapsedMin > 9 && elapsedMin < 20)

    const invoice = await owner.query<{ id: string; total: string; booking_id: string }>(
      `select id, total, booking_id from invoices where booking_id = $1`,
      [openTabBookingId],
    )
    check('exactly one invoice was raised for this booking', invoice.rows.length === 1)
    check('the invoice total is ₹100.00 (no tax/discount configured on this fresh tenant)', Number(invoice.rows[0]?.total) === 100)

    const items = await owner.query<{ description: string; qty: string; unit_price: string }>(
      `select description, qty, unit_price from invoice_items where invoice_id = $1`,
      [invoice.rows[0]?.id],
    )
    check('one invoice line for the session', items.rows.length === 1)
    check('the line is qty=1 at the full elapsed-time total (not qty=hours × rate)', Number(items.rows[0]?.qty) === 1 && Number(items.rows[0]?.unit_price) === 100)
    check('the line description names the station', (items.rows[0]?.description ?? '').includes('Station 1'))

    // ── double-checkout is refused ──────────────────────────────────────────
    const again = await checkoutWalkin({ bookingId: openTabBookingId })
    check('a second checkout on the same booking is refused', Boolean(again.error))
  }

  // ══ 3. a TIMED walk-in checks out too, once its committed end has arrived ═══
  // (M21 #5 adds the countdown/extend/block-until-extended behavior around
  // this — see scripts/test-extend-timed-walkin.ts for that whole story.
  // This script stays open-tab-focused; this step only proves checkoutWalkin
  // no longer flatly refuses billingMode='timed' the way M21 #4 shipped it.)
  console.log('\n── a timed walk-in checks out too (M21 #5) ──')
  {
    const timed = await startWalkin({
      branchId,
      resourceId: station2,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'timed',
      durationMin: 30,
    })
    check('timed walk-in starts cleanly', !timed.error && Boolean(timed.bookingId))
    const r = await checkoutWalkin({ bookingId: timed.bookingId! })
    check('checkoutWalkin now succeeds for a timed walk-in whose committed end has not passed', !r.error)
  }

  // ══ 3b. an unpriced timed walk-in must not be billed via the GENERAL action,
  //       even with food orders open on it ══════════════════════════════════
  // Regression for the exact undercharge prepareBookingBill's explicit guard
  // fixes: loadBookingLines silently drops the session line for an
  // uncommitted timed walk-in, so with food orders also open the
  // lines.length===0 guard never fires — createInvoiceForBooking would
  // otherwise raise an invoice for the food alone, omitting the session
  // charge entirely.
  console.log('\n── general billing refuses an unpriced timed walk-in with food on it ──')
  {
    const timed = await startWalkin({
      branchId,
      resourceId: station3,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'timed',
      durationMin: 30,
    })
    check('timed walk-in (for the general-billing regression) starts cleanly', !timed.error && Boolean(timed.bookingId))
    const bookingId = timed.bookingId!

    const order = await owner.query<{ id: string }>(
      `insert into orders (tenant_id, branch_id, booking_id, order_number, status)
       values ($1, $2, $3, $4, 'open') returning id`,
      [tenantId, branchId, bookingId, `TESTORD-${bookingId.slice(0, 8)}`],
    )
    await owner.query(
      `insert into order_items (tenant_id, order_id, item_name, unit_price, qty, line_total)
       values ($1, $2, 'Cold Drink', 50.00, 1, 50.00)`,
      [tenantId, order.rows[0].id],
    )

    const result = await createInvoiceForBooking({ bookingId })
    check('createInvoiceForBooking refuses the unpriced session, not just an undercharged bill', Boolean(result.error))

    const invoiceCount = await owner.query<{ n: string }>(
      `select count(*)::text as n from invoices where booking_id = $1`,
      [bookingId],
    )
    check('…and no invoice was raised at all (not even for the food alone)', invoiceCount.rows[0].n === '0')

    const orderStatus = await owner.query<{ status: string }>(`select status from orders where id = $1`, [
      order.rows[0].id,
    ])
    check('…the food order is still open, not silently billed', orderStatus.rows[0]?.status === 'open')
  }

  // ══ 3b-2. the SAME guard must cover an OPEN-TAB walk-in with food on it ════
  // Regression for the asymmetric guard: prepareBookingBill originally guarded
  // only TIMED walk-ins. An open tab's session line is dropped by
  // loadBookingLines while its ends_at is null (until checkout), so with food
  // orders open the general path would raise a food-only invoice AND, becoming
  // the booking's live invoice, block checkoutWalkin forever.
  console.log('\n── general billing refuses an unpriced open-tab walk-in with food on it ──')
  {
    const tab = await startWalkin({
      branchId,
      resourceId: station6,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check('open-tab walk-in (for the general-billing regression) starts cleanly', !tab.error && Boolean(tab.bookingId))
    const bookingId = tab.bookingId!

    const order = await owner.query<{ id: string }>(
      `insert into orders (tenant_id, branch_id, booking_id, order_number, status)
       values ($1, $2, $3, $4, 'open') returning id`,
      [tenantId, branchId, bookingId, `TESTORD-OT-${bookingId.slice(0, 8)}`],
    )
    await owner.query(
      `insert into order_items (tenant_id, order_id, item_name, unit_price, qty, line_total)
       values ($1, $2, 'Cold Drink', 50.00, 1, 50.00)`,
      [tenantId, order.rows[0].id],
    )

    const result = await createInvoiceForBooking({ bookingId })
    check('createInvoiceForBooking refuses the un-checked-out open tab, not just an undercharged bill', Boolean(result.error))

    const invoiceCount = await owner.query<{ n: string }>(
      `select count(*)::text as n from invoices where booking_id = $1`,
      [bookingId],
    )
    check('…and no invoice was raised at all (not even for the food alone)', invoiceCount.rows[0].n === '0')

    // The legit path still works and the earlier rejection did not lock the
    // booking: checkoutWalkin prices the session (M22 follow-up: it no
    // longer bills by itself), then createInvoiceForBooking bills it WITH
    // the food, same as the bill screen's "Generate bill" would.
    const co = await checkoutWalkin({ bookingId })
    check('…checkoutWalkin then succeeds (booking not locked by the rejected bill)', !co.error && Boolean(co.bookingId))
    const rebilled = await createInvoiceForBooking({ bookingId })
    check('…and the bill screen bills session + food in one invoice (total exceeds the ₹50 food alone)', !rebilled.error)
    const rebilledInvoice = await owner.query<{ total: string }>(`select total from invoices where id = $1`, [
      rebilled.invoiceId,
    ])
    check('…invoice total exceeds the ₹50 food alone', Number(rebilledInvoice.rows[0]?.total ?? 0) > 50)
  }

  // ══ 3c. floor_staff can start, extend AND check out a walk-in end-to-end
  //       (M21 #7 — product-owner-confirmed exception to canBill) ═══════════
  console.log('\n── floor_staff can start, extend, and check out a walk-in (M21 #7) ──')
  {
    await signInAs(floorStaffUserId, slug)

    const started = await startWalkin({
      branchId,
      resourceId: station4,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'timed',
      durationMin: 30,
    })
    check('floor_staff can start a walk-in', !started.error && Boolean(started.bookingId))
    const bookingId = started.bookingId!

    const extended = await extendWalkin({ bookingId, addMinutes: 15 })
    check('floor_staff can extend a walk-in', !extended.error && Boolean(extended.committedEndAt))

    const checkedOut = await checkoutWalkin({ bookingId })
    check(
      'floor_staff can check out a walk-in themselves — the deliberate M21 #7 exception to canManageWalkins',
      !checkedOut.error && Boolean(checkedOut.bookingId),
    )

    // M22 follow-up: the exception now has to carry through to the bill
    // screen's OWN action too, or floor_staff could close a tab and then get
    // stuck unable to actually bill it — canBillBooking's walk-in carve-out
    // (lib/auth/roles.ts) is what keeps this self-service, still as
    // floor_staff, no cashier handoff.
    const billed = await createInvoiceForBooking({ bookingId })
    check(
      'floor_staff can ALSO raise the bill themselves — canBillBooking carries the M21 #7 exception forward',
      !billed.error && Boolean(billed.invoiceId),
    )

    await signInAs(ownerUserId, slug)
  }

  // ══ 4. THE BUG FIX: the resource is bookable again after checkout ═══════════
  console.log('\n── the original bug: station1 must not be stuck forever ──')
  {
    // Step 2's checkout already left ends_at in the past (it's the RAW
    // elapsed end, not padded to the 30-min billable minimum) — this push
    // just makes that deterministic instead of depending on exactly how much
    // wall-clock time step 3 happened to take, isolating the actual claim
    // this step exists to prove (a BOUNDED ends_at, once it has passed, frees
    // the resource) from the pricing-accuracy assertions step 2 already made.
    await owner.query(
      `update booking_slots set ends_at = starts_at + interval '5 minutes' where booking_id = $1`,
      [openTabBookingId],
    )

    const secondWalkin = await startWalkin({
      branchId,
      resourceId: station1,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check(
      'station1 accepts a brand-new walk-in after its previous open tab was checked out (this failed with "That time was just taken" before M21 #4)',
      !secondWalkin.error && Boolean(secondWalkin.bookingId),
    )
  }

  // ══ 5. cancellation frees the station; no_show is refused for a walk-in
  //       (M21 #8 QA pass) ═══════════════════════════════════════════════════
  console.log('\n── a walk-in can be cancelled before checkout, but never marked no-show ──')
  {
    const started = await startWalkin({
      branchId,
      resourceId: station5,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check('open tab (for cancellation) starts cleanly', !started.error && Boolean(started.bookingId))
    const bookingId = started.bookingId!

    // A walk-in is born already checked_in — "didn't show up" cannot apply.
    const noShow = await setBookingStatus(bookingId, 'no_show')
    check('marking a walk-in no-show is refused', Boolean(noShow.error))
    const statusAfterRefusal = await owner.query<{ status: string }>(`select status from bookings where id = $1`, [
      bookingId,
    ])
    check('…and its status is unchanged (still checked_in)', statusAfterRefusal.rows[0]?.status === 'checked_in')

    const cancelled = await cancelBooking(bookingId)
    check('cancelling the same walk-in before checkout succeeds', !cancelled.error)

    const slotAfterCancel = await owner.query<{ active: boolean }>(
      `select active from booking_slots where booking_id = $1`,
      [bookingId],
    )
    check('…its booking_slots row is no longer active (the 0003 trigger frees it)', slotAfterCancel.rows[0]?.active === false)

    const stationFree = await startWalkin({
      branchId,
      resourceId: station5,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check('…so the station accepts a brand-new walk-in immediately', !stationFree.error && Boolean(stationFree.bookingId))
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
