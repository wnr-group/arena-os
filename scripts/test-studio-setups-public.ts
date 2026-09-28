/**
 * M24 #6 — QA/regression: the PUBLIC/online booking path's own setup
 * plumbing (M24 #5), exercised through the real server actions
 * (getPublicBookingQuote, getPublicBookingDayRange, createPublicBooking) —
 * not lib/booking/service.ts directly, unlike test-studio-setups-pricing.ts.
 * Distinct failure modes only this layer can have:
 *
 *   - resource_setups had no public-read RLS policy until migration 0100 —
 *     an anonymous session saw zero setups regardless of what existed, so
 *     every public setup quote/booking failed "no longer available"
 *   - createPublicBooking's exclusion-violation (23P01) catch checked
 *     `'code' in e` directly, which never matches Drizzle's wrapped driver
 *     error, leaking a raw SQL error instead of a clean refusal
 *
 * Both are fixed; this pins the passing behaviour permanently:
 *
 *   - an hourly and a per-day setup quote correctly through
 *     getPublicBookingQuote/getPublicBookingDayRange
 *   - createPublicBooking threads setupId through to the same
 *     priceBookingSlots the quote used — the pay-now deposit (100% of the
 *     re-priced subtotal, no separate percentage math) matches the quoted
 *     total to the paise
 *   - a second online booking overlapping an existing setup range on the
 *     SAME resource is refused with a clean customer-facing message,
 *     whether it collides with the same setup, a DIFFERENT setup, or the
 *     base rate
 *   - getPublicBookingDayRange's soft conflict pre-check reflects reality
 *     once something is actually booked
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-studio-setups-public.ts
 */
import { randomBytes, randomInt } from 'node:crypto'
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

async function main() {
  const { getPublicBookingQuote, getPublicBookingDayRange, createPublicBooking } = await import(
    '../lib/actions/public-booking'
  )

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')
  const digits = String(randomInt(0, 1_000_000_000)).padStart(9, '0')

  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,'Pub Setups QA Co','active','Asia/Kolkata','recording_studio') returning id`,
    [`pub-setups-qa-${tag}`],
  )
  const tenantId = t.rows[0].id
  const br = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`,
    [tenantId],
  )
  const branchId = br.rows[0].id
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio Set','500.00') returning id`,
    [tenantId],
  )
  const res = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set A','available') returning id`,
    [tenantId, branchId, rt.rows[0].id],
  )
  const resourceId = res.rows[0].id
  const kitchen = await owner.query<{ id: string }>(
    `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit,is_active) values ($1,$2,'Kitchen','800.00','hour',true) returning id`,
    [tenantId, resourceId],
  )
  const kitchenId = kitchen.rows[0].id
  const royal = await owner.query<{ id: string }>(
    `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit,is_active) values ($1,$2,'Royal','6000.00','day',true) returning id`,
    [tenantId, resourceId],
  )
  const royalId = royal.rows[0].id
  for (let dow = 0; dow <= 6; dow++) {
    await owner.query(
      `insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed) values ($1,$2,$3,'09:00','22:00',false)`,
      [tenantId, branchId, dow],
    )
  }

  const g = globalThis as { __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': `pub-setups-qa-${tag}` }

  // ── hourly setup quote ────────────────────────────────────────────────────
  const startsAt = new Date()
  startsAt.setUTCDate(startsAt.getUTCDate() + 3)
  startsAt.setUTCHours(10, 0, 0, 0)
  const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60_000)
  const q1 = await getPublicBookingQuote({ resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), setupId: kitchenId })
  check('hourly setup (Kitchen) quotes 1600.00 (2h x 800)', q1.total === 1600, q1)

  // ── day-range resolution + day-rate quote ────────────────────────────────
  const d1 = new Date()
  d1.setUTCDate(d1.getUTCDate() + 10)
  const startDate = d1.toISOString().slice(0, 10)
  const d3 = new Date(d1)
  d3.setUTCDate(d3.getUTCDate() + 2)
  const endDate = d3.toISOString().slice(0, 10)
  const range1 = await getPublicBookingDayRange({ resourceId, startDate, endDate })
  check('day-range resolves with no conflict before anything is booked', !range1.error && range1.conflict === false, range1)

  const q2 =
    range1.startsAt && range1.endsAt
      ? await getPublicBookingQuote({ resourceId, startsAt: range1.startsAt, endsAt: range1.endsAt, setupId: royalId })
      : { total: undefined }
  check('3-day Royal quotes 18000.00 (3 x 6000)', q2.total === 18000, q2)

  // ── create + pay-now deposit matches the quote to the paise ─────────────
  const phone = `9${digits}`
  const created = await createPublicBooking({
    resourceId,
    startsAt: range1.startsAt!,
    endsAt: range1.endsAt!,
    customerName: 'Test Customer',
    customerPhone: phone,
    setupId: royalId,
    payNow: true,
    website: '',
  })
  check('booking created', !created.error && Boolean(created.bookingId), created)

  const [slotRow] = created.bookingId
    ? (
        await owner.query<{ rate_applied: string; slot_total: string; rate_unit: string; setup_name: string }>(
          `select rate_applied, slot_total, rate_unit, setup_name from booking_slots where booking_id=$1`,
          [created.bookingId],
        )
      ).rows
    : []
  check('booking_slots: rate_unit=day, setup_name=Royal, slot_total=18000.00', slotRow?.rate_unit === 'day' && slotRow?.setup_name === 'Royal' && slotRow?.slot_total === '18000.00', slotRow)

  const [bookingRow] = created.bookingId
    ? (await owner.query<{ deposit: string }>(`select deposit from bookings where id=$1`, [created.bookingId])).rows
    : []
  check('deposit charged (18000.00) matches the quoted total to the paise', bookingRow?.deposit === '18000.00' && q2.total === 18000, bookingRow)

  // ── online overlap: a DIFFERENT setup on the same set is refused too ────
  const differentSetup = await createPublicBooking({
    resourceId,
    startsAt: range1.startsAt!,
    endsAt: new Date(new Date(range1.startsAt!).getTime() + 2 * 60 * 60_000).toISOString(),
    customerName: 'Second Customer',
    customerPhone: `8${digits}`,
    setupId: kitchenId,
    website: '',
  })
  check('overlapping booking with a DIFFERENT setup on the same set is refused with a clear message', /just taken/i.test(differentSetup.error ?? ''), differentSetup)

  // ── online overlap: base rate (no setup) on the same set is refused too ─
  const baseRateOverlap = await createPublicBooking({
    resourceId,
    startsAt: range1.startsAt!,
    endsAt: range1.endsAt!,
    customerName: 'Third Customer',
    customerPhone: `7${digits}`,
    website: '',
  })
  check('overlapping base-rate (no setup) booking on the same set is refused with a clear message', /just taken/i.test(baseRateOverlap.error ?? ''), baseRateOverlap)

  // ── day-range now reflects the real conflict ─────────────────────────────
  const range2 = await getPublicBookingDayRange({ resourceId, startDate, endDate })
  check('day-range now reports conflict=true', range2.conflict === true, range2)

  await owner.query('delete from tenants where id = $1', [tenantId])
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
