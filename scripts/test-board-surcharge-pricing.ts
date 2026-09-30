/**
 * M29 #3 — the pricing engine: a per_resource type with an extra-player rate
 * bills base + extraPlayers × extraRate inside priceBookingSlots
 * (lib/booking/service.ts), composing with weekend, happy-hour and holiday
 * pricing.
 *
 * Covers:
 *   - weekday / weekend: combined hourly rate, head_count + extra_player_rate_applied snapshotted
 *   - weekend extra rate falls back to the weekday extra rate when null
 *   - an active happy-hour rule discounts the COMBINED figure
 *   - a holiday rate: holiday base + surcharge, NO happy-hour discount on either,
 *     and the weekend extra rate resolves inside the holiday branch
 *   - headCount <= includedPlayers never bills a negative/any surcharge
 *   - a missing headCount on a surcharge type is refused
 *   - a per_head type with the surcharge columns accidentally set is NOT double-priced
 *   - a setup-priced slot on a surcharge type is untouched (never consults the columns)
 *   - a plain per_resource type is byte-identical (head_count / extra rate null)
 *   - loadBookingLines -> priceBill reconciles to the paise for each shape
 *   - resolvePublicHeadCount gives a surcharge board its included players (public
 *     flow never asks) and stays undefined for a plain board
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-board-surcharge-pricing.ts
 */
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
  const { createBookingCore, resolvePublicHeadCount } = await import('../lib/booking/service')
  const { loadBookingLines } = await import('../lib/billing/invoice')
  const { priceBill, round2 } = await import('../lib/billing/pricing')
  const { withUser } = await import('../db')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testboardsurchargepricing'
  await owner.query(`delete from tenants where slug = $1`, [slug])
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe') returning id`,
    [slug, `${slug} co`, TZ],
  )
  const tenantId = t.rows[0].id
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [tenantId],
  )
  const branchId = b.rows[0].id
  const email = `owner@${slug}.test`
  await owner.query(`delete from users where email = $1`, [email])
  const u = await owner.query<{ id: string }>(`insert into users (email,password_hash) values ($1,'x') returning id`, [email])
  const userId = u.rows[0].id
  const m = await owner.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active') returning id`,
    [tenantId, userId],
  )
  const ctx = { tenantId, timezone: TZ, membershipId: m.rows[0].id }

  async function makeType(name: string, cols: string, vals: unknown[]) {
    const r = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,${cols}) values ($1,$2,${vals.map((_, i) => `$${i + 3}`).join(',')}) returning id`,
      [tenantId, name, ...vals],
    )
    return r.rows[0].id
  }
  async function makeRes(typeId: string, name: string) {
    const r = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
      [tenantId, branchId, typeId, name],
    )
    return r.rows[0].id
  }

  // Board: weekday ₹300, weekend ₹400, 2 included, extra ₹50 weekday / ₹80 weekend.
  const boardType = await makeType(
    'Board',
    'hourly_rate,weekend_rate,included_players,extra_player_rate,extra_player_weekend_rate',
    ['300.00', '400.00', 2, '50.00', '80.00'],
  )
  const board = await makeRes(boardType, 'Board-1')
  // Board B: weekday ₹300, no weekend rate; extra ₹50, NO weekend extra rate (falls back).
  const boardBType = await makeType('Board B', 'hourly_rate,included_players,extra_player_rate', ['300.00', 2, '50.00'])
  const boardB = await makeRes(boardBType, 'Board-B-1')
  // Plain per_resource type: no surcharge.
  const plainType = await makeType('Plain', 'hourly_rate', ['100.00'])
  const plain = await makeRes(plainType, 'Plain-1')
  // per_head type with the surcharge columns ACCIDENTALLY set (#2's guard bypassed).
  const headType = await makeType(
    'Head',
    'hourly_rate,pricing_mode,min_players,included_players,extra_player_rate',
    ['50.00', 'per_head', 2, 1, '20.00'],
  )
  const head = await makeRes(headType, 'Head-1')

  // Calendar (IST): 2046-03-16 Fri, -17 Sat, -21 Wed, -24 Sat, -28 Wed.
  const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`)
  const FRI = '2046-03-16'
  const SAT = '2046-03-17'
  const WED_HH = '2046-03-21' // happy hour (Wed only)
  const SAT_HOL = '2046-03-24' // holiday on a weekend day
  const WED_HOL = '2046-03-28' // holiday on a happy-hour day

  await owner.query(
    `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value,is_active)
     values ($1,'Wed 50% off','{3}','00:00','23:59','percentage',50,true)`,
    [tenantId],
  )
  await owner.query(
    `insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,$3,'500.00'), ($1,$2,$4,'500.00')`,
    [tenantId, boardType, SAT_HOL, WED_HOL],
  )

  async function book(resourceId: string, startsAt: Date, endsAt: Date, opts: { headCount?: number; setupId?: string } = {}) {
    const booking = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        headCount: opts.headCount,
        slots: [{ resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), setupId: opts.setupId }],
      }),
    )
    const { rows } = await owner.query(
      `select rate_applied, slot_total, head_count, extra_player_rate_applied, happy_hour_applied, holiday_rate_applied
         from booking_slots where booking_id = $1`,
      [booking.id],
    )
    const r = rows[0]
    return {
      bookingId: booking.id,
      rate: r.rate_applied as string,
      total: r.slot_total as string,
      head: r.head_count as number | null,
      extra: r.extra_player_rate_applied as string | null,
      hh: r.happy_hour_applied as boolean,
      hol: r.holiday_rate_applied as boolean,
    }
  }
  const lineFor = async (bookingId: string) => {
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, bookingId, TZ))
    return lines
  }

  // ══ 1. plain weekday ═════════════════════════════════════════════════════
  console.log('\n── weekday: base + extra players ──')
  let weekdayBooking = ''
  {
    const r = await book(board, at(FRI, '10:00'), at(FRI, '11:30'), { headCount: 4 })
    weekdayBooking = r.bookingId
    check('rate_applied = 400.00 (300 + 2 extra × 50)', r.rate === '400.00', r)
    check('slot_total = 600.00 (1.5h × 400)', r.total === '600.00', r)
    check('head_count snapshot = 4', r.head === 4, r)
    check('extra_player_rate_applied = 50.00 (weekday extra rate)', r.extra === '50.00', r)
    check('no happy hour / holiday flags', !r.hh && !r.hol, r)
  }

  // ══ 2. weekend ═══════════════════════════════════════════════════════════
  console.log('\n── weekend: weekend base + weekend extra rate ──')
  {
    const r = await book(board, at(SAT, '10:00'), at(SAT, '11:00'), { headCount: 3 })
    check('rate_applied = 480.00 (400 + 1 extra × 80)', r.rate === '480.00', r)
    check('slot_total = 480.00', r.total === '480.00', r)
    check('extra_player_rate_applied = 80.00 (weekend extra rate)', r.extra === '80.00', r)
    const fb = await book(boardB, at(SAT, '10:00'), at(SAT, '11:00'), { headCount: 3 })
    check('weekend extra rate null falls back to the weekday extra rate: 300 + 50 = 350.00', fb.total === '350.00' && fb.extra === '50.00', fb)
  }

  // ══ 3. happy hour discounts the combined total ═══════════════════════════
  console.log('\n── happy hour discounts base + extra together ──')
  let hhBooking = ''
  {
    const r = await book(board, at(WED_HH, '10:00'), at(WED_HH, '11:00'), { headCount: 4 })
    hhBooking = r.bookingId
    check('slot_total = 200.00 (50% off the COMBINED 400), not 350 or 300', r.total === '200.00', r)
    check('happy_hour_applied = true', r.hh === true, r)
    check('extra_player_rate_applied still the configured 50.00', r.extra === '50.00', r)
  }

  // ══ 4. holiday ═══════════════════════════════════════════════════════════
  console.log('\n── holiday: holiday base + surcharge, no happy-hour discount ──')
  let holBooking = ''
  {
    // Wed 2046-03-28 has the all-day 50% happy hour AND a ₹500 holiday rate.
    const r = await book(board, at(WED_HOL, '10:00'), at(WED_HOL, '11:30'), { headCount: 4 })
    holBooking = r.bookingId
    check('slot_total = 900.00 (round2(500×1.5)=750 + round2(2×50×1.5)=150), no discount', r.total === '900.00', r)
    check('holiday_rate_applied = true, happy_hour_applied = false', r.hol === true && r.hh === false, r)
    check('extra_player_rate_applied = 50.00', r.extra === '50.00', r)
    const wk = await book(board, at(SAT_HOL, '10:00'), at(SAT_HOL, '11:00'), { headCount: 4 })
    check('holiday on a weekend day uses the weekend extra rate: 500 + 2×80 = 660.00', wk.total === '660.00' && wk.extra === '80.00', wk)
  }

  // ══ 5. headCount at/below included never bills a surcharge ═══════════════
  console.log('\n── headCount <= includedPlayers ──')
  {
    const one = await book(board, at(FRI, '13:00'), at(FRI, '14:00'), { headCount: 1 })
    check('1 player (below 2 included): slot_total = 300.00, never negative', one.total === '300.00' && one.head === 1, one)
    const two = await book(board, at(FRI, '15:00'), at(FRI, '16:00'), { headCount: 2 })
    check('2 players (= included): slot_total = 300.00', two.total === '300.00', two)
    const hol1 = await book(board, at(SAT_HOL, '12:00'), at(SAT_HOL, '13:00'), { headCount: 1 })
    check('holiday, 1 player: just the holiday base 500.00', hol1.total === '500.00', hol1)
  }

  // ══ 6. headCount required ════════════════════════════════════════════════
  console.log('\n── headCount validation ──')
  {
    let msg = ''
    try {
      await book(board, at(FRI, '17:00'), at(FRI, '18:00'))
    } catch (e) {
      msg = (e as Error).message
    }
    check('no headCount on a surcharge type is refused', /Board is priced per player — enter the number of players/.test(msg), msg)
    for (const bad of [0, -1, 1.5]) {
      let m2 = ''
      try {
        await book(board, at(FRI, '17:00'), at(FRI, '18:00'), { headCount: bad })
      } catch (e) {
        m2 = (e as Error).message
      }
      check(`headCount=${bad} is refused`, /enter the number of players/.test(m2), m2)
    }
  }

  // ══ 7. per_head with surcharge columns set: no double pricing ════════════
  console.log('\n── per_head type with surcharge columns set ──')
  {
    const r = await book(head, at(FRI, '10:00'), at(FRI, '11:00'), { headCount: 3 })
    check('slot_total = 150.00 (3 × ₹50) — the extra-player rate is NOT applied on top', r.total === '150.00', r)
    check('extra_player_rate_applied = null, head_count = 3', r.extra === null && r.head === 3, r)
  }

  // ══ 8. setup slot untouched ══════════════════════════════════════════════
  console.log('\n── setup slot on a surcharge type ──')
  {
    const setup = await owner.query<{ id: string }>(
      `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit) values ($1,$2,'Rig','777.00','hour') returning id`,
      [tenantId, board],
    )
    // No headCount: a setup slot must never reach the surcharge's headCount check.
    const r = await book(board, at(FRI, '19:00'), at(FRI, '20:00'), { setupId: setup.rows[0].id })
    check('slot_total = 777.00, rate_applied = 777.00', r.total === '777.00' && r.rate === '777.00', r)
    check('head_count = null, extra_player_rate_applied = null', r.head === null && r.extra === null, r)
  }

  // ══ 9. plain per_resource byte-identical ═════════════════════════════════
  console.log('\n── plain per_resource (no surcharge) ──')
  {
    const r = await book(plain, at(FRI, '10:00'), at(FRI, '12:00'))
    check('rate 100.00, total 200.00, no head_count, no extra rate', r.rate === '100.00' && r.total === '200.00' && r.head === null && r.extra === null, r)
    const withHc = await book(plain, at(FRI, '13:00'), at(FRI, '14:00'), { headCount: 5 })
    check('a headCount on a plain type does not reprice it or get snapshotted', withHc.total === '100.00' && withHc.head === null && withHc.extra === null, withHc)
  }

  // ══ 10. invoice reconciliation ═══════════════════════════════════════════
  console.log('\n── loadBookingLines / priceBill reconcile ──')
  {
    const [wd] = await lineFor(weekdayBooking)
    check('weekday surcharge: qty 1.5 × unitPrice 400 = 600.00', wd.qty === 1.5 && wd.unitPrice === 400 && round2(wd.qty * wd.unitPrice) === 600, wd)
    const [hh] = await lineFor(hhBooking)
    check('happy-hour surcharge: bills the slot_total 200.00', round2(hh.qty * hh.unitPrice) === 200, hh)
    const [hol] = await lineFor(holBooking)
    check('holiday surcharge: bills the slot_total 900.00 exactly', round2(hol.qty * hol.unitPrice) === 900, hol)
    for (const [label, id, expected] of [
      ['weekday', weekdayBooking, 600],
      ['happy hour', hhBooking, 200],
      ['holiday', holBooking, 900],
    ] as const) {
      const lines = await lineFor(id)
      const bill = priceBill({ lines, discount: 25 })
      check(`${label}: priceBill subtotal = ${expected}.00`, bill.subtotal === expected, bill.subtotal)
      check(
        `${label}: subtotal − discount + tax = total, to the paise`,
        round2(bill.subtotal - bill.discount + bill.taxTotal) === bill.total,
        bill,
      )
    }
  }

  // ══ 11. public flow head count ═══════════════════════════════════════════
  console.log('\n── resolvePublicHeadCount ──')
  {
    const hcBoard = await withUser(userId, (tx) => resolvePublicHeadCount(tx, tenantId, [board]))
    check('a surcharge board books at its included players (2) — no online surcharge', hcBoard === 2, hcBoard)
    const hcPlain = await withUser(userId, (tx) => resolvePublicHeadCount(tx, tenantId, [plain]))
    check('a plain board is still undefined', hcPlain === undefined, hcPlain)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query(`delete from tenants where id = $1`, [tenantId])
  await owner.query(`delete from users where id = $1`, [userId])
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
