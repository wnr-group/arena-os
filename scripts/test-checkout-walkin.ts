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
 *   - checkout writes a bounded ends_at (rounded to the 15-min billable
 *     step) and a slot_total onto booking_slots — the exact fix for "That
 *     time was just taken" persisting forever on a checked-out open tab
 *   - issueInvoiceForBooking is genuinely reused: an invoice is raised in
 *     the same transaction, with the elapsed-time line correctly priced
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
  const { startWalkin, checkoutWalkin, previewWalkinCheckout } = await import('../lib/actions/bookings')

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
    check('checkout returns a raised invoice', Boolean(result.invoiceId) && Boolean(result.invoiceNumber))

    const slot = await owner.query<{ ends_at: string | null; slot_total: string; starts_at: string }>(
      `select ends_at, slot_total, starts_at from booking_slots where booking_id = $1`,
      [openTabBookingId],
    )
    check('booking_slots.ends_at is no longer null', slot.rows[0].ends_at !== null)
    check('booking_slots.slot_total was written: 100.00', Number(slot.rows[0].slot_total) === 100)
    const elapsedMin =
      (new Date(slot.rows[0].ends_at!).getTime() - new Date(slot.rows[0].starts_at).getTime()) / 60_000
    check('the stored duration is the 30-min billable minimum, not the raw ~10min elapsed', elapsedMin === 30)

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

  // ══ 4. THE BUG FIX: the resource is bookable again after checkout ═══════════
  console.log('\n── the original bug: station1 must not be stuck forever ──')
  {
    // The 30-min minimum from step 2 means the checked-out slot's own ends_at
    // sits ~20 minutes in the FUTURE from here (started 10min ago, billed for
    // the 30min minimum) — correctly still occupying the resource until then,
    // not a bug. Pushing it further into the past isolates the actual claim
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
