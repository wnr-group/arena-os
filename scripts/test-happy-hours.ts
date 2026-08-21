/**
 * Proves the happy-hour pricing rule in lib/happy-hours/apply.ts:
 *   - a rule only applies when active, today's weekday is in days_of_week,
 *     and now falls within [start_time, end_time] (end-inclusive)
 *   - percentage vs fixed discount math, floored at zero
 *   - when two rules overlap, the biggest discount wins (deterministic)
 *   - timezone-aware: the tenant's wall clock decides, not the server's
 *
 * Pure logic, so like test-pricing.ts this needs no database.
 *
 *   npx tsx scripts/test-happy-hours.ts
 */
import { applyHappyHour, type HappyHourRule } from '../lib/happy-hours/apply'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata' // UTC+5:30, no DST

const rule = (overrides: Partial<HappyHourRule> = {}): HappyHourRule => ({
  id: 'r1',
  name: 'Weekday Evening Special',
  daysOfWeek: [1, 2, 3, 4, 5], // Mon–Fri
  startTime: '15:00',
  endTime: '18:00',
  discountType: 'percentage',
  discountValue: 20,
  isActive: true,
  ...overrides,
})

/** 2026-08-11 is a Tuesday in IST. */
const tuesdayAt = (hhmm: string) => new Date(`2026-08-11T${hhmm}:00+05:30`)
/** 2026-08-09 is a Sunday in IST. */
const sundayAt = (hhmm: string) => new Date(`2026-08-09T${hhmm}:00+05:30`)

function main() {
  // ── 1. inside the window, matching weekday ────────────────────────────────
  {
    const r = applyHappyHour(100, [rule()], tuesdayAt('16:00'), TZ)
    check('T1 4pm Tue, 20% off ₹100: applies', r !== null)
    check('T1 unitPrice = 80', r?.unitPrice === 80)
    check('T1 originalPrice = 100', r?.originalPrice === 100)
    check('T1 rule id echoed back', r?.rule.id === 'r1')
  }

  // ── 2. before/after the window ────────────────────────────────────────────
  {
    check('T2 2:59pm Tue: does not apply yet', applyHappyHour(100, [rule()], tuesdayAt('14:59'), TZ) === null)
    check('T3 6:00pm Tue: still applies (end-inclusive)', applyHappyHour(100, [rule()], tuesdayAt('18:00'), TZ)?.unitPrice === 80)
    check('T4 6:01pm Tue: back to full price', applyHappyHour(100, [rule()], tuesdayAt('18:01'), TZ) === null)
  }

  // ── 3. wrong weekday ───────────────────────────────────────────────────────
  {
    check('T5 4pm Sunday (not in Mon–Fri rule): does not apply', applyHappyHour(100, [rule()], sundayAt('16:00'), TZ) === null)
  }

  // ── 4. inactive rule never applies ────────────────────────────────────────
  {
    check(
      'T6 inactive rule inside its own window: does not apply',
      applyHappyHour(100, [rule({ isActive: false })], tuesdayAt('16:00'), TZ) === null,
    )
  }

  // ── 5. fixed discount, floored at zero ────────────────────────────────────
  {
    const r = applyHappyHour(50, [rule({ discountType: 'fixed', discountValue: 80 })], tuesdayAt('16:00'), TZ)
    check('T7 ₹80 flat off a ₹50 item: floors at 0, never negative', r?.unitPrice === 0)
  }

  // ── 6. overlapping rules: biggest discount wins ───────────────────────────
  {
    const small = rule({ id: 'small', name: 'Small', discountType: 'percentage', discountValue: 10 })
    const big = rule({ id: 'big', name: 'Big', discountType: 'percentage', discountValue: 30 })
    const r1 = applyHappyHour(100, [small, big], tuesdayAt('16:00'), TZ)
    const r2 = applyHappyHour(100, [big, small], tuesdayAt('16:00'), TZ)
    check('T8 biggest discount wins regardless of list order (small, big)', r1?.rule.id === 'big' && r1.unitPrice === 70)
    check('T9 biggest discount wins regardless of list order (big, small)', r2?.rule.id === 'big' && r2.unitPrice === 70)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
