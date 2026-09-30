/**
 * M29 #5 — correcting the player count of a board-with-surcharge booking from
 * the bill screen: updateBookingHeadCountCore (lib/booking/service.ts) and the
 * bill loader (getBillableForBooking, lib/billing/data.ts).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-board-surcharge-recorrection.ts
 *
 * Covers:
 *   - weekday correction up, then down below the included players (surcharge
 *     drops to 0, never negative), with bookings.subtotal/total refreshed
 *   - a slot booked on a WEEKEND day but corrected today (a different day) is
 *     re-priced against the slot's own weekend rate, not today's
 *   - a happy-hour slot re-prices the COMBINED figure discounted
 *   - a holiday slot re-prices holiday base + surcharge, undiscounted
 *   - the corrected slot still reconciles through loadBookingLines/priceBill
 *   - headCount 0 / non-integer is refused and leaves the slot untouched
 *   - a surcharge switched off after booking refuses the correction rather
 *     than silently turning the booking into a plain one
 *   - a plain board still has no player-count editor (refused; loader false)
 *   - a per_head booking's existing correction is unaffected (re-prices, min
 *     players still enforced)
 *   - the bill loader reports hasEditablePlayerCount: true for surcharge and
 *     per_head, false for a plain board
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
  const { loadBookingLines } = await import('../lib/billing/invoice')
  const { getBillableForBooking } = await import('../lib/billing/data')
  const { priceBill, round2 } = await import('../lib/billing/pricing')
  const { getActiveContext } = await import('../lib/tenant/context')
  const { withUser } = await import('../db')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')
  const slug = `boardfix${tag}`
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,'Board Fix Co','active',$2,'gaming_cafe') returning id`,
    [slug, TZ],
  )
  const tenantId = t.rows[0].id
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

  async function makeType(name: string, cols: string, vals: unknown[]) {
    return (
      await owner.query<{ id: string }>(
        `insert into resource_types (tenant_id,name,${cols}) values ($1,$2,${vals.map((_, i) => `$${i + 3}`).join(',')}) returning id`,
        [tenantId, name, ...vals],
      )
    ).rows[0].id
  }
  async function makeRes(typeId: string, name: string) {
    return (
      await owner.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
        [tenantId, branchId, typeId, name],
      )
    ).rows[0].id
  }

  // Board: weekday 300 / weekend 400, 2 included, extra 50 weekday / 80 weekend.
  const boardType = await makeType(
    'Board',
    'hourly_rate,weekend_rate,included_players,extra_player_rate,extra_player_weekend_rate',
    ['300.00', '400.00', 2, '50.00', '80.00'],
  )
  const plainType = await makeType('Plain', 'hourly_rate', ['100.00'])
  const headType = await makeType('Snooker', 'hourly_rate,pricing_mode,min_players', ['50.00', 'per_head', 2])
  // Each booking gets its own board unit so the overlap constraint never bites.
  const units: string[] = []
  for (let i = 0; i < 8; i++) units.push(await makeRes(boardType, `Board-${i}`))
  const plain = await makeRes(plainType, 'Plain-1')
  const head = await makeRes(headType, 'Snooker-1')

  await owner.query(
    `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value,is_active)
     values ($1,'Wed 50% off','{3}','00:00','23:59','percentage',50,true)`,
    [tenantId],
  )
  await owner.query(`insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,'2046-03-28','500.00')`, [
    tenantId,
    boardType,
  ])

  const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`)
  const FRI = '2046-03-16'
  const SAT = '2046-03-17'
  const WED_HH = '2046-03-21'
  const WED_HOL = '2046-03-28'

  async function book(resourceId: string, date: string, from: string, to: string, headCount?: number) {
    return withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        headCount,
        slots: [{ resourceId, startsAt: at(date, from).toISOString(), endsAt: at(date, to).toISOString() }],
      }),
    )
  }
  const correct = (bookingId: string, headCount: number) =>
    withUser(userId, (tx) => updateBookingHeadCountCore(tx, { tenantId }, { bookingId, headCount }))
  async function state(bookingId: string) {
    const { rows } = await owner.query(
      `select b.head_count as b_head, b.subtotal, b.total, s.slot_total, s.rate_applied, s.head_count as s_head,
              s.extra_player_rate_applied as extra, s.happy_hour_applied as hh, s.holiday_rate_applied as hol
         from bookings b join booking_slots s on s.booking_id = b.id where b.id = $1`,
      [bookingId],
    )
    return rows[0]
  }
  async function refused(fn: () => Promise<unknown>) {
    try {
      await fn()
      return null
    } catch (e) {
      return (e as Error).message
    }
  }

  // ══ 1. weekday up, then down below included ══════════════════════════════
  console.log('\n── weekday correction ──')
  const wd = await book(units[0], FRI, '10:00', '11:30', 2)
  check('booked at 2 players (= included): 450.00', (await state(wd.id)).slot_total === '450.00')
  await correct(wd.id, 4)
  let s = await state(wd.id)
  check('4 players: rate 400.00, slot 600.00', s.rate_applied === '400.00' && s.slot_total === '600.00', s)
  check('head_count 4 on slot and booking, extra rate snapshot 50.00', s.s_head === 4 && s.b_head === 4 && s.extra === '50.00', s)
  check('bookings.subtotal/total refreshed to 600.00', s.subtotal === '600.00' && s.total === '600.00', s)
  await correct(wd.id, 1)
  s = await state(wd.id)
  check('1 player (below included): back to 450.00 — surcharge zeroed, never negative', s.slot_total === '450.00' && s.rate_applied === '300.00', s)
  await correct(wd.id, 3)
  {
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, wd.id, TZ))
    const bill = priceBill({ lines, discount: 10 })
    check('loadBookingLines/priceBill reconciles to 525.00 (1.5h × 350)', bill.subtotal === 525, bill.subtotal)
    check('…subtotal − discount + tax = total to the paise', round2(bill.subtotal - bill.discount + bill.taxTotal) === bill.total, bill)
  }

  // ══ 2. weekend slot corrected on a different day ═════════════════════════
  console.log('\n── weekend slot corrected today (a different day) ──')
  const we = await book(units[1], SAT, '10:00', '11:00', 2)
  await correct(we.id, 5)
  s = await state(we.id)
  check("re-priced at the slot's own weekend rates: 400 + 3 × 80 = 640.00", s.slot_total === '640.00' && s.extra === '80.00', s)

  // ══ 3. happy hour ════════════════════════════════════════════════════════
  console.log('\n── happy hour discounts the combined rate ──')
  const hh = await book(units[2], WED_HH, '10:00', '11:00', 4)
  check('booked: (300 + 100) × 50% = 200.00', (await state(hh.id)).slot_total === '200.00')
  await correct(hh.id, 6)
  s = await state(hh.id)
  check('6 players: (300 + 200) × 50% = 250.00, flagged happy hour', s.slot_total === '250.00' && s.hh === true, s)

  // ══ 4. holiday ═══════════════════════════════════════════════════════════
  console.log('\n── holiday: flat base + surcharge, undiscounted ──')
  const hol = await book(units[3], WED_HOL, '10:00', '11:30', 4)
  check('booked: 750 + 150 = 900.00', (await state(hol.id)).slot_total === '900.00')
  await correct(hol.id, 6)
  s = await state(hol.id)
  check('6 players: 750 + round2(4 × 50 × 1.5) = 1050.00, holiday, no happy hour', s.slot_total === '1050.00' && s.hol === true && s.hh === false, s)
  {
    const [line] = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, hol.id, TZ))
    check('holiday line bills the slot_total exactly (1050.00)', round2(line.qty * line.unitPrice) === 1050, line)
  }

  // ══ 5. refusals leave the slot untouched ═════════════════════════════════
  console.log('\n── refusals ──')
  const before = await state(wd.id)
  for (const bad of [0, -2, 2.5]) {
    const msg = await refused(() => correct(wd.id, bad))
    check(`headCount=${bad} is refused`, /whole number of players/i.test(msg ?? ''), msg)
  }
  check('…and the slot is untouched', JSON.stringify(await state(wd.id)) === JSON.stringify(before))

  const off = await book(units[4], FRI, '14:00', '15:00', 2)
  await owner.query(`update resource_types set extra_player_rate = null, extra_player_weekend_rate = null where id = $1`, [boardType])
  const offBefore = await state(off.id)
  const offMsg = await refused(() => correct(off.id, 4))
  check('surcharge switched off since booking: correction refused', /no longer set up/i.test(offMsg ?? ''), offMsg)
  check('…and the booking is untouched', JSON.stringify(await state(off.id)) === JSON.stringify(offBefore))
  // Eligibility is the slot's snapshot, not live config: the loader still says editable.
  const activeCtx = await getActiveContext()
  if (!activeCtx) throw new Error('expected an active context')
  {
    const view = await getBillableForBooking(activeCtx, off.id)
    check('bill loader still reports editable (snapshot-based eligibility)', view?.booking.hasEditablePlayerCount === true, view?.booking)
  }
  await owner.query(`update resource_types set extra_player_rate = '50.00', extra_player_weekend_rate = '80.00' where id = $1`, [boardType])

  // ══ 6. plain board ═══════════════════════════════════════════════════════
  console.log('\n── plain board: no player-count editor ──')
  const pl = await book(plain, FRI, '10:00', '11:00')
  const plMsg = await refused(() => correct(pl.id, 3))
  check('correction refused: "no per-head resource to adjust"', /no per-head resource/i.test(plMsg ?? ''), plMsg)
  {
    const view = await getBillableForBooking(activeCtx, pl.id)
    check('bill loader: hasEditablePlayerCount = false, includedPlayers null', view?.booking.hasEditablePlayerCount === false && view?.booking.includedPlayers === null, view?.booking)
  }

  // ══ 7. per_head regression ═══════════════════════════════════════════════
  console.log('\n── per_head correction unchanged ──')
  const ph = await book(head, FRI, '10:00', '11:00', 2)
  check('booked at 2 players: 100.00', (await state(ph.id)).slot_total === '100.00')
  await correct(ph.id, 3)
  s = await state(ph.id)
  check('3 players: 150.00, extra rate snapshot stays null', s.slot_total === '150.00' && s.extra === null && s.s_head === 3, s)
  const phMsg = await refused(() => correct(ph.id, 1))
  check('min players still enforced for per_head', /at least 2 players/i.test(phMsg ?? ''), phMsg)
  {
    const view = await getBillableForBooking(activeCtx, ph.id)
    check('bill loader: per_head editable, minPlayers 2, pricingMode per_head', view?.booking.hasEditablePlayerCount === true && view.booking.minPlayers === 2 && view.booking.pricingMode === 'per_head', view?.booking)
    const sv = await getBillableForBooking(activeCtx, wd.id)
    check('bill loader: surcharge booking editable, includedPlayers 2, no per_head mode', sv?.booking.hasEditablePlayerCount === true && sv.booking.includedPlayers === 2 && sv.booking.pricingMode === null && sv.booking.minPlayers === null, sv?.booking)
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
