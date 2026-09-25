/**
 * Pure logic behind the walk-in "check availability" calendar
 * (lib/booking/walkin-availability.ts). No database — same category as
 * scripts/test-format-dates.ts and scripts/test-pricing.ts.
 *
 *   npx tsx scripts/test-walkin-availability-window.ts
 */
import { computeAvailabilityWindow, formatAvailableWindow } from '../lib/booking/walkin-availability'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

const T = (hhmm: string) => `2026-09-24T${hhmm}:00.000Z`

async function main() {
  // ══ 1. the three worked examples from the spec ═══════════════════════════
  section('2:30 start, next booking 3:00 → 30 minutes')
  {
    const w = computeAvailabilityWindow(T('14:30'), T('15:00'))
    check('status is available', w.status === 'available')
    check('30 minutes exactly', w.status === 'available' && w.availableMinutes === 30)
    check('formats as "30 minutes"', w.status === 'available' && formatAvailableWindow(w.availableMinutes) === '30 minutes')
  }

  section('2:30 start, next booking 3:47 → 1h 17m')
  {
    const w = computeAvailabilityWindow(T('14:30'), T('15:47'))
    check('status is available', w.status === 'available')
    check('77 minutes exactly', w.status === 'available' && w.availableMinutes === 77)
    check('formats as "1h 17m"', w.status === 'available' && formatAvailableWindow(w.availableMinutes) === '1h 17m')
  }

  section('2:30 start, next booking 5:30 → 3 hours')
  {
    const w = computeAvailabilityWindow(T('14:30'), T('17:30'))
    check('status is available', w.status === 'available')
    check('180 minutes exactly', w.status === 'available' && w.availableMinutes === 180)
    check('formats as "3 hours"', w.status === 'available' && formatAvailableWindow(w.availableMinutes) === '3 hours')
  }

  // ══ 2. no future booking → open-ended, never a fake end time ═════════════
  section('2:30 start, no future booking → open-ended')
  {
    const w = computeAvailabilityWindow(T('14:30'), null)
    check('status is open_ended', w.status === 'open_ended')
    check('carries no invented end time', !('nextBookingStartsAt' in w) && !('availableMinutes' in w))
  }

  // ══ 3. overlap / exact-equal start → unavailable, not a zero window ══════
  section('selected start at or past the next booking → unavailable')
  {
    const exact = computeAvailabilityWindow(T('15:00'), T('15:00'))
    check('exact match is unavailable, not a 0-minute "available"', exact.status === 'unavailable')

    const past = computeAvailabilityWindow(T('15:10'), T('15:00'))
    check('starting after the next booking already began is unavailable', past.status === 'unavailable')
  }

  // ══ 4. resources are independent — this module only ever sees ONE at a time,
  //       so "independence" here is: the SAME start time against different
  //       next-booking inputs never leaks state between calls. ═══════════════
  section('independent per resource (no shared state between calls)')
  {
    const snooker1 = computeAvailabilityWindow(T('14:30'), T('15:00')) // booked 3:00
    const snooker2 = computeAvailabilityWindow(T('14:30'), null) // free all day
    const snooker3 = computeAvailabilityWindow(T('14:30'), T('16:30')) // booked 4:30
    check('Snooker #1 is available for 30 min', snooker1.status === 'available' && snooker1.availableMinutes === 30)
    check('Snooker #2 stays open-ended regardless of #1', snooker2.status === 'open_ended')
    check('Snooker #3 is available for 2h independent of #1/#2', snooker3.status === 'available' && snooker3.availableMinutes === 120)
  }

  // ══ 5. formatting edge cases ══════════════════════════════════════════════
  section('formatAvailableWindow edge cases')
  check('1 minute is singular', formatAvailableWindow(1) === '1 minute')
  check('59 minutes stays in minutes', formatAvailableWindow(59) === '59 minutes')
  check('60 minutes is "1 hour"', formatAvailableWindow(60) === '1 hour')
  check('120 minutes is "2 hours"', formatAvailableWindow(120) === '2 hours')
  check('61 minutes is "1h 1m"', formatAvailableWindow(61) === '1h 1m')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
