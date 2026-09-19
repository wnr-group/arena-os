/**
 * Proves priceElapsedTime in lib/billing/elapsed-time.ts (M21 #2):
 *   - no-HH session: plain rate × billable hours
 *   - a session fully inside a happy-hour window: the HH rate throughout
 *   - a session spanning ONE happy-hour boundary: per-segment pricing,
 *     reconciling to the worked example in the design doc (₹135.33)
 *   - a <30-min session bills the 30-min minimum
 *   - a session needing 15-min round-up bills the rounded-up time
 *   - a session spanning TWO happy-hour windows (with gaps) reconciles
 *     exactly to the sum of its segments
 *   - the function is pure: no mutation, deterministic, and its output
 *     (taxPercent overridden by the caller) flows correctly through
 *     priceBill for tax
 *
 * Pure logic, so like test-pricing.ts and test-happy-hours.ts this needs no
 * database.
 *
 *   npx tsx scripts/test-elapsed-time-pricing.ts
 */
import { priceElapsedTime } from '../lib/billing/elapsed-time'
import { priceBill, round2 } from '../lib/billing/pricing'
import type { HappyHourRule } from '../lib/happy-hours/apply'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata' // UTC+5:30, no DST

/** 2026-08-11 is a Tuesday in IST. */
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

