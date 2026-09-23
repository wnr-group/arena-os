/**
 * Happy hours #1 (M23 #1) — closes the gap found in PR #29 review: happy
 * hours were honoured for walk-in elapsed-time billing
 * (lib/billing/elapsed-time.ts) and menu orders (lib/orders/service.ts), but
 * NOT for reserved/advance bookings priced by priceBookingSlots
 * (lib/booking/service.ts) — a slot booked inside a happy-hour window billed
 * full rate. This proves:
 *
 *   - priceTimeRangeSegments (the shared segment engine, pure): splits a
 *     FIXED [start,end) window at every happy-hour boundary inside it,
 *     discounts each segment, and — unlike priceElapsedTime — applies NO
 *     30-min floor or 15-min round-up, since a reserved slot's end is a firm
 *     commitment, not an elapsed measurement
 *   - half-open [start,end) rule matching: the discount reverts EXACTLY at a
 *     rule's own end time, matching elapsed-time's ruleActiveAt — never the
 *     end-inclusive reading a point-in-time order match uses
 *   - priceBookingSlots (real DB): weekday & weekend slots inside/outside a
 *     window, a slot straddling a rule boundary, per-head + happy hour +
 *     weekend composing correctly (day rate -> HH discount per segment ->
 *     × players), and the opt-out case (no active rule) is byte-identical
 *     to before this ticket
 *   - the snapshot freezes onto booking_slots (rate_applied / slot_total /
 *     happy_hour_applied) — a later rule change never restates an existing
 *     booking
 *   - loadBookingLines -> priceBill reconciles a happy-hour-blended slot to
 *     the paise, via the same qty=1/unitPrice=slot_total shape a walk-in's
 *     blend already uses (a flat hours × rate_applied reconstruction cannot
 *     reproduce a per-segment blend)
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-happy-hours-reserved-bookings.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore, priceBookingSlots, updateBookingHeadCountCore } from '../lib/booking/service'
import { loadBookingLines } from '../lib/billing/invoice'
import { priceBill, round2 } from '../lib/billing/pricing'
import { priceElapsedTime, priceTimeRangeSegments } from '../lib/billing/elapsed-time'
import type { HappyHourRule } from '../lib/happy-hours/apply'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata' // UTC+5:30, no DST

// ── 1. priceTimeRangeSegments — pure, no DB ─────────────────────────────────
// Fixed weekday: 2026-08-11 is a Tuesday in IST.
const at = (hhmm: string) => new Date(`2026-08-11T${hhmm}:00+05:30`)

const rule = (overrides: Partial<HappyHourRule> = {}): HappyHourRule => ({
  id: 'hh1',
  name: 'Happy Hour',
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  startTime: '17:00',
  endTime: '18:00',
  discountType: 'fixed',
  discountValue: 40, // ₹120 → ₹80
  isActive: true,
  ...overrides,
})

function testPureSegments() {
  // ── no active rules: reproduces flat rate × hours exactly ────────────────
  {
    const r = priceTimeRangeSegments(at('14:00'), at('16:00'), 100, [], TZ)
    check('P1 no happy hours: total = 200 (2h × ₹100)', r.total === 200)
    check('P1 …discounted = false', r.discounted === false)
  }

  // ── fully inside a window ─────────────────────────────────────────────────
  {
    const hh = rule({ startTime: '15:00', endTime: '18:00', discountType: 'percentage', discountValue: 20 })
    const r = priceTimeRangeSegments(at('15:30'), at('16:30'), 100, [hh], TZ)
    check('P2 1h fully inside a 20%-off window: total = 80', r.total === 80)
    check('P2 …discounted = true', r.discounted === true)
  }

  // ── straddling a rule boundary (exact window — no elapsed rounding) ──────
  {
    // 17:30–18:30, PS5 ₹120/₹80 (17:00–18:00, fixed ₹40 off):
    //   17:30–18:00 (30min) @ ₹80 = 40
    //   18:00–18:30 (30min) @ ₹120 = 60
    //   total = 100
    const r = priceTimeRangeSegments(at('17:30'), at('18:30'), 120, [rule()], TZ)
    check('P3 a slot straddling the HH boundary at 18:00: total = 100', r.total === 100)
    check('P3 …discounted = true', r.discounted === true)
  }

  // ── NO 30-min floor / 15-min round-up (unlike priceElapsedTime) ──────────
  {
    // A 20-min reserved slot bills its EXACT 20 minutes — the elapsed-time
    // 30-min floor is a walk-in concept (an unknown-until-checkout duration),
    // not a reserved booking's (its end is a firm commitment).
    const segmented = priceTimeRangeSegments(at('14:00'), at('14:20'), 120, [], TZ)
    check('P4 a 20-min reserved window bills its exact duration: total = 40 (20min × ₹120/hr)', segmented.total === 40)

    // priceElapsedTime, on the SAME window, DOES apply the 30-min floor —
    // proving the two engines deliberately disagree here.
    const elapsed = priceElapsedTime(at('14:00'), at('14:20'), 120, [], TZ)
    check(
      'P4 …contrast: priceElapsedTime on the identical window bills the 30-min floor instead: unitPrice = 60',
      elapsed.unitPrice === 60,
    )
  }

  // ── half-open [start,end): the discount reverts EXACTLY at the rule's end ─
  {
    const startsAtRuleStart = priceTimeRangeSegments(at('17:00'), at('17:30'), 100, [rule()], TZ)
    check(
      'P5 a segment starting exactly AT a rule\'s start IS discounted: total = 30 (0.5h × ₹60)',
      startsAtRuleStart.total === 30 && startsAtRuleStart.discounted === true,
    )
    const startsAtRuleEnd = priceTimeRangeSegments(at('18:00'), at('19:00'), 100, [rule()], TZ)
    check(
      'P5 …but a segment starting exactly AT a rule\'s end is NOT — half-open [start,end), same as elapsed-time\'s ruleActiveAt: total = 100',
      startsAtRuleEnd.total === 100 && startsAtRuleEnd.discounted === false,
    )
  }

  // ── biggest-discount-wins tie-break, same as applyHappyHour/priceElapsedTime ─
  {
    const small = rule({ id: 'small', discountType: 'fixed', discountValue: 10 })
    const big = rule({ id: 'big', discountType: 'fixed', discountValue: 50 })
    const r = priceTimeRangeSegments(at('17:00'), at('18:00'), 100, [small, big], TZ)
    check('P6 two overlapping rules: the bigger discount wins: total = 50 (1h × ₹50)', r.total === 50)
  }
}

// ── 2. priceBookingSlots / createBookingCore / loadBookingLines — real DB ───
async function testReservedBookingsHappyHours() {
  loadEnv()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  const slug = 'testhappyhourbookings'
  const t = await ownerPool.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe')
     on conflict (slug) do update set name=excluded.name returning id`,
    [slug, `${slug} co`, TZ],
  )
  const tenantId = t.rows[0].id
  const b = await ownerPool.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId],
  )
  const branchId = b.rows[0].id
  const u = await ownerPool.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`,
    [`owner@${slug}.test`],
  )
  const userId = u.rows[0].id
  const m = await ownerPool.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
    [tenantId, userId],
  )
  const membershipId = m.rows[0].id

  // Idempotent against a previous run that died mid-way — see the matching
  // comment in test-weekend-pricing.ts.
  await ownerPool.query(`delete from booking_slots where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from bookings where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from happy_hours where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from business_profiles where tenant_id = $1`, [tenantId])

  // PS5: weekday ₹100/hr, weekend ₹200/hr.
  const ps5Type = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate) values ($1,'PS5 HappyHour','100.00','200.00')
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=excluded.weekend_rate
     returning id`,
    [tenantId],
  )
  const ps5A = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'PS5-HH-A','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, ps5Type.rows[0].id],
  )
  // A second station of the same type — used for the snapshot-freeze block
  // (i) so its three successive bookings never contend with ps5A's own
  // timeline above for the exclusion constraint.
  const ps5B = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'PS5-HH-B','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, ps5Type.rows[0].id],
  )

  // Snooker: per_head, min 2 players — weekday ₹50/hr/player, weekend ₹80/hr/player.
  const snookerType = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate,pricing_mode,min_players)
     values ($1,'Snooker HappyHour','50.00','80.00','per_head',2)
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=excluded.weekend_rate,
       pricing_mode=excluded.pricing_mode, min_players=excluded.min_players returning id`,
    [tenantId],
  )
  const snookerA = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Snooker-HH-A','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, snookerType.rows[0].id],
  )

  const ctx = { tenantId, timezone: TZ, membershipId }

  // Confirmed fixed calendar: 2046-03-16 Fri, -17 Sat, -20 Tue. Far enough
  // out to never collide with another suite's bookings.
  const tue = (hhmm: string) => new Date(`2046-03-20T${hhmm}:00+05:30`)
  const sat = (hhmm: string) => new Date(`2046-03-17T${hhmm}:00+05:30`)

  async function bookAndLoad(resourceId: string, startsAt: Date, endsAt: Date, headCount?: number) {
    const booking = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        headCount,
        slots: [{ resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }],
      }),
    )
    const { rows } = await ownerPool.query(
      `select rate_applied, slot_total, happy_hour_applied from booking_slots where booking_id = $1`,
      [booking.id],
    )
    return {
      bookingId: booking.id,
      rateApplied: rows[0].rate_applied as string,
      slotTotal: rows[0].slot_total as string,
      happyHourApplied: rows[0].happy_hour_applied as boolean,
    }
  }

  // ── a. opt-out: no active rule at all — byte-identical to before this ticket ─
  {
    const r = await bookAndLoad(ps5A.rows[0].id, tue('14:00'), tue('16:00'))
    check('T1 no happy-hour rule exists: rate_applied = 100.00', r.rateApplied === '100.00')
    check('T1 …slot_total = 200.00 (2h × ₹100)', r.slotTotal === '200.00')
    check('T1 …happy_hour_applied = false', r.happyHourApplied === false)
  }

  // Now configure an evening happy hour: 17:00–19:00, every day, 50% off.
  await ownerPool.query(
    `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value,is_active)
     values ($1,'Evening 50% off','{0,1,2,3,4,5,6}','17:00','19:00','percentage',50,true)
     on conflict do nothing`,
    [tenantId],
  )

  // ── b. weekday slot fully INSIDE the window ───────────────────────────────
  {
    const r = await bookAndLoad(ps5A.rows[0].id, tue('17:00'), tue('18:00'))
    check('T2 weekday 1h fully inside the window: rate_applied = 50.00 (₹100 × 50% off)', r.rateApplied === '50.00')
    check('T2 …slot_total = 50.00', r.slotTotal === '50.00')
    check('T2 …happy_hour_applied = true', r.happyHourApplied === true)
  }

  // ── c. weekday slot fully OUTSIDE the window ──────────────────────────────
  {
    const r = await bookAndLoad(ps5A.rows[0].id, tue('10:00'), tue('11:00'))
    check('T3 weekday 1h outside the window: rate_applied = 100.00 (full rate)', r.rateApplied === '100.00')
    check('T3 …slot_total = 100.00', r.slotTotal === '100.00')
    check('T3 …happy_hour_applied = false', r.happyHourApplied === false)
  }

  // ── d. weekend slot fully INSIDE the window — composes weekend + HH ──────
  {
    const r = await bookAndLoad(ps5A.rows[0].id, sat('17:00'), sat('18:00'))
    check(
      'T4 weekend 1h fully inside the window: rate_applied = 100.00 (₹200 weekend rate × 50% off)',
      r.rateApplied === '100.00',
    )
    check('T4 …slot_total = 100.00', r.slotTotal === '100.00')
    check('T4 …happy_hour_applied = true', r.happyHourApplied === true)
  }

  // ── e. weekend slot fully OUTSIDE the window — weekend rate only ─────────
  {
    const r = await bookAndLoad(ps5A.rows[0].id, sat('10:00'), sat('11:00'))
    check('T5 weekend 1h outside the window: rate_applied = 200.00 (weekend rate, no HH)', r.rateApplied === '200.00')
    check('T5 …happy_hour_applied = false', r.happyHourApplied === false)
  }

  // ── f. weekday slot STRADDLING the rule's own END boundary (19:00) — chosen
  // to not overlap T2's 17:00–18:00 booking above, on the SAME resource.
  {
    // 18:30–19:30: 18:30–19:00 (30min) @ ₹50 (50% off) = 25, 19:00–19:30 (30min) @ ₹100 = 50.
    const r = await bookAndLoad(ps5A.rows[0].id, tue('18:30'), tue('19:30'))
    check('T6 a slot straddling the HH boundary: slot_total = 75.00 (25 + 50)', r.slotTotal === '75.00')
    check('T6 …rate_applied = 75.00 (blended: 75 / 1h)', r.rateApplied === '75.00')
    check('T6 …happy_hour_applied = true', r.happyHourApplied === true)
  }

  // ── g. per-head + happy hour + weekend, reconciling to the paise through
  // loadBookingLines -> priceBill. Sat 16:30–18:00 (1.5h), 3 players:
  //   16:30–17:00 (0.5h) @ ₹80/player = 40/player
  //   17:00–18:00 (1h)   @ ₹40/player (50% off) = 40/player
  //   rawTotal (per player) = 80 -> × 3 players = 240.00 exactly.
  let perHeadBookingId = ''
  {
    const r = await bookAndLoad(snookerA.rows[0].id, sat('16:30'), sat('18:00'), 3)
    check('T7 per-head + weekend + HH boundary straddle: slot_total = 240.00', r.slotTotal === '240.00')
    check('T7 …happy_hour_applied = true', r.happyHourApplied === true)
    perHeadBookingId = r.bookingId

    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, perHeadBookingId, TZ))
    check('T7 loadBookingLines returns exactly one line', lines.length === 1)
    const [line] = lines
    // The happy-hour-flagged shape: qty=1, unitPrice=the whole slot_total —
    // NOT hours × rate_applied, which cannot reproduce a per-segment blend
    // (see loadBookingLines' doc comment).
    check('T7 …bills as qty=1, unitPrice=240 (the exact blended total, not hours × rate)', line.qty === 1 && line.unitPrice === 240)

    const bill = priceBill({ lines, discount: 40 })
    check('T7 …priceBill: subtotal = 240.00', bill.subtotal === 240)
    check(
      'T7 …reconciles to the paise with a discount on top: subtotal − discount + tax = total',
      round2(bill.subtotal - bill.discount + bill.taxTotal) === bill.total,
    )
  }

  // ── g2. editing head_count on a happy-hour-blended per-head slot must
  // reprice off the exact stored segment total, not a flat reconstruction
  // through rate_applied — rate_applied is a per-segment BLEND rounded to
  // cents (see updateBookingHeadCountCore's doc comment), so hours × that
  // rounded rate × a new head_count drifts from the true total. Same Sat
  // 16:30–18:00 booking as T7 (rawTotal/player = 80 exactly), 3 → 5 players:
  //   correct: 5 × 80 = 400.00
  //   flat rate_applied (53.33, rounded from 53.333…) reconstruction:
  //   5 × 53.33 × 1.5h = 399.98 — a cent short, and wrong.
  {
    await withUser(userId, (tx) =>
      updateBookingHeadCountCore(tx, { tenantId }, { bookingId: perHeadBookingId, headCount: 5 }),
    )
    const { rows } = await ownerPool.query(
      `select b.subtotal, b.total, s.slot_total, s.head_count as slot_head_count
       from bookings b join booking_slots s on s.booking_id = b.id where b.id = $1`,
      [perHeadBookingId],
    )
    const row = rows[0]
    check(
      'T7b editing 3→5 players on a happy-hour-blended slot: slot_total = 400.00 (segment-accurate, not 399.98)',
      row.slot_total === '400.00',
    )
    check('T7b …bookings.subtotal/total refreshed to 400.00', row.subtotal === '400.00' && row.total === '400.00')
    check('T7b …booking_slots.head_count snapshot = 5', row.slot_head_count === 5)

    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, perHeadBookingId, TZ))
    const billed = round2(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0))
    check('T7b …and the billed line reconciles to 400.00', billed === 400)
  }

  // ── h. composition order, proven directly via priceBookingSlots: resolve
  // day rate -> happy-hour discount per segment -> × players (not any other
  // order — e.g. discounting a pre-multiplied total would give a different,
  // wrong figure whenever headCount > 1 and a segment is undiscounted).
  {
    const priced = await withUser(userId, (tx) =>
      priceBookingSlots(tx, { tenantId, timezone: TZ }, {
        branchId,
        headCount: 3,
        slots: [
          { resourceId: snookerA.rows[0].id, startsAt: sat('16:30').toISOString(), endsAt: sat('18:00').toISOString() },
        ],
      }),
    )
    check('T8 priceBookingSlots called directly resolves the same composed total: subtotal = 240', priced.subtotal === 240)
    check('T8 …happyHourApplied is surfaced on the returned slot', priced.slots[0].happyHourApplied === true)
  }

  // ── i. snapshot freeze: a later happy-hour rule change can't restate an
  // existing booking — same discipline rate_applied/tax_rate_percent already
  // have (0092/0095). Three successive, non-overlapping half-hour bookings
  // on ps5B (a fresh resource — see its own comment above) so this block's
  // own bookings never contend with each other for the exclusion constraint.
  {
    const frozen = await bookAndLoad(ps5B.rows[0].id, tue('17:00'), tue('17:30'))
    check('T9 setup: booked at 50% off: rate_applied = 50.00, slot_total = 25.00', frozen.rateApplied === '50.00' && frozen.slotTotal === '25.00')

    await ownerPool.query(`update happy_hours set discount_value = '90' where tenant_id = $1`, [tenantId])

    const { rows } = await ownerPool.query(
      `select rate_applied, slot_total, happy_hour_applied from booking_slots where booking_id = $1`,
      [frozen.bookingId],
    )
    check('T9 …rate_applied STAYS 50.00 after the rule changes to 90% off', rows[0].rate_applied === '50.00')
    check('T9 …slot_total stays frozen too: 25.00', rows[0].slot_total === '25.00')
    check('T9 …happy_hour_applied stays true', rows[0].happy_hour_applied === true)

    // A NEW booking in the same window, taken AFTER the change, correctly
    // gets the now-current 90%-off rule — proves this is a freeze on the old
    // booking, not a resolver stuck reading a stale rule.
    const fresh = await bookAndLoad(ps5B.rows[0].id, tue('17:30'), tue('18:00'))
    check(
      'T9 …but a NEW booking taken after the change bills the current rule: rate_applied = 10.00 (₹100 × 90% off)',
      fresh.rateApplied === '10.00',
    )

    // Deactivating the rule entirely (vs. no rule existing at all, T1) also
    // stops it applying to any new booking, without touching past ones.
    await ownerPool.query(`update happy_hours set is_active = false where tenant_id = $1`, [tenantId])
    const deactivated = await bookAndLoad(ps5B.rows[0].id, tue('18:00'), tue('18:30'))
    check(
      'T9 …deactivating the rule: a new booking in the same window now bills full rate: rate_applied = 100.00',
      deactivated.rateApplied === '100.00' && deactivated.happyHourApplied === false,
    )
    check('T9 …and the earlier frozen booking is STILL unaffected: rate_applied = 50.00', (
      await ownerPool.query(`select rate_applied from booking_slots where booking_id = $1`, [frozen.bookingId])
    ).rows[0].rate_applied === '50.00')
  }

  await ownerPool.query('delete from tenants where id = $1', [tenantId])
  await ownerPool.query(`delete from users where email = $1`, [`owner@${slug}.test`])
  await ownerPool.end()
  await appPool.end()
}

async function main() {
  testPureSegments()
  await testReservedBookingsHappyHours()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
