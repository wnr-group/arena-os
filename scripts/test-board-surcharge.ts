/**
 * M29 #7 — board surcharge QA. The per-ticket suites (settings, pricing,
 * estimate, recorrection, walk-in) each pin their own layer; this one closes
 * the cross-cutting gaps the QA ticket lists, end to end through the real
 * entry points:
 *
 *   1. Snapshot freeze through the REAL action: book via createBookingCore,
 *      then change the type's surcharge AND base rates through
 *      upsertResourceType (manager-gated) — the taken booking's slot and
 *      totals never move, while a NEW booking prices at the new numbers.
 *   2. Invoice reconciliation with a discount AND tax on top, to the paise,
 *      for a weekday surcharge booking and a holiday surcharge booking.
 *   3. Walk-in: a TIMED session started, extended, and checked out with a
 *      changed player count re-prices the whole committed window at the
 *      combined rate.
 *   4. Boundary sweep at/below/above the included players on one booking path.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-board-surcharge.ts
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
  const { createBookingCore, updateBookingHeadCountCore } = await import('../lib/booking/service')
  const { startWalkinCore, extendWalkinCore, checkoutWalkinCore } = await import('../lib/booking/walkin')
  const { upsertResourceType } = await import('../lib/actions/resources')
  const { loadBookingLines } = await import('../lib/billing/invoice')
  const { priceBill, round2 } = await import('../lib/billing/pricing')
  const { todayInZone, weekdayInZone } = await import('../lib/booking/time')
  const { withUser } = await import('../db')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')
  const slug = `boardqa${tag}`
  const tenantId = (
    await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,'Board QA Co','active',$2,'gaming_cafe') returning id`,
      [slug, TZ],
    )
  ).rows[0].id
  const branchId = (
    await owner.query<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])
  ).rows[0].id
  const userId = (
    await owner.query<{ id: string }>(`insert into users (email,password_hash,full_name) values ($1,'x','Owner') returning id`, [
      `owner-${tag}@example.test`,
    ])
  ).rows[0].id
  const token = randomBytes(32).toString('hex')
  await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
    createHash('sha256').update(token).digest('hex'),
    userId,
  ])
  const membershipId = (
    await owner.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'owner','active','Owner') returning id`,
      [tenantId, userId, branchId],
    )
  ).rows[0].id
  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_SESSION = token
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
  const ctx = { tenantId, timezone: TZ, membershipId }

  // 18% GST on resources — the snapshot every booking below carries.
  await owner.query(
    `insert into tax_rates (tenant_id,name,percent,applies_to,is_active) values ($1,'GST 18%','18.00','resources',true)`,
    [tenantId],
  )

  // Board: weekday 300, 2 included, extra 50. (No weekend rate: weekday-only.)
  const boardType = (
    await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate,included_players,extra_player_rate)
       values ($1,'Board','300.00',2,'50.00') returning id`,
      [tenantId],
    )
  ).rows[0].id
  let unitN = 0
  const unit = async () =>
    (
      await owner.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
        [tenantId, branchId, boardType, `Board-${++unitN}`],
      )
    ).rows[0].id

  const today = todayInZone(TZ)
  const dow = weekdayInZone(today, TZ)
  await owner.query(
    `insert into business_profiles (tenant_id, weekend_days) values ($1, $2::smallint[])
     on conflict (tenant_id) do update set weekend_days = excluded.weekend_days`,
    [tenantId, `{${(dow + 1) % 7}}`], // today is a weekday
  )

  const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`)
  const FRI = '2046-03-16'
  const WED_HOL = '2046-03-28'
  await owner.query(`insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,$3,'500.00')`, [tenantId, boardType, WED_HOL])

  async function book(date: string, from: string, to: string, headCount: number) {
    return withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        headCount,
        slots: [{ resourceId: currentUnit, startsAt: at(date, from).toISOString(), endsAt: at(date, to).toISOString() }],
      }),
    )
  }
  let currentUnit = ''
  const slotOf = async (bookingId: string) =>
    (
      await owner.query(
        `select s.rate_applied, s.slot_total, s.head_count, s.extra_player_rate_applied as extra, s.tax_rate_percent as tax,
                b.subtotal, b.total
           from booking_slots s join bookings b on b.id = s.booking_id where s.booking_id = $1`,
        [bookingId],
      )
    ).rows[0]

  // ══ 1. boundary sweep at/below/above included ════════════════════════════
  console.log('\n── at / below / above the included players ──')
  for (const [players, expected] of [
    [1, '300.00'],
    [2, '300.00'],
    [3, '350.00'],
    [7, '550.00'],
  ] as const) {
    currentUnit = await unit()
    const b = await book(FRI, '10:00', '11:00', players)
    const s = await slotOf(b.id)
    check(`${players} players (2 included) → ${expected}`, s.slot_total === expected && s.head_count === players, s)
  }

  // ══ 2. snapshot freeze through the real action ═══════════════════════════
  console.log('\n── editing the type never restates a taken booking ──')
  currentUnit = await unit()
  const taken = await book(FRI, '14:00', '15:30', 4) // (300 + 2×50) × 1.5 = 600
  const before = await slotOf(taken.id)
  check('taken at 600.00 with 18% tax snapshotted', before.slot_total === '600.00' && before.tax === '18.00' && before.extra === '50.00', before)
  const edit = await upsertResourceType({
    id: boardType,
    name: 'Board',
    hourlyRate: 999,
    includedPlayers: 1,
    extraPlayerRate: 500,
    pricingMode: 'per_resource',
  })
  check('manager edits base rate, included players and extra rate', !edit.error, edit)
  const after = await slotOf(taken.id)
  check('the taken booking is byte-for-byte unchanged', JSON.stringify(after) === JSON.stringify(before), { before, after })
  currentUnit = await unit()
  const fresh = await book(FRI, '17:00', '18:00', 3) // new numbers: 999 + 2×500
  check('a NEW booking prices at the new numbers: 999 + 2×500 = 1999.00', (await slotOf(fresh.id)).slot_total === '1999.00', await slotOf(fresh.id))
  // restore
  await upsertResourceType({
    id: boardType,
    name: 'Board',
    hourlyRate: 300,
    includedPlayers: 2,
    extraPlayerRate: 50,
    pricingMode: 'per_resource',
  })

  // ══ 3. invoice reconciliation with discount + tax ════════════════════════
  console.log('\n── loadBookingLines / priceBill: discount + tax on top ──')
  {
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, taken.id, TZ))
    const bill = priceBill({ lines, discount: 60 })
    check('weekday: subtotal 600.00', bill.subtotal === 600, bill)
    check('…discount 60.00 comes off BEFORE tax: taxable 540.00', bill.taxableValue === 540, bill)
    check('…18% tax on 540.00 = 97.20, total 637.20', bill.taxTotal === 97.2 && bill.total === 637.2, bill)
    check('…subtotal − discount + tax = total, to the paise', round2(bill.subtotal - bill.discount + bill.taxTotal) === bill.total, bill)
  }
  {
    // The holiday rate is its own 500.00 figure, unaffected by the type edit above.
    currentUnit = await unit()
    const hol = await book(WED_HOL, '12:00', '13:30', 5) // 750 + round2(3×50×1.5)=225 = 975
    const s = await slotOf(hol.id)
    check('holiday, 5 players: 750 + 225 = 975.00', s.slot_total === '975.00', s)
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, hol.id, TZ))
    const bill = priceBill({ lines, discount: 75 })
    check('holiday bill: subtotal 975, taxable 900, tax 162.00, total 1062.00', bill.subtotal === 975 && bill.taxableValue === 900 && bill.taxTotal === 162 && bill.total === 1062, bill)
    check('…reconciles to the paise', round2(bill.subtotal - bill.discount + bill.taxTotal) === bill.total, bill)
  }

  // ══ 4. correction then invoice ═══════════════════════════════════════════
  console.log('\n── player-count correction feeds the invoice ──')
  {
    currentUnit = await unit()
    const b = await book(FRI, '19:00', '20:00', 2)
    await withUser(userId, (tx) => updateBookingHeadCountCore(tx, { tenantId }, { bookingId: b.id, headCount: 6 }))
    const s = await slotOf(b.id)
    check('corrected 2 → 6 players: 300 + 4×50 = 500.00, booking totals refreshed', s.slot_total === '500.00' && s.subtotal === '500.00' && s.total === '500.00', s)
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, b.id, TZ))
    const bill = priceBill({ lines, discount: 0 })
    check('invoice: 500.00 + 18% = 590.00', bill.subtotal === 500 && bill.total === 590, bill)
  }

  // ══ 5. timed walk-in: start, extend, checkout with a new count ═══════════
  console.log('\n── timed walk-in: extend + player change ──')
  {
    const walkinUnit = await unit()
    const id = (
      await withUser(userId, (tx) =>
        startWalkinCore(tx, ctx, {
          branchId,
          resourceId: walkinUnit,
          phone: '9876500777',
          startAt: new Date().toISOString(),
          mode: 'timed',
          durationMin: 60,
        }),
      )
    ).id
    const s0 = await slotOf(id)
    check('start: defaults to the 2 included players, extra rate 50.00 snapshotted', s0.head_count === 2 && s0.extra === '50.00', s0)
    await withUser(userId, (tx) => extendWalkinCore(tx, { tenantId }, { bookingId: id, addMinutes: 30 }))
    const closed = await withUser(userId, (tx) => checkoutWalkinCore(tx, ctx, { bookingId: id, headCount: 4 }))
    check('checkout after extend at 4 players: 1.5h × (300 + 2×50) = 600.00', closed.total === 600, closed)
    const s1 = await slotOf(id)
    check('slot_total 600.00 and player count 4 persisted', s1.slot_total === '600.00' && s1.head_count === 4, s1)
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, id, TZ))
    const bill = priceBill({ lines, discount: 0 })
    check('walk-in invoice: 600.00 + 18% = 708.00', bill.subtotal === 600 && bill.total === 708, bill)
  }

  await owner.query('delete from tenants where id = $1', [tenantId])
  await owner.query('delete from users where id = $1', [userId])
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
