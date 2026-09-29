/**
 * M27 #2 (AROS-247) — the pricing engine: a holiday_rates row overrides
 * weekend/happy-hour pricing at all 4 resolveDayRate call sites
 * (lib/booking/service.ts's priceBookingSlots, lib/booking/walkin.ts's
 * startWalkinCore, lib/booking/public-availability.ts's
 * getPublicAvailableStarts/getPublicAvailableStartsForType), plus the two
 * walk-in checkout call sites (previewWalkinCheckout/checkoutWalkinCore)
 * that only ever READ the rate snapshotted at start but still need to skip
 * happy-hour splitting when that snapshot came from a holiday rate.
 *
 * Covers:
 *   - a plain per-resource reserved slot on a configured holiday date bills
 *     flat at the holiday rate, holiday_rate_applied = true
 *   - a per-head slot: rate × headCount, no per-hour composition confusion
 *   - a slot that would otherwise hit an active happy-hour rule does NOT
 *     discount when a holiday rate applies (a wide-open control rule proves
 *     it WOULD have discounted otherwise)
 *   - precedence: the SAME date/resource-type with an active weekend-rate
 *     config too bills the HOLIDAY rate, not the weekend rate
 *   - a setup-priced booking on the same holiday date is completely
 *     unaffected — still bills the setup's own rate, holiday_rate_applied
 *     stays false, the holiday_rates row is never even consulted
 *   - a date/resource-type with no holiday_rates row is byte-identical
 *     (weekday/weekend composes exactly as before this ticket)
 *   - loadBookingLines -> priceBill reconciles a holiday-priced slot to the
 *     paise, both per-resource and per-head
 *   - the walk-in path: start snapshots the holiday rate, checkout (both the
 *     read-only preview and the real core) bills flat off that snapshot,
 *     ignoring an active happy-hour rule that a control walk-in (no holiday
 *     configured) genuinely does get discounted by
 *   - the two public-availability quote functions show the holiday rate
 *     (not weekend/weekday) for a configured date, and are unaffected for
 *     an unconfigured one — the wizard's estimate can't disagree with what
 *     priceBookingSlots actually charges once a holiday date is picked
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-holiday-pricing.ts
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
  const { createBookingCore } = await import('../lib/booking/service')
  const { startWalkinCore, checkoutWalkinCore, previewWalkinCheckout } = await import('../lib/booking/walkin')
  const { getPublicAvailableStarts, getPublicAvailableStartsForType } = await import('../lib/booking/public-availability')
  const { loadBookingLines } = await import('../lib/billing/invoice')
  const { priceBill, round2 } = await import('../lib/billing/pricing')
  const { todayInZone } = await import('../lib/booking/time')
  const { withUser } = await import('../db')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testholidaypricing'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe')
     on conflict (slug) do update set name=excluded.name returning id`,
    [slug, `${slug} co`, TZ],
  )
  const tenantId = t.rows[0].id
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId],
  )
  const branchId = b.rows[0].id
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`,
    [`owner@${slug}.test`],
  )
  const userId = u.rows[0].id
  const m = await owner.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
    [tenantId, userId],
  )
  const membershipId = m.rows[0].id

  // Idempotent against a previous run that died mid-way — same discipline as
  // test-weekend-pricing.ts/test-happy-hours-reserved-bookings.ts.
  await owner.query(`delete from booking_slots where tenant_id = $1`, [tenantId])
  await owner.query(`delete from bookings where tenant_id = $1`, [tenantId])
  await owner.query(`delete from happy_hours where tenant_id = $1`, [tenantId])
  await owner.query(`delete from holiday_rates where tenant_id = $1`, [tenantId])
  await owner.query(`delete from business_profiles where tenant_id = $1`, [tenantId])
  await owner.query(`delete from resource_setups where tenant_id = $1`, [tenantId])
  await owner.query(`delete from sequences where tenant_id = $1`, [tenantId])

  // PS5: weekday ₹100/hr, weekend ₹150/hr.
  const ps5Type = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate) values ($1,'PS5 Holiday','100.00','150.00')
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=excluded.weekend_rate
     returning id`,
    [tenantId],
  )
  const ps5A = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'PS5-HOL-A','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, ps5Type.rows[0].id],
  )
  const ps5B = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'PS5-HOL-B','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, ps5Type.rows[0].id],
  )

  // Snooker: per_head, min 2 players — weekday ₹50/hr/player, weekend ₹80/hr/player.
  const snookerType = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate,pricing_mode,min_players)
     values ($1,'Snooker Holiday','50.00','80.00','per_head',2)
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=excluded.weekend_rate,
       pricing_mode=excluded.pricing_mode, min_players=excluded.min_players returning id`,
    [tenantId],
  )
  const snookerA = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Snooker-HOL-A','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, snookerType.rows[0].id],
  )

  const ctx = { tenantId, timezone: TZ, membershipId }

  // Fixed calendar, same reference points test-weekend-pricing.ts/
  // test-happy-hours-reserved-bookings.ts already use: 2046-03-16 Fri (not a
  // default weekend day), -17 Sat (a default weekend day), -20 Tue.
  const HOL_TUE = '2046-03-20' // weekday, holiday configured on PS5+Snooker
  const HOL_SAT = '2046-03-17' // weekend day, holiday configured on PS5 too — precedence test
  const NO_HOL_FRI = '2046-03-16' // no holiday_rates row anywhere — control
  const tue = (hhmm: string) => new Date(`${HOL_TUE}T${hhmm}:00+05:30`)
  const sat = (hhmm: string) => new Date(`${HOL_SAT}T${hhmm}:00+05:30`)
  const fri = (hhmm: string) => new Date(`${NO_HOL_FRI}T${hhmm}:00+05:30`)

  await owner.query(
    `insert into holiday_rates (tenant_id,resource_type_id,date,rate) values
       ($1,$2,$3,'999.00'), ($1,$2,$4,'777.00'), ($1,$5,$3,'60.00')`,
    [tenantId, ps5Type.rows[0].id, HOL_TUE, HOL_SAT, snookerType.rows[0].id],
  )

  async function bookAndLoad(resourceId: string, startsAt: Date, endsAt: Date, opts: { headCount?: number; setupId?: string } = {}) {
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
      `select rate_applied, slot_total, happy_hour_applied, holiday_rate_applied from booking_slots where booking_id = $1`,
      [booking.id],
    )
    return {
      bookingId: booking.id,
      rateApplied: rows[0].rate_applied as string,
      slotTotal: rows[0].slot_total as string,
      happyHourApplied: rows[0].happy_hour_applied as boolean,
      holidayRateApplied: rows[0].holiday_rate_applied as boolean,
    }
  }

  // ══ 1. plain per-resource slot on a configured holiday date ═════════════
  console.log('\n── plain per-resource slot on a holiday date ──')
  {
    const r = await bookAndLoad(ps5A.rows[0].id, tue('10:00'), tue('12:00'))
    check('rate_applied = 999.00 (the holiday rate, not weekday 100)', r.rateApplied === '999.00')
    check('slot_total = 1998.00 (2h × ₹999)', r.slotTotal === '1998.00')
    check('holiday_rate_applied = true', r.holidayRateApplied === true)
    check('happy_hour_applied = false', r.happyHourApplied === false)
  }

  // ══ 2. no holiday_rates row anywhere — byte-identical to today ══════════
  console.log('\n── no holiday configured (control) ──')
  {
    const r = await bookAndLoad(ps5A.rows[0].id, fri('10:00'), fri('11:00'))
    check('rate_applied = 100.00 (plain weekday rate — Fri is not a default weekend day)', r.rateApplied === '100.00')
    check('slot_total = 100.00', r.slotTotal === '100.00')
    check('holiday_rate_applied = false', r.holidayRateApplied === false)
  }

  // ══ 3. an active happy-hour rule must NOT discount a holiday-priced slot ═
  console.log('\n── active happy hour does not touch a holiday rate ──')
  await owner.query(
    `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value,is_active)
     values ($1,'All-day 50% off','{0,1,2,3,4,5,6}','00:00','23:59','percentage',50,true)
     on conflict do nothing`,
    [tenantId],
  )
  {
    // Prove the control rule genuinely WOULD have discounted this window,
    // absent a holiday rate — same station, a DIFFERENT day with no holiday
    // configured (Friday).
    const control = await bookAndLoad(ps5A.rows[0].id, fri('14:00'), fri('15:00'))
    check('control: the wide-open happy hour DOES discount an ordinary slot: rate_applied = 50.00', control.rateApplied === '50.00')
    check('control: happy_hour_applied = true', control.happyHourApplied === true)

    const holiday = await bookAndLoad(ps5A.rows[0].id, tue('14:00'), tue('15:00'))
    check('holiday: the SAME wide-open happy hour does NOT discount: rate_applied = 999.00', holiday.rateApplied === '999.00')
    check('holiday: slot_total = 999.00, not 499.50', holiday.slotTotal === '999.00')
    check('holiday: happy_hour_applied = false', holiday.happyHourApplied === false)
    check('holiday: holiday_rate_applied = true', holiday.holidayRateApplied === true)
  }

  // ══ 4. precedence: holiday beats an active weekend_rate on the SAME date ═
  console.log('\n── precedence: holiday rate beats weekend_rate ──')
  {
    // 2046-03-17 is a Saturday — a default weekend day, and PS5's own
    // weekend_rate (150.00) is configured and would otherwise apply. The
    // holiday row for this exact date (777.00) must win over BOTH weekday
    // (100.00) and weekend (150.00).
    const r = await bookAndLoad(ps5B.rows[0].id, sat('10:00'), sat('12:00'))
    check('rate_applied = 777.00 — the holiday rate, not weekend_rate 150 or weekday 100', r.rateApplied === '777.00')
    check('slot_total = 1554.00 (2h × ₹777)', r.slotTotal === '1554.00')
    check('holiday_rate_applied = true', r.holidayRateApplied === true)

    // Control: the exact same Saturday, a DIFFERENT resource type with no
    // holiday row configured, still composes weekend_rate + the (still
    // active, from section 3 above) all-day happy hour exactly as before
    // this ticket — proving the feature is scoped per resource TYPE, not a
    // blanket per-date override, and that ordinary weekend+happy-hour
    // composition is untouched. 80/player weekend rate, 50% off, × 2 players.
    const controlSnooker = await bookAndLoad(snookerA.rows[0].id, sat('20:00'), sat('21:00'), { headCount: 2 })
    check(
      'control: Snooker has no holiday row for Saturday — bills weekend_rate × happy hour normally, not the holiday rate',
      controlSnooker.slotTotal === '80.00' && controlSnooker.happyHourApplied === true && controlSnooker.holidayRateApplied === false,
      controlSnooker,
    )
  }

  // ══ 5. per-head: rate × headCount, no per-hour composition confusion ════
  console.log('\n── per-head holiday pricing ──')
  let perHeadBookingId = ''
  {
    // Snooker holiday rate on HOL_TUE = ₹60/player/hr. 1.5h, 3 players:
    // rawTotal (per player) = round2(60 × 1.5) = 90.00 → × 3 = 270.00.
    const r = await bookAndLoad(snookerA.rows[0].id, tue('09:00'), tue('10:30'), { headCount: 3 })
    perHeadBookingId = r.bookingId
    check('rate_applied = 60.00 (the per-player holiday rate)', r.rateApplied === '60.00')
    check('slot_total = 270.00 (90/player × 3 players, NOT 60 × 1.5 × 3 mis-composed some other way)', r.slotTotal === '270.00')
    check('holiday_rate_applied = true', r.holidayRateApplied === true)
    check('happy_hour_applied = false — fixed/undiscountable even for a per-head slot', r.happyHourApplied === false)
  }

  // ══ 6. loadBookingLines -> priceBill reconciles to the paise ════════════
  console.log('\n── loadBookingLines/priceBill reconciliation ──')
  {
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, perHeadBookingId, TZ))
    check('exactly one line', lines.length === 1)
    const [line] = lines
    // happyHourApplied=false and not a walk-in, so this takes the SAME
    // qty=(hours × headCount)/unitPrice=rate_applied shape an ordinary
    // undiscounted booking already uses today — no special-casing needed in
    // loadBookingLines for a holiday rate (verifying the ticket's own claim,
    // not assuming it).
    check('qty = 4.5 (1.5h × 3 players), unitPrice = 60 (the holiday rate)', line.qty === 4.5 && line.unitPrice === 60)
    check('qty × unitPrice reconstructs slot_total EXACTLY: 270.00', round2(line.qty * line.unitPrice) === 270)

    const bill = priceBill({ lines, discount: 20 })
    check('priceBill subtotal = 270.00', bill.subtotal === 270)
    check(
      'reconciles to the paise with a discount on top: subtotal − discount + tax = total',
      round2(bill.subtotal - bill.discount + bill.taxTotal) === bill.total,
    )
  }

  // ══ 7. a setup-priced booking on the SAME holiday date is unaffected ════
  console.log('\n── studio setup on a holiday date: completely unaffected ──')
  {
    const setup = await owner.query<{ id: string }>(
      `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit) values ($1,$2,'Custom Rig','555.00','hour') returning id`,
      [tenantId, ps5A.rows[0].id],
    )
    const r = await bookAndLoad(ps5A.rows[0].id, tue('16:00'), tue('17:00'), { setupId: setup.rows[0].id })
    check('rate_applied = 555.00 — the setup rate, ignoring the ₹999 holiday row entirely', r.rateApplied === '555.00')
    check('slot_total = 555.00', r.slotTotal === '555.00')
    check('holiday_rate_applied = false — never even consulted for a setup slot', r.holidayRateApplied === false)
  }

  // ══ 8. walk-in path: start snapshots the holiday rate, checkout bills
  //       flat off it, ignoring an active happy-hour rule ═════════════════
  console.log('\n── walk-in: holiday rate at start, flat at checkout ──')
  {
    const today = todayInZone(TZ)
    const holidayWalkinType = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate,pricing_mode) values ($1,'Walkin Holiday','200.00','per_resource')
       on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
      [tenantId],
    )
    const walkinRes = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Walkin-HOL-A','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, holidayWalkinType.rows[0].id],
    )
    // TODAY's date — a walk-in must start within WALKIN_START_WINDOW_MINUTES
    // of now, so (unlike the reserved-booking tests above) this can't use a
    // fixed future calendar date.
    await owner.query(`delete from holiday_rates where tenant_id=$1 and resource_type_id=$2`, [tenantId, holidayWalkinType.rows[0].id])
    await owner.query(`insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,$3,'400.00')`, [
      tenantId,
      holidayWalkinType.rows[0].id,
      today,
    ])

    const started = await withUser(userId, (tx) =>
      startWalkinCore(tx, ctx, {
        branchId,
        resourceId: walkinRes.rows[0].id,
        phone: '9876500301',
        startAt: new Date().toISOString(),
        mode: 'open_tab',
      }),
    )
    const startRow = await owner.query(`select rate_applied, holiday_rate_applied from booking_slots where booking_id=$1`, [
      started.id,
    ])
    check('at start: rate_applied = 400.00 (the holiday rate, not the 200 weekday rate)', startRow.rows[0].rate_applied === '400.00')
    check('at start: holiday_rate_applied = true', startRow.rows[0].holiday_rate_applied === true)

    // Backdate 10 minutes so a real, non-trivial elapsed duration bills at
    // the 30-min minimum (₹400/hr × 0.5h = ₹200) — same deterministic
    // convention scripts/test-checkout-walkin.ts already uses.
    await owner.query(`update booking_slots set starts_at = now() - interval '10 minutes' where booking_id = $1`, [started.id])

    const preview = await withUser(userId, (tx) => previewWalkinCheckout(tx, ctx, { bookingId: started.id }))
    check('preview: ₹200.00 (30-min floor × ₹400/hr), NOT discounted by the wide-open happy hour', preview.total === 200)

    const closed = await withUser(userId, (tx) => checkoutWalkinCore(tx, ctx, { bookingId: started.id }))
    check('checkout: total = 200.00, matching the preview exactly', closed.total === 200)

    const endRow = await owner.query(`select slot_total, holiday_rate_applied from booking_slots where booking_id=$1`, [started.id])
    check('checkout: slot_total = 200.00', endRow.rows[0].slot_total === '200.00')
    check('checkout: holiday_rate_applied stays true (never re-derived, still the start snapshot)', endRow.rows[0].holiday_rate_applied === true)

    // Control: a SECOND walk-in on a station with NO holiday rate configured
    // for today, same wide-open happy hour active — proves the happy hour
    // genuinely would have discounted this if not for the holiday rate above.
    const plainType = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate,pricing_mode) values ($1,'Walkin Plain','200.00','per_resource')
       on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
      [tenantId],
    )
    const plainRes = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Walkin-Plain-A','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, plainType.rows[0].id],
    )
    const controlStarted = await withUser(userId, (tx) =>
      startWalkinCore(tx, ctx, {
        branchId,
        resourceId: plainRes.rows[0].id,
        phone: '9876500302',
        startAt: new Date().toISOString(),
        mode: 'open_tab',
      }),
    )
    const controlStartRow = await owner.query(`select holiday_rate_applied from booking_slots where booking_id=$1`, [controlStarted.id])
    check('control: holiday_rate_applied = false — no holiday row for this type', controlStartRow.rows[0].holiday_rate_applied === false)
    await owner.query(`update booking_slots set starts_at = now() - interval '10 minutes' where booking_id = $1`, [controlStarted.id])
    const controlClosed = await withUser(userId, (tx) => checkoutWalkinCore(tx, ctx, { bookingId: controlStarted.id }))
    check(
      'control: the SAME wide-open happy hour DOES discount an ordinary walk-in: ₹50.00 (30-min floor × ₹200/hr × 50% off), not ₹100',
      controlClosed.total === 50,
    )
  }

  // ══ 9. the public-availability quote functions show the holiday rate ═══
  console.log('\n── public quote functions ──')
  {
    const r1 = await getPublicAvailableStarts({
      tenantId,
      branchId,
      resourceId: ps5A.rows[0].id,
      timeZone: TZ,
      date: HOL_TUE,
      durationMinutes: 60,
    })
    check('getPublicAvailableStarts on a holiday date quotes 999.00, not weekday 100', !('error' in r1) && r1.rate === '999.00', r1)

    const r2 = await getPublicAvailableStartsForType({
      tenantId,
      branchId,
      resourceTypeId: ps5Type.rows[0].id,
      timeZone: TZ,
      date: HOL_SAT,
      durationMinutes: 60,
    })
    check(
      'getPublicAvailableStartsForType on the Saturday holiday quotes 777.00, not weekend_rate 150',
      !('error' in r2) && r2.rate === '777.00',
      r2,
    )

    const r3 = await getPublicAvailableStarts({
      tenantId,
      branchId,
      resourceId: ps5A.rows[0].id,
      timeZone: TZ,
      date: NO_HOL_FRI,
      durationMinutes: 60,
    })
    check('control: no holiday row for this date — quotes the plain weekday rate 100.00', !('error' in r3) && r3.rate === '100.00', r3)
  }

  // ══ 10. snapshot freeze: editing/deleting the holiday_rates row never
  //        restates an already-taken booking's rate_applied/slot_total ═════
  console.log('\n── snapshot freeze: a later edit/delete never restates a taken booking ──')
  {
    const r = await bookAndLoad(ps5A.rows[0].id, tue('20:00'), tue('21:00'))
    check('booked at the holiday rate: rate_applied = 999.00', r.rateApplied === '999.00')
    check('slot_total = 999.00', r.slotTotal === '999.00')

    // Edit the holiday_rates row's rate — same discipline every other
    // snapshot column in this codebase is held to (rate_applied, setup_name,
    // happy_hour_applied, …): a later config change must never reach back
    // into a booking already taken.
    await owner.query(`update holiday_rates set rate = '111.00' where tenant_id=$1 and resource_type_id=$2 and date=$3`, [
      tenantId,
      ps5Type.rows[0].id,
      HOL_TUE,
    ])
    const afterEdit = await owner.query(`select rate_applied, slot_total from booking_slots where booking_id=$1`, [r.bookingId])
    check(
      "editing the holiday_rates row does NOT restate the booking: still 999.00/999.00",
      afterEdit.rows[0].rate_applied === '999.00' && afterEdit.rows[0].slot_total === '999.00',
      afterEdit.rows[0],
    )

    // Delete it outright — the booking must still keep its frozen figures.
    await owner.query(`delete from holiday_rates where tenant_id=$1 and resource_type_id=$2 and date=$3`, [
      tenantId,
      ps5Type.rows[0].id,
      HOL_TUE,
    ])
    const afterDelete = await owner.query(`select rate_applied, slot_total, holiday_rate_applied from booking_slots where booking_id=$1`, [
      r.bookingId,
    ])
    check(
      'deleting the holiday_rates row does NOT restate the booking either: still 999.00/999.00',
      afterDelete.rows[0].rate_applied === '999.00' && afterDelete.rows[0].slot_total === '999.00',
      afterDelete.rows[0],
    )
    check('…and holiday_rate_applied stays true — it is a frozen fact about how THIS booking was priced, not a live pointer', afterDelete.rows[0].holiday_rate_applied === true)

    // Contrast: a NEW booking on the SAME date/type, now that the row is
    // gone, falls back to ordinary weekday + happy-hour composition (the
    // all-day 50%-off rule from section 3 above is still active) — proving
    // the deletion genuinely took effect for pricing going forward, and the
    // frozen booking above wasn't just coincidentally unaffected because
    // nothing really changed.
    const after = await bookAndLoad(ps5A.rows[0].id, tue('21:30'), tue('22:00'))
    check(
      'a booking taken AFTER the delete is no longer holiday-priced — back to weekday × the still-active happy hour: 50.00',
      after.rateApplied === '50.00' && after.happyHourApplied === true,
      after,
    )
    check('…and holiday_rate_applied = false for it', after.holidayRateApplied === false)
  }

  // ══ 11. loadBookingLines -> priceBill reconciles to the paise WITH a real
  //        tax rate configured, discount + tax both composing correctly ═══
  console.log('\n── reconciliation with a real tax rate + discount ──')
  {
    const gst = await owner.query<{ id: string }>(
      `insert into tax_rates (tenant_id,name,percent,applies_to) values ($1,'GST 18%',18.00,'resources')
       on conflict (tenant_id,name) do update set percent=excluded.percent, applies_to=excluded.applies_to returning id`,
      [tenantId],
    )
    const taxedType = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate,tax_rate_id) values ($1,'PS5 Taxed','100.00',$2)
       on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, tax_rate_id=excluded.tax_rate_id returning id`,
      [tenantId, gst.rows[0].id],
    )
    const taxedRes = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'PS5-Taxed-A','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, taxedType.rows[0].id],
    )
    await owner.query(`insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,$3,'200.00')`, [
      tenantId,
      taxedType.rows[0].id,
      HOL_TUE,
    ])
    // 2h × ₹200 holiday rate = ₹400 subtotal, ₹50 discount, 18% GST on the
    // remaining ₹350 taxable value = ₹63, total ₹413 — the same
    // discount-before-tax composition every other pricing axis already goes
    // through (lib/billing/pricing.ts's priceBill), unmodified for a holiday
    // rate: it only ever changes what rate_applied/slot_total ARE, never how
    // billing composes on top of them.
    const r = await bookAndLoad(taxedRes.rows[0].id, tue('11:00'), tue('13:00'))
    check('rate_applied = 200.00 (the holiday rate)', r.rateApplied === '200.00')
    check('slot_total = 400.00 (2h × ₹200)', r.slotTotal === '400.00')

    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, r.bookingId, TZ))
    check('exactly one line', lines.length === 1)
    check('taxPercent snapshotted onto the line: 18', lines[0].taxPercent === 18)

    const bill = priceBill({ lines, discount: 50 })
    check('subtotal = 400.00', bill.subtotal === 400)
    check('taxable value = 350.00 (400 − 50 discount, applied BEFORE tax)', bill.taxableValue === 350)
    check('tax total = 63.00 (18% of the taxable value, not the raw subtotal)', bill.taxTotal === 63)
    check('grand total = 413.00', bill.total === 413)
    check(
      'reconciles to the paise end to end: taxableValue + taxTotal = total',
      round2(bill.taxableValue + bill.taxTotal) === bill.total,
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
