/**
 * Advance-booking horizon helper (M37 #2) — pure logic, no database.
 *
 *   - N = 7 reproduces today's exact 7 dates; 30/90/180 likewise
 *   - tenant zones ahead of and behind UTC, probed at the instants either side
 *     of local midnight on the last bookable day
 *   - month / year boundaries and a leap day
 *   - a slot starting on the last day and running past midnight is IN (judged by
 *     its start); a per-day booking is judged by its end too
 *   - day-range length: 31 ok, 32 refused; end beyond the window refused
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-booking-horizon.ts
 */
import {
  MAX_DAY_RANGE_DAYS,
  calendarDaysInRange,
  dateOptions,
  dayRangeError,
  horizonEndsAt,
  isSlotEndWithinHorizon,
  isDateWithinHorizon,
  isWithinHorizon,
  lastBookableDate,
} from '../lib/booking/horizon'
import { addDays, todayInZone, zonedTimeToUtc } from '../lib/booking/time'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const IST = 'Asia/Kolkata'
const NY = 'America/New_York'
const NZ = 'Pacific/Auckland'

// ── lastBookableDate / dateOptions ──────────────────────────────────────────
console.log('\n── dates ──')
check('N=7 → today + 6', lastBookableDate('2045-04-20', 7) === '2045-04-26')
check('N=1 → today only', lastBookableDate('2045-04-20', 1) === '2045-04-20')
check('N=30 → today + 29', lastBookableDate('2045-04-20', 30) === '2045-05-19')
check('N=90 → today + 89', lastBookableDate('2045-04-20', 90) === '2045-07-18')
check('N=180 → today + 179', lastBookableDate('2045-04-20', 180) === '2045-10-16')
{
  const o = dateOptions('2045-04-20', 7)
  check(
    'N=7 reproduces the old strip exactly (addDays(today, i), i = 0..6)',
    o.length === 7 && o.every((d, i) => d === addDays('2045-04-20', i)),
  )
  for (const n of [7, 30, 90, 180]) {
    const x = dateOptions('2045-04-20', n)
    check(
      `N=${n}: ${n} ascending dates, first = today, last = lastBookableDate`,
      x.length === n && x[0] === '2045-04-20' && x[n - 1] === lastBookableDate('2045-04-20', n) && x.every((d, i) => i === 0 || d > x[i - 1]),
    )
  }
}
check('month boundary: Jan 28 + 6 → Feb 3', lastBookableDate('2045-01-28', 7) === '2045-02-03')
check('year boundary: Dec 28 + 6 → Jan 3', lastBookableDate('2045-12-28', 7) === '2046-01-03')
check('year boundary N=180 from Sep 1 spans into the next year', lastBookableDate('2045-09-01', 180) === '2046-02-27')
check('leap day is a bookable date (2048)', dateOptions('2048-02-25', 7).includes('2048-02-29'))
check('non-leap year skips Feb 29 (2047)', !dateOptions('2047-02-25', 7).some((d) => d.endsWith('02-29')))
check('leap: Feb 25 2048 + 6 → Mar 2', lastBookableDate('2048-02-25', 7) === '2048-03-02')
check('isDateWithinHorizon: last day in, next day out', isDateWithinHorizon('2045-04-26', '2045-04-20', 7) && !isDateWithinHorizon('2045-04-27', '2045-04-20', 7))

// ── isWithinHorizon around tenant-local midnight ────────────────────────────
console.log('\n── tenant-local midnight ──')
for (const tz of [IST, NY, NZ]) {
  for (const n of [7, 30, 90, 180]) {
    // "today" is whatever it is in that zone right now; probe the boundary relative to it.
    const today = todayInZone(tz, new Date('2045-04-20T12:00:00Z'))
    const last = lastBookableDate(today, n)
    const endOfLast = zonedTimeToUtc(addDays(last, 1), '00:00', tz) // first instant NOT bookable
    const ms = (d: Date, delta: number) => new Date(d.getTime() + delta)
    check(`${tz} N=${n}: 1s before local midnight after the last day → in`, isWithinHorizon(ms(endOfLast, -1000), null, today, tz, n))
    check(`${tz} N=${n}: exactly local midnight after the last day → out`, !isWithinHorizon(endOfLast, null, today, tz, n))
    check(`${tz} N=${n}: 00:00 on the last day → in`, isWithinHorizon(zonedTimeToUtc(last, '00:00', tz), null, today, tz, n))
    check(`${tz} N=${n}: horizonEndsAt is that first-out instant`, horizonEndsAt(today, tz, n).getTime() === endOfLast.getTime())
  }
}