function main() {
  // ── 1. no happy hour at all ───────────────────────────────────────────────
  {
    // 14:00→16:00, exactly 2h, already a multiple of 15 — no rounding at play.
    const r = priceElapsedTime(at('14:00'), at('16:00'), 100, [], TZ)
    check('T1 kind is booking', r.kind === 'booking')
    check('T1 qty is 1 — a single computed charge, like membership/adjustment lines', r.qty === 1)
    check('T1 taxPercent defaults to 0 — the caller snapshots the real rate', r.taxPercent === 0)
    check('T1 2h @ ₹100/hr, no HH: unitPrice = 200', r.unitPrice === 200)
  }

  // ── 2. session fully inside a happy-hour window ───────────────────────────
  {
    // 15:30→16:30 (60min) inside a 15:00–18:00, 20%-off window.
    const hh = rule({ startTime: '15:00', endTime: '18:00', discountType: 'percentage', discountValue: 20 })
    const r = priceElapsedTime(at('15:30'), at('16:30'), 100, [hh], TZ)
    check('T2 1h fully inside 20%-off HH: unitPrice = 80', r.unitPrice === 80)
  }

  // ── 3. session spanning ONE happy-hour boundary (the worked example) ─────
  {
    // 17:38→18:49, PS5 ₹120/₹80 (17:00–18:00 fixed ₹40 off) → ₹135.33.
    // elapsed 71min → 15-min round-up to 75min → billable window 17:38–18:53.
    //   17:38–18:00 (22min) @ HH ₹80  = 29.3333…
    //   18:00–18:53 (53min) @ full ₹120 = 106.0
    //   sum = 135.3333… → round2 = 135.33
    const r = priceElapsedTime(at('17:38'), at('18:49'), 120, [rule()], TZ)
    check('T3 71min crossing the HH boundary at 18:00: unitPrice = 135.33', r.unitPrice === 135.33)
  }

  // ── 4. a <30-min session bills the 30-min minimum ─────────────────────────
  {
    // 12:00→12:10 (10min), no HH, ₹60/hr → billable 30min → ₹30.
    const r = priceElapsedTime(at('12:00'), at('12:10'), 60, [], TZ)
    check('T4 a 10-min session bills the 30-min minimum: unitPrice = 30', r.unitPrice === 30)
  }
  {
    // Exactly 30min needs no bump — the minimum and the actual time coincide.
    const r = priceElapsedTime(at('12:00'), at('12:30'), 60, [], TZ)
    check('T4 an exact 30-min session is unaffected by the minimum: unitPrice = 30', r.unitPrice === 30)
  }

  // ── 5. a session needing 15-min round-up (not the minimum) ───────────────
  {
    // 12:00→12:40 (40min), no HH, ₹60/hr → ceil15(40) = 45min → ₹45.
    const r = priceElapsedTime(at('12:00'), at('12:40'), 60, [], TZ)
    check('T5 a 40-min session rounds up to 45min: unitPrice = 45', r.unitPrice === 45)
  }
  {
    // A session that's already an exact multiple of 15 is not bumped further.
    const r = priceElapsedTime(at('12:00'), at('12:45'), 60, [], TZ)
    check('T5 a 45-min session (already a multiple of 15) is unchanged: unitPrice = 45', r.unitPrice === 45)
  }

  // ── 6. a session spanning TWO happy-hour windows, with gaps ───────────────
  {
    // 11:30→17:30 (360min, no rounding needed), rate ₹100/hr:
    //   11:30–12:00 (30min) full rate       = 50.00
    //   12:00–13:00 (60min) lunch HH  ₹80/hr = 80.00
    //   13:00–17:00 (240min) full rate      = 400.00
    //   17:00–17:30 (30min) evening HH ₹70/hr = 35.00
    //   sum = 565.00
    const lunch = rule({ id: 'lunch', startTime: '12:00', endTime: '13:00', discountValue: 20 })
    const evening = rule({ id: 'evening', startTime: '17:00', endTime: '18:00', discountValue: 30 })
    const r = priceElapsedTime(at('11:30'), at('17:30'), 100, [lunch, evening], TZ)
    check('T6 a session spanning two HH windows reconciles to the sum of its segments: unitPrice = 565', r.unitPrice === 565)
  }

  // ── 7. overlapping rules: biggest discount wins, same tie-break as applyHappyHour ─
  {
    const small = rule({ id: 'small', startTime: '17:00', endTime: '18:00', discountType: 'percentage', discountValue: 10 })
    const big = rule({ id: 'big', startTime: '17:00', endTime: '18:00', discountType: 'percentage', discountValue: 50 })
    // 17:15→17:45 (30min) fully inside both overlapping rules, ₹100/hr.
    const r = priceElapsedTime(at('17:15'), at('17:45'), 100, [small, big], TZ)
    check('T7 the bigger of two overlapping HH discounts wins: unitPrice = 25 (50% off ₹100, 30min)', r.unitPrice === 25)
  }

  // ── 8. wrong weekday never applies ────────────────────────────────────────
  {
    // 2026-08-09 is a Sunday in IST; the rule only runs Tue (2).
    const tueOnly = rule({ daysOfWeek: [2] })
    const sunday = (hhmm: string) => new Date(`2026-08-09T${hhmm}:00+05:30`)
    const r = priceElapsedTime(sunday('17:30'), sunday('18:00'), 120, [tueOnly], TZ)
    check('T8 a rule scoped to Tuesday does not apply on Sunday: unitPrice = 60 (full ₹120/hr, 30min)', r.unitPrice === 60)
  }

  // ── 9. an inactive rule never applies ─────────────────────────────────────
  {
    const r = priceElapsedTime(at('17:15'), at('17:45'), 120, [rule({ isActive: false })], TZ)
    check('T9 an inactive HH rule is ignored: unitPrice = 60 (full rate, 30min)', r.unitPrice === 60)
  }

  // ── 10. purity: no mutation, fully deterministic ──────────────────────────
  {
    const rules = [rule()]
    const snapshot = JSON.stringify(rules)
    const start = at('17:38')
    const end = at('18:49')
    const first = priceElapsedTime(start, end, 120, rules, TZ)
    const second = priceElapsedTime(start, end, 120, rules, TZ)
    check('T10 the happyHours input is not mutated', JSON.stringify(rules) === snapshot)
    check('T10 the same input twice gives an identical result', JSON.stringify(first) === JSON.stringify(second))
    check('T10 the start/end Date objects are not mutated', start.getTime() === at('17:38').getTime() && end.getTime() === at('18:49').getTime())
  }

  // ── 11. the output flows through priceBill for correct tax + discount ────
  {
    const r = priceElapsedTime(at('17:38'), at('18:49'), 120, [rule()], TZ)
    const line = { ...r, taxPercent: 18 } // the caller snapshots the resource type's real tax rate
    const bill = priceBill({ lines: [line], discount: 35.33 })
    check('T11 priceElapsedTime output prices correctly through priceBill: subtotal = 135.33', bill.subtotal === 135.33)
    check('T11 …taxableValue = 100.00 after the discount', bill.taxableValue === 100)
    check('T11 …tax = 18.00 (18% of the discounted ₹100)', bill.taxTotal === 18)
    check('T11 …total = 118.00', bill.total === 118)
    check(
      'T11 reconciles: subtotal − discount + taxTotal === total',
      round2(bill.subtotal - bill.discount + bill.taxTotal) === bill.total,
    )
  }

  // ── 12. an OVERNIGHT happy-hour window (endTime < startTime) ──────────────
  // A 22:00–01:00 late-night rate anchored on Tuesday runs Tue 22:00 → Wed
  // 01:00. Previously dropped entirely (overcharging the promised discount).
  {
    const night = rule({ id: 'night', startTime: '22:00', endTime: '01:00' }) // ₹120 → ₹80
    // 2026-08-12 is the Wednesday after `at`'s Tuesday.
    const wed = (hhmm: string) => new Date(`2026-08-12T${hhmm}:00+05:30`)

    // Early hours of Wed are covered by TUESDAY's window (the bug: the instant's
    // own day has no window, only the day before does).
    const early = priceElapsedTime(wed('00:00'), wed('00:30'), 120, [night], TZ)
    check('T12 early-hours session inside an overnight window is discounted: unitPrice = 40', early.unitPrice === 40)

    // Late hours of the anchor day.
    const late = priceElapsedTime(at('22:30'), at('23:00'), 120, [night], TZ)
    check('T12 late-hours session inside an overnight window is discounted: unitPrice = 40', late.unitPrice === 40)

    // A session straddling the 01:00 end: 30min @₹80 + 30min @₹120 = 100.
    const cross = priceElapsedTime(wed('00:30'), wed('01:30'), 120, [night], TZ)
    check('T12 session crossing the overnight window end reconciles per segment: unitPrice = 100', cross.unitPrice === 100)

    // A rule scoped to Tuesday still covers Wednesday's early hours (the window
    // belongs to its START day), and does NOT apply on a later day's late hours.
    const tueNight = rule({ id: 'tuenight', startTime: '22:00', endTime: '01:00', daysOfWeek: [2] })
    const tueTail = priceElapsedTime(wed('00:00'), wed('00:30'), 120, [tueNight], TZ)
    check('T12 an overnight window belongs to its start weekday (Tue tail into Wed): unitPrice = 40', tueTail.unitPrice === 40)
    const wedLate = priceElapsedTime(wed('22:30'), wed('23:00'), 120, [tueNight], TZ)
    check('T12 …and a Tue-only overnight rule does not discount Wednesday night: unitPrice = 60', wedLate.unitPrice === 60)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main()
