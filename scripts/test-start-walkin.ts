/**
 * Starting a walk-in (M21 #3) — lib/booking/walkin.ts's startWalkinCore /
 * listWalkinResources, driven through the real server actions
 * (lib/actions/bookings.ts's startWalkin / listWalkinResources) exactly as
 * the chooser + WalkinStartDialog call them.
 *
 * Proves:
 *   - industry gate: a restaurant tenant is rejected even with a valid role
 *   - role gate: a role outside WALKIN_ROLES (kitchen_staff) is rejected
 *     even on a non-restaurant tenant
 *   - a walk-in is created channel='walkin', status='checked_in', with one
 *     booking_slots row
 *   - open_tab stores ends_at = null; timed stores committed_end_at and a
 *     matching ends_at
 *   - the start window (±30 min) and timed duration (30min–5hr, 30-min
 *     steps) are enforced server-side
 *   - a resource whose type has no hourly rate (a "table") or that isn't
 *     status='available' is refused
 *   - the exclusion constraint — not a separate flag — is what actually
 *     stops a genuinely overlapping walk-in on the same station
 *   - listWalkinResources reflects occupancy: a station with an active
 *     walk-in on it is no longer free; a free station with a later
 *     reservation is still free but flagged hasUpcomingBooking
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-start-walkin.ts
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
  const { startWalkin, listWalkinResources } = await import('../lib/actions/bookings')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testwalkinstart'
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

  const restaurantSlug = 'testwalkinstart-resto'
  const rt = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','restaurant')
     on conflict (slug) do update set name=excluded.name, industry='restaurant' returning id`,
    [restaurantSlug, `${restaurantSlug} co`],
  )
  const restaurantTenantId = rt.rows[0].id
  const rb = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [restaurantTenantId],
  )
  const restaurantBranchId = rb.rows[0].id

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

  // Hourly resource type + two stations.
  const hourlyType = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5',$2)
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
    [tenantId, '300.00'],
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
  const maintenanceStation = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,'Station 3','maintenance')
       on conflict (tenant_id,name) do update set status='maintenance' returning id`,
      [tenantId, branchId, hourlyType.rows[0].id],
    )
  ).rows[0].id
  // Untouched by any walk-in — only ever gets a FUTURE reserved booking
  // (step 7), so it can prove "free now but has something later" cleanly.
  const station4 = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,'Station 4','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, hourlyType.rows[0].id],
    )
  ).rows[0].id

  // A zero-rate "table" resource type — the seatTableSessionCore convention;
  // startWalkin must refuse it, same as it isn't a valid resourceId for
  // walk-ins per lib/booking/walkin.ts.
  const tableType = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table',0)
     on conflict (tenant_id,name) do update set hourly_rate=0 returning id`,
    [tenantId],
  )
  const table1 = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,'Table 1','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, tableType.rows[0].id],
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
    await owner.query('delete from booking_slots where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from bookings where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from customers where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from sequences where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
  }
  await wipe()

  let phoneSeq = 0
  const nextPhone = () => `98765${String(40000 + phoneSeq++).padStart(5, '0')}`

  // ══ 1. industry gate ═══════════════════════════════════════════════════════
  console.log('\n── industry gate ──')
  {
    await signInAs(restaurantOwnerId, restaurantSlug)
    const r = await startWalkin({
      branchId: restaurantBranchId,
      resourceId: station1, // wrong tenant entirely, but the industry gate should fire first
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check('a restaurant tenant is rejected before anything else', Boolean(r.error))
    check('…with the industry message, not a generic one', (r.error ?? '').toLowerCase().includes('walk-in'))
  }

  // ══ 2. role gate ═════════════════════════════════════════════════════════
  console.log('\n── role gate ──')
  {
    await signInAs(kitchenUserId, slug)
    const r = await startWalkin({
      branchId,
      resourceId: station1,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check('kitchen_staff (outside WALKIN_ROLES) is rejected on a non-restaurant tenant', Boolean(r.error))
  }

  await signInAs(ownerUserId, slug)

  // ══ 3. input validation ═════════════════════════════════════════════════
  console.log('\n── input validation ──')
  {
    const r = await startWalkin({
      branchId,
      resourceId: station1,
      phone: '123',
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check('an invalid phone is refused', Boolean(r.error))
  }
  {
    const r = await startWalkin({
      branchId,
      resourceId: station1,
      phone: nextPhone(),
      startAt: new Date(Date.now() + 45 * 60_000).toISOString(),
      mode: 'open_tab',
    })
    check('a start 45 minutes from now (outside ±30) is refused', Boolean(r.error))
  }
  {
    const r = await startWalkin({
      branchId,
      resourceId: station1,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'timed',
    })
    check('timed with no durationMin is refused', Boolean(r.error))
  }
  {
    const r = await startWalkin({
      branchId,
      resourceId: station1,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'timed',
      durationMin: 45, // not a multiple of 30
    })
    check('timed with a non-30-min-step duration is refused', Boolean(r.error))
  }
  {
    const r = await startWalkin({
      branchId,
      resourceId: station1,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'timed',
      durationMin: 360, // over the 5hr max
    })
    check('timed over 5 hours is refused', Boolean(r.error))
  }
  {
    const r = await startWalkin({
      branchId,
      resourceId: table1,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check('a zero-rate "table" resource is refused', Boolean(r.error))
  }
  {
    const r = await startWalkin({
      branchId,
      resourceId: maintenanceStation,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check('a resource in maintenance is refused', Boolean(r.error))
  }

  // ══ 4. a real open-tab walk-in ══════════════════════════════════════════
  console.log('\n── open tab ──')
  let openTabBookingId = ''
  {
    const phone = nextPhone()
    const r = await startWalkin({
      branchId,
      resourceId: station1,
      phone,
      name: 'Rahul',
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check('an open-tab walk-in is created', !r.error && Boolean(r.bookingId))
    check('…with a booking number in the BK-YYYYMMDD-NNN shape', /^BK-\d{8}-\d{3}$/.test(r.bookingNumber ?? ''))
    openTabBookingId = r.bookingId ?? ''

    const row = await owner.query<{
      channel: string
      billing_mode: string
      status: string
      committed_end_at: Date | null
      checked_in_at: Date | null
    }>(
      `select channel, billing_mode, status, committed_end_at, checked_in_at from bookings where id=$1`,
      [openTabBookingId],
    )
    check('…channel = walkin', row.rows[0]?.channel === 'walkin')
    check('…billing_mode = open_tab', row.rows[0]?.billing_mode === 'open_tab')
    check('…status is already checked_in', row.rows[0]?.status === 'checked_in')
    check('…checked_in_at is set', row.rows[0]?.checked_in_at !== null)
    check('…committed_end_at is null (no committed end for an open tab)', row.rows[0]?.committed_end_at === null)

    const slot = await owner.query<{ ends_at: Date | null; resource_id: string }>(
      `select ends_at, resource_id from booking_slots where booking_id=$1`,
      [openTabBookingId],
    )
    check('…exactly one booking_slots row', slot.rows.length === 1)
    check('…its ends_at is null', slot.rows[0]?.ends_at === null)
    check('…on the picked resource', slot.rows[0]?.resource_id === station1)
  }

  // ══ 5. a real timed walk-in ═════════════════════════════════════════════
  console.log('\n── timed session ──')
  {
    const startAt = new Date()
    const r = await startWalkin({
      branchId,
      resourceId: station2,
      phone: nextPhone(),
      startAt: startAt.toISOString(),
      mode: 'timed',
      durationMin: 90,
    })
    check('a timed walk-in is created', !r.error && Boolean(r.bookingId))

    const row = await owner.query<{ billing_mode: string; committed_end_at: Date }>(
      `select billing_mode, committed_end_at from bookings where id=$1`,
      [r.bookingId],
    )
    check('…billing_mode = timed', row.rows[0]?.billing_mode === 'timed')
    const committedMinutesFromStart =
      row.rows[0] && (new Date(row.rows[0].committed_end_at).getTime() - startAt.getTime()) / 60_000
    check('…committed_end_at is startAt + 90 minutes', Math.round(committedMinutesFromStart ?? -1) === 90)

    const slot = await owner.query<{ ends_at: Date }>(`select ends_at from booking_slots where booking_id=$1`, [
      r.bookingId,
    ])
    check('…the slot ends_at matches committed_end_at', slot.rows[0]?.ends_at?.getTime() === row.rows[0]?.committed_end_at?.getTime())
  }

  // ══ 6. the exclusion constraint stops a genuine overlap ═══════════════════
  console.log('\n── overlap on the same station ──')
  {
    // station1 is already occupied (open tab, step 4) — a second walk-in
    // "now" on it must overlap and be refused, via the SAME 23P01 path
    // createBooking already relies on (lib/actions/bookings.ts's fail()).
    const r = await startWalkin({
      branchId,
      resourceId: station1,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode: 'open_tab',
    })
    check('a second walk-in on the same (occupied) station is refused', Boolean(r.error))
  }

  // ══ 7. listWalkinResources reflects real occupancy ════════════════════════
  console.log('\n── free-station picker ──')
  {
    // A future RESERVED booking on station4 (otherwise untouched) — should
    // not block it from being "free right now", only flag it as having an
    // upcoming booking.
    const future = new Date(Date.now() + 4 * 60 * 60_000)
    const futureEnd = new Date(future.getTime() + 60 * 60_000)
    const futureBooking = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id, branch_id, booking_number, status)
       values ($1,$2,'BK-TESTFUTURE-001','confirmed') returning id`,
      [tenantId, branchId],
    )
    await owner.query(
      `insert into booking_slots (tenant_id, booking_id, resource_id, starts_at, ends_at, resource_name, resource_type_name)
       values ($1,$2,$3,$4,$5,'Station 4','PS5')`,
      [tenantId, futureBooking.rows[0].id, station4, future.toISOString(), futureEnd.toISOString()],
    )

    const r = await listWalkinResources(branchId)
    check('listWalkinResources succeeds', !r.error && Array.isArray(r.resources))
    const byId = new Map((r.resources ?? []).map((x) => [x.id, x]))
    check('station1 (open tab running on it) is NOT free', byId.get(station1)?.isFree === false)
    check('station2 (still inside its 90-min timed session) is NOT free', byId.get(station2)?.isFree === false)
    check('station4 (only a future reservation) IS free', byId.get(station4)?.isFree === true)
    check('…and is flagged as having an upcoming booking', byId.get(station4)?.hasUpcomingBooking === true)
    check('station1 has no upcoming-booking flag of its own', byId.get(station1)?.hasUpcomingBooking === false)
    check('a "table" resource never appears in the walk-in picker', !byId.has(table1))
    check('a maintenance station never appears in the walk-in picker', !byId.has(maintenanceStation))
  }

  // ══ 8. cross-tenant isolation ══════════════════════════════════════════════
  console.log('\n── isolation ──')
  {
    await signInAs(ownerUserId, slug)
    const other = await owner.query<{ id: string }>(`select id from bookings where tenant_id=$1 limit 1`, [
      restaurantTenantId,
    ])
    check('the restaurant tenant has no bookings of its own to leak', other.rows.length === 0)
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
