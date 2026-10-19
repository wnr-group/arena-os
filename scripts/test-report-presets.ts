/**
 * Report quick-range chips (M34 #6) — pure logic, no database.
 *
 *   - one definition of every preset: the report chips agree with the bookings
 *     resolver for the five shared presets, and "Last 30 days" is exactly the
 *     reports' implicit default
 *   - no silent clamp: every preset, on every day across leap and non-leap
 *     years, survives resolveDateRange unchanged (<= 366 days); "Last year" is
 *     366 days in a leap year and fits exactly
 *   - the tenant's "today" drives the presets (zones ahead of UTC near midnight)
 *   - active-chip derivation: preset URL, default load, custom range
 *   - P&L: which presets are partial-month (payroll note shown) and which are not
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-report-presets.ts
 */
import {
  RANGE_PRESETS,
  REPORT_PRESETS,
  matchingReportPresets,
  resolvePresetDates,
  resolveRange,
  type ReportPreset,
} from '../lib/booking/ranges'
import { addDays, todayInZone } from '../lib/booking/time'
import { daysInRange, resolveDateRange } from '../lib/reports/date-range'
import { isWholeMonths } from '../lib/reports/pnl'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

// ── one definition ──────────────────────────────────────────────────────────
for (const today of ['2026-10-14', '2044-02-29', '2045-05-31', '2045-01-01', '2044-12-31']) {
  const same = RANGE_PRESETS.every((p) => {
    const a = resolvePresetDates(p, today)
    const b = resolveRange(p, today, 'Asia/Kolkata')
    return a.fromDate === b.fromDate && a.toDate === b.toDate
  })
  check(`${today}: report presets == bookings resolver for the shared five`, same)
}
check('bookings chips are unchanged (no last30 there)', !(RANGE_PRESETS as readonly string[]).includes('last30'))

// ── Last 30 days IS the default ─────────────────────────────────────────────
{
  const now = new Date('2026-10-14T08:00:00Z')
  const def = resolveDateRange({}, { timeZone: 'Asia/Kolkata', now })
  const l30 = resolvePresetDates('last30', todayInZone('Asia/Kolkata', now))
  check('last30 equals the default range of resolveDateRange', def.start === l30.fromDate && def.end === l30.toDate)
  check('last30 spans exactly 30 days', daysInRange(def) === 30)
  check(
    'default load highlights Last 30 days only',
    matchingReportPresets(def.start, def.end, todayInZone('Asia/Kolkata', now)).join() === 'last30',
  )
}

// ── no silent clamp, ever ───────────────────────────────────────────────────
{
  let worst = 0
  let clamped = 0
  let n = 0
  for (let d = '2043-01-01'; d <= '2046-12-31'; d = addDays(d, 1)) {
    for (const p of REPORT_PRESETS) {
      const r = resolvePresetDates(p, d)
      const days = daysInRange({ start: r.fromDate, end: r.toDate })
      worst = Math.max(worst, days)
      const out = resolveDateRange({ start: r.fromDate, end: r.toDate }, { timeZone: 'UTC' })
      if (out.start !== r.fromDate || out.end !== r.toDate) clamped++
      n++
    }
  }
  check(`${n} preset/day combinations over 4 years: none clamped by resolveDateRange`, clamped === 0)
  check(`longest preset is 366 days (got ${worst})`, worst === 366)

  const leap = resolvePresetDates('lastyear', '2025-03-10') // 2024 is a leap year
  check('Last year (2024, leap) is 366 days and survives resolveDateRange untouched', daysInRange({ start: leap.fromDate, end: leap.toDate }) === 366 && resolveDateRange({ start: leap.fromDate, end: leap.toDate }, { timeZone: 'UTC' }).start === '2024-01-01')
  const plain = resolvePresetDates('lastyear', '2026-10-14')
  check('Last year (2025, non-leap) is 365 days', daysInRange({ start: plain.fromDate, end: plain.toDate }) === 365)
}

// ── tenant "today" drives everything ────────────────────────────────────────
{
  // 20:00Z on 13 Oct: Auckland (+13) is already 14 Oct 09:00; Los Angeles (-7) is 13 Oct 13:00.
  const now = new Date('2026-10-13T20:00:00Z')
  const akl = todayInZone('Pacific/Auckland', now)
  const lax = todayInZone('America/Los_Angeles', now)
  check('zone-ahead tenant is on the 14th, zone-behind on the 13th', akl === '2026-10-14' && lax === '2026-10-13')
  const r = resolvePresetDates('last7', akl)
  check('Auckland Last 7 days ends on the tenant day (14 Oct)', r.toDate === '2026-10-14' && r.fromDate === '2026-10-08')
  check('Auckland Yesterday is the 13th', resolvePresetDates('yesterday', akl).fromDate === '2026-10-13')
  check('Auckland This month is month-to-date of October', resolvePresetDates('month', akl).fromDate === '2026-10-01')
  // India (+05:30) just after local midnight but still the previous UTC day.
  const ist = todayInZone('Asia/Kolkata', new Date('2026-12-31T18:45:00Z'))
  check('IST at 00:15 on 1 Jan is already the new year → Last year is the year just ended', ist === '2027-01-01' && resolvePresetDates('lastyear', ist).fromDate === '2026-01-01')
}

// ── active chip ─────────────────────────────────────────────────────────────
{
  const today = '2026-10-14'
  const p = resolvePresetDates('last3m', today)
  check('pasted Last 3 months URL highlights exactly that chip', matchingReportPresets(p.fromDate, p.toDate, today).join() === 'last3m')
  check('a custom range highlights none', matchingReportPresets('2026-09-03', '2026-09-19', today).length === 0)
  check('same from, different to highlights none', matchingReportPresets(p.fromDate, '2026-10-13', today).length === 0)
  // Presets are distinct from each other on an ordinary day.
  const seen = new Set(REPORT_PRESETS.map((x) => JSON.stringify(resolvePresetDates(x, today))))
  check('all six presets are distinct on an ordinary day', seen.size === REPORT_PRESETS.length)
}

// ── P&L: partial-month presets flag the report approximate ──────────────────
{
  const today = '2026-10-14'
  const whole = (p: ReportPreset) => {
    const r = resolvePresetDates(p, today)
    return isWholeMonths({ start: r.fromDate, end: r.toDate })
  }
  for (const p of ['yesterday', 'last7', 'last30', 'month', 'last3m'] as const) {
    check(`mid-month ${p}: partial months → approximate payroll note`, whole(p) === false)
  }
  check('Last year is whole months → no approximate note', whole('lastyear') === true)
  const eom = resolvePresetDates('month', '2026-10-31')
  check('This month on the last day of the month is whole months', isWholeMonths({ start: eom.fromDate, end: eom.toDate }))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