// The same UTC instant is different tenant-local dates in different zones.
{
  const instant = new Date('2045-04-26T20:00:00Z') // 01:30 on Apr 27 in IST, 16:00 Apr 26 in NY
  check('IST (+05:30): that instant is already Apr 27 → out of a 7-day window from Apr 20', !isWithinHorizon(instant, null, '2045-04-20', IST, 7))
  check('NY (behind UTC): the same instant is still Apr 26 → in', isWithinHorizon(instant, null, '2045-04-20', NY, 7))
}

// ── slot judged by its start ────────────────────────────────────────────────
console.log('\n── start vs end ──')
{
  const tz = IST
  const today = '2045-04-20'
  const last = lastBookableDate(today, 7)
  const start = zonedTimeToUtc(last, '23:00', tz)
  const end = zonedTimeToUtc(addDays(last, 1), '01:00', tz)
  check('an hourly slot starting 23:00 on the last day and ending 01:00 next day is IN (judged by start)', isWithinHorizon(start, null, today, tz, 7))
  check('…but as a per-day booking its end date counts, so it is OUT', !isWithinHorizon(start, end, today, tz, 7))
  const dStart = zonedTimeToUtc(addDays(last, -2), '10:00', tz)
  const dEnd = zonedTimeToUtc(last, '22:00', tz)
  check('per-day booking ending on the last day is IN', isWithinHorizon(dStart, dEnd, today, tz, 7))
  const dEnd2 = zonedTimeToUtc(addDays(last, 1), '22:00', tz)
  check('per-day booking ending the day after the last day is OUT', !isWithinHorizon(dStart, dEnd2, today, tz, 7))
  // A "Dn close" of exactly local midnight belongs to the day BEFORE it.
  const midnightClose = zonedTimeToUtc(addDays(last, 1), '00:00', tz)
  check('a per-day close at exactly midnight after the last day is IN (close belongs to the day before)', isWithinHorizon(dStart, midnightClose, today, tz, 7))
  check('the past is never judged here (yesterday is IN)', isWithinHorizon(zonedTimeToUtc('2045-04-19', '10:00', tz), null, today, tz, 7))

  // Hourly slot END: the overnight allowance is the day after the last date, no further.
  const e = (d: string, t: string) => zonedTimeToUtc(d, t, tz)
  check('hourly end 01:00 the day after the last day is IN (overnight allowance)', isSlotEndWithinHorizon(e(addDays(last, 1), '01:00'), today, tz, 7))
  check('hourly end at exactly 00:00 two days after the last day is IN (belongs to the day before)', isSlotEndWithinHorizon(e(addDays(last, 2), '00:00'), today, tz, 7))
  check('hourly end 01:00 two days after the last day is OUT', !isSlotEndWithinHorizon(e(addDays(last, 2), '01:00'), today, tz, 7))
  check('a slot starting on the last day and ending months later is OUT (start alone says IN)', isWithinHorizon(start, null, today, tz, 7) && !isSlotEndWithinHorizon(e(addDays(last, 60), '10:00'), today, tz, 7))
  check('hourly end within the window is IN', isSlotEndWithinHorizon(e(last, '12:00'), today, tz, 7))
}

// ── day ranges ──────────────────────────────────────────────────────────────
console.log('\n── day ranges ──')
{
  const today = '2045-04-20'
  check('calendarDaysInRange: same day is 1', calendarDaysInRange('2045-04-20', '2045-04-20') === 1)
  check('31 days is accepted', dayRangeError('2045-04-20', addDays('2045-04-20', MAX_DAY_RANGE_DAYS - 1), today, 90) === null)
  check('32 days is refused', !!dayRangeError('2045-04-20', addDays('2045-04-20', MAX_DAY_RANGE_DAYS), today, 90))
  check('the 32-day message names the limit', /31/.test(dayRangeError('2045-04-20', '2045-05-21', today, 90) ?? ''))
  check('end on the last bookable date is accepted', dayRangeError('2045-04-24', '2045-04-26', today, 7) === null)
  check('end the day after the last bookable date is refused', !!dayRangeError('2045-04-24', '2045-04-27', today, 7))
  check('reversed range is refused', !!dayRangeError('2045-04-24', '2045-04-23', today, 7))
  check('31 days across a leap Feb is counted by the calendar', calendarDaysInRange('2048-02-15', '2048-03-16') === 31)
  check('32 days across Feb 29 is refused', !!dayRangeError('2048-02-15', '2048-03-17', '2048-02-15', 90))
  check('a 31-day range is still refused if it ends beyond a 7-day window', !!dayRangeError('2045-04-20', '2045-05-20', today, 7))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
