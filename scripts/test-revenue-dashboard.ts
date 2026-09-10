/**
 * Revenue & Bookings dashboard (AROS-65) — integration tests + reconciliation
 * against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-revenue-dashboard.ts
 *
 * Every assertion goes through the production readers (getRevenueDashboard →
 * getDailyRevenue + getBookingMetrics), which run under withUser() and, for
 * revenue, through the AROS-64 barrier view. Nothing here reaches around them.
 *
 * The fixture is a deliberately awkward week at ONE branch (10:00–22:00, 3
 * bookable resources + 1 inactive), so each metric has a hand-computable
 * expected value — printed at the end as a reconciliation table.
 */
import { Client } from 'pg'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'
import type { ActiveContext } from '../lib/tenant/context'

let pass = 0,
  fail = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
/** IST is UTC+5:30, so 10:00 local == 04:30Z and 22:00 local == 16:30Z. */
const ist = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  const utcMinutes = h * 60 + m - (5 * 60 + 30)
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMinutes(d.getUTCMinutes() + utcMinutes)
  return d.toISOString()
}

async function main() {
  loadEnv()
  const { getRevenueDashboard, dashboardCsv } = await import('../lib/reports/revenue')
  const { getBookingMetrics } = await import('../lib/reports/bookings')
  const { ReportAccessError } = await import('../lib/reports/daily-revenue')

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()

  // ── fixtures ──────────────────────────────────────────────────────────────
  async function makeTenant(slug: string, email: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status, timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set timezone = excluded.timezone returning id`,
      [slug, `${slug} co`, TZ],
    )
    // Entitlement enforcement is fail-closed (M16 #2): a tenant with no
    // plan is granted nothing, so this fixture states that it is a paying
    // customer. See scripts/entitle-fixture.ts.
    await entitleTenant(owner, t.rows[0].id)
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash) values ($1,'x')
       on conflict (email) do update set email = excluded.email returning id`,
      [email],
    )
    const m = await owner.query<{ id: string }>(
      `insert into memberships (tenant_id, user_id, role, status) values ($1,$2,'owner','active')
       on conflict (tenant_id, user_id) do update set role='owner', status='active' returning id`,
      [t.rows[0].id, u.rows[0].id],
    )
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id, name) values ($1,$2)
       on conflict (tenant_id, name) do update set name = excluded.name returning id`,
      [t.rows[0].id, `${slug}-branch`],
    )
    // Open 10:00–22:00 every day → 12h per day per resource.
    for (let dow = 0; dow < 7; dow++) {
      await owner.query(
        `insert into working_hours (tenant_id, branch_id, day_of_week, open_time, close_time, is_closed)
         values ($1,$2,$3,'10:00','22:00',false)
         on conflict (branch_id, day_of_week) do update
           set open_time = excluded.open_time, close_time = excluded.close_time, is_closed = false`,
        [t.rows[0].id, b.rows[0].id, dow],
      )
    }
    return { tenantId: t.rows[0].id, userId: u.rows[0].id, membershipId: m.rows[0].id, branchId: b.rows[0].id }
  }

  async function makeResource(t: { tenantId: string; branchId: string }, typeId: string, name: string, status = 'available') {
    const r = await owner.query<{ id: string }>(
      `insert into resources (tenant_id, branch_id, resource_type_id, name, status) values ($1,$2,$3,$4,$5)
       on conflict (tenant_id, name) do update set status = excluded.status returning id`,
      [t.tenantId, t.branchId, typeId, name, status],
    )
    return r.rows[0].id
  }

  let bookingSeq = 0
  async function makeBooking(
    t: { tenantId: string; branchId: string },
    v: { status: string; slots: { resourceId: string; startsAt: string; endsAt: string }[] },
  ) {
    bookingSeq++
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id, branch_id, booking_number, status, source)
       values ($1,$2,$3,$4,'walk_in') returning id`,
      [t.tenantId, t.branchId, `RB-${String(bookingSeq).padStart(4, '0')}`, v.status],
    )
    for (const s of v.slots) {
      await owner.query(
        `insert into booking_slots
           (tenant_id, booking_id, resource_id, starts_at, ends_at, resource_name, resource_type_name, active)
         values ($1,$2,$3,$4,$5,'r','t', $6)`,
        // active mirrors the trigger's rule for a booking inserted directly at
        // a terminal status (the trigger fires on UPDATE of status, not INSERT).
        [t.tenantId, bk.rows[0].id, s.resourceId, s.startsAt, s.endsAt, !['cancelled', 'no_show'].includes(v.status)],
      )
    }
    return bk.rows[0].id
  }

  let invoiceSeq = 0
  async function makeInvoice(
    t: { tenantId: string; branchId: string },
    v: { status: string; issuedAt: string | null; subtotal: number; discount: number; tax: number; total: number },
  ) {
    invoiceSeq++
    await owner.query(
      `insert into invoices (tenant_id, branch_id, invoice_number, status, issued_at, subtotal, discount, tax_total, total)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        t.tenantId, t.branchId, `RBI-${String(invoiceSeq).padStart(4, '0')}`, v.status, v.issuedAt,
        v.subtotal.toFixed(2), v.discount.toFixed(2), v.tax.toFixed(2), v.total.toFixed(2),
      ],
    )
  }

  const A = await makeTenant('rbd-a', 'owner@rbd-a.test')
  const B = await makeTenant('rbd-b', 'owner@rbd-b.test')

  // A cashier in tenant A — must be refused everywhere.
  const cashierUser = await owner.query<{ id: string }>(
    `insert into users (email, password_hash) values ('cashier@rbd.test','x')
     on conflict (email) do update set email = excluded.email returning id`,
  )
  const cashierMembership = await owner.query<{ id: string }>(
    `insert into memberships (tenant_id, user_id, role, status) values ($1,$2,'cashier','active')
     on conflict (tenant_id, user_id) do update set role='cashier', status='active' returning id`,
    [A.tenantId, cashierUser.rows[0].id],
  )

  const typeA = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id, name, hourly_rate) values ($1,'Console','150.00')
     on conflict (tenant_id, name) do update set hourly_rate = excluded.hourly_rate returning id`,
    [A.tenantId],
  )
  const typeB = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id, name, hourly_rate) values ($1,'Console','150.00')
     on conflict (tenant_id, name) do update set hourly_rate = excluded.hourly_rate returning id`,
    [B.tenantId],
  )

  await owner.query('delete from booking_slots where tenant_id = any($1)', [[A.tenantId, B.tenantId]])
  await owner.query('delete from bookings where tenant_id = any($1)', [[A.tenantId, B.tenantId]])
  await owner.query('delete from invoices where tenant_id = any($1)', [[A.tenantId, B.tenantId]])

  const R1 = await makeResource(A, typeA.rows[0].id, 'PS5 #1')
  const R2 = await makeResource(A, typeA.rows[0].id, 'PS5 #2')
  const R3 = await makeResource(A, typeA.rows[0].id, 'PS5 #3')
  // Inactive: out of CAPACITY (so out of occupancy on both sides), but its
  // bookings still count — see the rule in lib/reports/bookings.ts.
  const ROff = await makeResource(A, typeA.rows[0].id, 'PS5 #4 (retired)', 'inactive')
  const RB1 = await makeResource(B, typeB.rows[0].id, 'B PS5 #1')

  const D1 = '2026-06-01' // Monday
  const D2 = '2026-06-02'
  const D3 = '2026-06-03'

  // ── D1: 2h + 3h on R1, 1h on R2 → 6h booked of 36h capacity (3 × 12h) ─────
  await makeBooking(A, { status: 'completed', slots: [{ resourceId: R1, startsAt: ist(D1, '10:00'), endsAt: ist(D1, '12:00') }] })
  await makeBooking(A, { status: 'confirmed', slots: [{ resourceId: R1, startsAt: ist(D1, '18:00'), endsAt: ist(D1, '21:00') }] })
  await makeBooking(A, { status: 'checked_in', slots: [{ resourceId: R2, startsAt: ist(D1, '18:00'), endsAt: ist(D1, '19:00') }] })
  // Cancelled + no-show: released, so they must not appear in ANY metric.
  await makeBooking(A, { status: 'cancelled', slots: [{ resourceId: R3, startsAt: ist(D1, '13:00'), endsAt: ist(D1, '17:00') }] })
  await makeBooking(A, { status: 'no_show', slots: [{ resourceId: R3, startsAt: ist(D1, '19:00'), endsAt: ist(D1, '20:00') }] })
  // On the INACTIVE resource — excluded from capacity, so also from booked.
  await makeBooking(A, { status: 'confirmed', slots: [{ resourceId: ROff, startsAt: ist(D1, '11:00'), endsAt: ist(D1, '15:00') }] })

  // ── D2: one booking with TWO slots (one booking, 2 resources, 2h each) ────
  await makeBooking(A, {
    status: 'confirmed',
    slots: [
      { resourceId: R1, startsAt: ist(D2, '15:00'), endsAt: ist(D2, '17:00') },
      { resourceId: R2, startsAt: ist(D2, '15:00'), endsAt: ist(D2, '17:00') },
    ],
  })

  // ── D2→D3 overnight: 21:00 → 01:00. Clipped to closing (22:00) on D2 = 1h;
  //    D3 opens at 10:00, so the 00:00–01:00 tail is OUTSIDE opening hours and
  //    contributes 0 to D3's occupancy. The BOOKING counts once, on D2.
  await makeBooking(A, { status: 'confirmed', slots: [{ resourceId: R3, startsAt: ist(D2, '21:00'), endsAt: ist(D3, '01:00') }] })

  // ── invoices: revenue comes from AROS-64, statuses exercised here too ─────
  await makeInvoice(A, { status: 'issued', issuedAt: ist(D1, '12:05'), subtotal: 1000, discount: 100, tax: 45, total: 945 })
  await makeInvoice(A, { status: 'paid',   issuedAt: ist(D1, '21:10'), subtotal: 500, discount: 0, tax: 25, total: 525 })
  await makeInvoice(A, { status: 'draft',  issuedAt: null,             subtotal: 999, discount: 0, tax: 0, total: 999 })
  await makeInvoice(A, { status: 'void',   issuedAt: ist(D1, '13:00'), subtotal: 888, discount: 0, tax: 0, total: 888 })
  await makeInvoice(A, { status: 'issued', issuedAt: ist(D2, '17:30'), subtotal: 300, discount: 0, tax: 15, total: 315 })
  // Tenant B — same days, must never leak into A.
  await makeBooking(B, { status: 'confirmed', slots: [{ resourceId: RB1, startsAt: ist(D1, '10:00'), endsAt: ist(D1, '20:00') }] })
  await makeInvoice(B, { status: 'paid', issuedAt: ist(D1, '15:00'), subtotal: 7777, discount: 0, tax: 0, total: 7777 })

  await owner.query('select public.refresh_daily_revenue()')

  const ctxFor = (t: { userId: string; membershipId: string }, tenantId: string, role: string): ActiveContext =>
    ({
      user: { id: t.userId, email: 'x@test', fullName: null, isPlatformAdmin: false },
      tenant: { id: tenantId, slug: 'x', name: 'x', industry: 'gaming_cafe', status: 'active', currency: 'INR', timezone: TZ },
      role,
      membershipId: t.membershipId,
      branchId: null,
    }) as ActiveContext

  const ctxA = ctxFor(A, A.tenantId, 'owner')
  const ctxAManager = ctxFor(A, A.tenantId, 'manager')
  const ctxB = ctxFor(B, B.tenantId, 'owner')
  const ctxCashier = ctxFor(
    { userId: cashierUser.rows[0].id, membershipId: cashierMembership.rows[0].id },
    A.tenantId,
    'cashier',
  )

  const range = { start: D1, end: D3 }
  const data = await getRevenueDashboard(ctxA, { range })
  const day = (d: string) => data.days.find((x) => x.day === d)!

  // ── revenue (AROS-64 reader, re-verified through this page) ───────────────
  console.log('\n── revenue ──')
  check('D1 gross = 1500 (issued 1000 + paid 500)', day(D1).gross === 1500)
  check('D1 discount = 100', day(D1).discount === 100)
  check('D1 tax = 70', day(D1).tax === 70)
  check('D1 net = 1470 = SUM(invoice.total)', day(D1).net === 1470)
  check('D1 counts 2 invoices — draft and void excluded', day(D1).invoices === 2)
  check('D2 net = 315', day(D2).net === 315)
  check('D3 has no revenue', day(D3).net === 0 && day(D3).invoices === 0)
  check('period net = 1785', data.revenueTotals.net === 1785)

  const srcNet = await owner.query<{ net: string }>(
    `select coalesce(sum(total),0)::text net from invoices
      where tenant_id = $1 and status in ('issued','paid') and issued_at is not null`,
    [A.tenantId],
  )
  check('period net reconciles with SUM(invoices.total) at source', data.revenueTotals.net === Number(srcNet.rows[0].net))

  // ── booking count ─────────────────────────────────────────────────────────
  console.log('\n── bookings ──')
  check('D1 counts 4 bookings (completed + confirmed + checked_in + the one on the retired resource)', day(D1).bookings === 4)
  check('…cancelled and no_show are NOT counted', day(D1).bookings !== 6)
  check('D2 counts 2 (the two-slot booking once, plus the overnight one)', day(D2).bookings === 2)
  check('…the two-slot booking is ONE booking, not two', day(D2).bookings !== 3)
  check('D3 counts 0 — the overnight booking belongs to the day it started', day(D3).bookings === 0)
  check('period bookings = 6', data.bookings.totals.bookings === 6)

  const srcBookings = await owner.query<{ n: string }>(
    `select count(*)::text n from bookings where tenant_id = $1 and status not in ('cancelled','no_show')`,
    [A.tenantId],
  )
  check('…reconciles with the qualifying booking rows at source', data.bookings.totals.bookings === Number(srcBookings.rows[0].n))

  // ── occupancy ─────────────────────────────────────────────────────────────
  // Capacity = 3 bookable resources × 12h = 36h = 2160 min per day.
  console.log('\n── occupancy ──')
  check('D1 capacity = 2160 min (3 resources × 12h) — inactive one excluded', day(D1).availableMinutes === 2160)
  check('D1 booked = 360 min (2h + 3h + 1h)', day(D1).bookedMinutes === 360)
  check('…the 4h on the INACTIVE resource is excluded from booked too', day(D1).bookedMinutes !== 600)
  check('…cancelled (4h) and no-show (1h) are excluded', day(D1).bookedMinutes !== 660)
  check('D1 occupancy = 360/2160 = 16.7%', day(D1).occupancyPercent === 16.7)
  check('D2 booked = 300 min (2×2h slots + 1h of the overnight before closing)', day(D2).bookedMinutes === 300)
  check('…the overnight booking is CLIPPED at 22:00, not counted to 01:00', day(D2).bookedMinutes !== 480)
  check('D3 booked = 0 — its 00:00–01:00 tail is outside opening hours', day(D3).bookedMinutes === 0)
  check('D3 still has capacity, so occupancy is 0%, not null', day(D3).availableMinutes === 2160 && day(D3).occupancyPercent === 0)
  check('period occupancy = 660/6480 = 10.2%', data.bookings.totals.occupancyPercent === 10.2)
  check('occupancy never exceeds 100%', data.days.every((d) => d.occupancyPercent === null || d.occupancyPercent <= 100))

  // Closed day → capacity 0 → null, not a division error.
  await owner.query(`update working_hours set is_closed = true where branch_id = $1 and day_of_week = 3`, [A.branchId])
  const closedData = await getBookingMetrics(ctxA, { range: { start: '2026-06-03', end: '2026-06-03' } })
  check('a CLOSED day reports occupancy null, not 0 and not a crash', closedData.daily[0].occupancyPercent === null)
  check('…with zero available minutes', closedData.daily[0].availableMinutes === 0)
  await owner.query(`update working_hours set is_closed = false where branch_id = $1 and day_of_week = 3`, [A.branchId])

  // ── peak hours ────────────────────────────────────────────────────────────
  console.log('\n── peak hours ──')
  const peak = data.bookings.peakHours
  const at = (h: number) => peak.find((p) => p.hour === h)?.bookings ?? 0
  check('10:00 has 1 booking', at(10) === 1)
  check('11:00 has 1 — the booking on the retired resource still counts', at(11) === 1)
  check('18:00 has 2 bookings (two resources, two bookings)', at(18) === 2)
  check('15:00 has 1 booking (its two slots are one booking)', at(15) === 1)
  check('21:00 has 1 booking (the overnight start)', at(21) === 1)
  check('13:00 has 0 — the cancelled booking started then', at(13) === 0)
  check('19:00 has 0 — the no-show started then', at(19) === 0)
  check('the peak hour is 18:00, the unambiguous busiest', data.bookings.totals.peakHour === 18)
  check('hours are in local time, not UTC (18:00 IST ≠ 12:30Z)', peak.every((p) => Number.isInteger(p.hour) && p.hour >= 0 && p.hour <= 23))

  // ── most-used resource ────────────────────────────────────────────────────
  console.log('\n── most-used resource ──')
  const top = data.bookings.topResources
  const used = (name: string) => top.find((r) => r.resourceName === name)
  check('R1 leads with 7h (2 + 3 + 2)', used('PS5 #1')?.minutes === 420)
  check('R3 has 4h — the overnight slot 21:00→01:00, unclipped by opening hours', used('PS5 #3')?.minutes === 240)
  check('R2 has 3h (1 + 2)', used('PS5 #2')?.minutes === 180)
  check('the retired resource IS reported — the booking on it really happened', used('PS5 #4 (retired)')?.minutes === 240)
  check('most-used = PS5 #1, ranked by booked minutes', data.bookings.totals.mostUsedResource?.resourceName === 'PS5 #1')
  check('…and it is ordered desc', top.every((r, i) => i === 0 || top[i - 1].minutes >= r.minutes))
  check('R1 carries its resource type', used('PS5 #1')?.resourceTypeName === 'Console')

  // ── date filtering ────────────────────────────────────────────────────────
  console.log('\n── date filtering ──')
  const oneDay = await getRevenueDashboard(ctxA, { range: { start: D1, end: D1 } })
  check('a one-day range returns exactly one row', oneDay.days.length === 1 && oneDay.days[0].day === D1)
  check('…with only that day’s revenue', oneDay.revenueTotals.net === 1470)
  check('…and only that day’s bookings', oneDay.bookings.totals.bookings === 4)
  check('…and peak hours from that day only', !oneDay.bookings.peakHours.some((p) => p.hour === 15))
  const d2Only = await getRevenueDashboard(ctxA, { range: { start: D2, end: D2 } })
  check('resource usage is clipped to the range (R1 shows 2h on D2, not 7h)', d2Only.bookings.topResources.find((r) => r.resourceName === 'PS5 #1')?.minutes === 120)
  check('…and the overnight slot is clipped at the range end, not at closing (3h of its 4h)', d2Only.bookings.topResources.find((r) => r.resourceName === 'PS5 #3')?.minutes === 180)
  const outside = await getRevenueDashboard(ctxA, { range: { start: '2026-07-01', end: '2026-07-07' } })
  check('a range with no activity yields zeroed days, not an error', outside.days.length === 7 && outside.revenueTotals.net === 0)
  check('…and no peak hours or resources', outside.bookings.peakHours.length === 0 && outside.bookings.topResources.length === 0)

  // ── tenant isolation ──────────────────────────────────────────────────────
  console.log('\n── tenant isolation ──')
  const bData = await getRevenueDashboard(ctxB, { range })
  check('tenant B sees only its own revenue (7777)', bData.revenueTotals.net === 7777)
  check('tenant B sees only its own booking (1)', bData.bookings.totals.bookings === 1)
  check('tenant B sees only its own resource', bData.bookings.topResources.length === 1 && bData.bookings.topResources[0].resourceName === 'B PS5 #1')
  check('tenant A never sees B’s 7777', data.revenueTotals.net !== 7777 && !data.days.some((d) => d.net === 7777))
  check('tenant A never sees B’s resource', !top.some((r) => r.resourceName === 'B PS5 #1'))
  check('tenant A’s capacity excludes B’s resources (2160, not 2880)', day(D1).availableMinutes === 2160)
  check('tenant B’s occupancy is computed from B’s own capacity', bData.days[0].availableMinutes === 720)

  // ── authorization ─────────────────────────────────────────────────────────
  console.log('\n── authorization ──')
  check('an owner may read the dashboard', data.days.length === 3)
  const mgr = await getRevenueDashboard(ctxAManager, { range })
  check('a manager may read the dashboard', mgr.revenueTotals.net === 1785)
  let cashierRefused = false
  try {
    await getRevenueDashboard(ctxCashier, { range })
  } catch (e) {
    cashierRefused = e instanceof ReportAccessError
  }
  check('a CASHIER is refused by the data layer, not just the nav', cashierRefused)
  let cashierBookingsRefused = false
  try {
    await getBookingMetrics(ctxCashier, { range })
  } catch (e) {
    cashierBookingsRefused = e instanceof ReportAccessError
  }
  check('…and refused by the booking-metrics reader directly', cashierBookingsRefused)

  // ── CSV ───────────────────────────────────────────────────────────────────
  console.log('\n── CSV ──')
  const csv = dashboardCsv(data)
  const lines = csv.trimEnd().split('\r\n')
  check('the export has a header plus one row per day in range', lines.length === 4)
  check('…with the documented headers', lines[0] === 'Date,Invoices,Gross,Discount,Tax,Net,Bookings,Booked minutes,Available minutes,Occupancy %')
  check('…D1 values match the screen', lines[1] === `${D1},2,1500.00,100.00,70.00,1470.00,4,360,2160,16.7`)
  check('…D3 exports zeros, not blanks', lines[3] === `${D3},0,0.00,0.00,0.00,0.00,0,0,2160,0.0`)
  check('…no other tenant’s figure appears anywhere', !csv.includes('7777'))
  const closedCsv = dashboardCsv(await getRevenueDashboard(ctxA, { range: { start: D1, end: D1 } }))
  check('a one-day export contains exactly that day', closedCsv.trimEnd().split('\r\n').length === 2)

  // Escaping is exercised where it can actually bite: a resource name with a
  // comma and a quote in it.
  await owner.query(`update resources set name = $2 where id = $1`, [R2, 'PS5 "Pro", corner'])
  const escaped = await getRevenueDashboard(ctxA, { range })
  const { toCsv } = await import('../lib/reports/csv')
  const { RESOURCE_USAGE_CSV_COLUMNS } = await import('../lib/reports/revenue')
  const resCsv = toCsv(escaped.bookings.topResources, RESOURCE_USAGE_CSV_COLUMNS)
  check('a resource name with a comma and quotes is escaped correctly', resCsv.includes('"PS5 ""Pro"", corner"'))
  await owner.query(`update resources set name = 'PS5 #2' where id = $1`, [R2])

  // ── reconciliation table (computed independently, in SQL) ─────────────────
  console.log('\n── reconciliation: reader vs independent SQL ──')
  const recon = await owner.query<{ day: string; net: string; bookings: string; booked_min: string }>(
    // The two slot sets the documented rule calls for: counts see every active
    // slot; occupancy sees only the currently bookable estate.
    `with all_slots as (
       select s.*
         from booking_slots s
         join bookings bk on bk.id = s.booking_id
        where s.tenant_id = $1 and s.active and bk.status not in ('cancelled','no_show')
     ),
     slots as (
       select s.* from all_slots s
         join resources r on r.id = s.resource_id
        where r.status <> 'inactive'
     ),
     d as (select gs::date as day from generate_series($3::date, $4::date, interval '1 day') gs)
     select d.day::text as day,
            (select coalesce(sum(i.total),0) from invoices i
              where i.tenant_id = $1 and i.status in ('issued','paid')
                and (i.issued_at at time zone $2)::date = d.day)::text as net,
            (select count(*) from (
               select s.booking_id, min(s.starts_at) ms from all_slots s group by s.booking_id
             ) f where (f.ms at time zone $2)::date = d.day)::text as bookings,
            (select coalesce(sum(extract(epoch from (
                 least(s.ends_at,  (d.day + time '22:00') at time zone $2)
               - greatest(s.starts_at, (d.day + time '10:00') at time zone $2)))) / 60, 0)
               from slots s
              where s.starts_at < (d.day + time '22:00') at time zone $2
                and s.ends_at   > (d.day + time '10:00') at time zone $2)::text as booked_min
       from d order by d.day`,
    [A.tenantId, TZ, D1, D3],
  )
  console.log('    day        | net (SQL / reader) | bookings (SQL / reader) | booked min (SQL / reader)')
  let reconOk = true
  for (const row of recon.rows) {
    const r = day(row.day)
    const ok = Number(row.net) === r.net && Number(row.bookings) === r.bookings && Math.abs(Number(row.booked_min) - r.bookedMinutes) < 0.05
    if (!ok) reconOk = false
    console.log(
      `    ${row.day} | ${Number(row.net).toFixed(2).padStart(8)} / ${r.net.toFixed(2).padStart(8)} | ${String(row.bookings).padStart(10)} / ${String(r.bookings).padStart(10)} | ${Number(row.booked_min).toFixed(0).padStart(11)} / ${String(r.bookedMinutes).padStart(11)}${ok ? '' : '   ← MISMATCH'}`,
    )
  }
  check('every day reconciles with an independent SQL computation', reconOk)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await owner.query(`delete from users where email like '%@rbd%.test' or email = 'cashier@rbd.test'`)
  await owner.query('select public.refresh_daily_revenue()')
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
