/**
 * Proves resolveRange / parseRangePreset in lib/booking/ranges.ts (M34 #1):
 *   - every preset's from/to dates for ordinary, month-end, leap-year and
 *     Jan 1 "today" values
 *   - last3m clamps to the target month's last day
 *   - UTC bounds are exactly 00:00 local (checked via Intl) in +05:30 and in
 *     America/New_York across both DST changes; endUtc is exclusive
 *   - tampered / unknown preset values parse to null without throwing
 *
 * Pure logic, no database.
 *
 *   npx tsx scripts/test-booking-ranges.ts
 */
import {
  parseRangePreset,
  resolveRange,
  RANGE_PRESETS,
  type RangePreset,
} from '../lib/booking/ranges'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const IST = 'Asia/Kolkata'
const NY = 'America/New_York'

function dates(p: RangePreset, today: string) {
  const r = resolveRange(p, today, IST)
  return `${r.fromDate}..${r.toDate}`
}

// ---- date math: [preset, today, expected] ----
const cases: [RangePreset, string, string][] = [
  ['yesterday', '2026-10-14', '2026-10-13..2026-10-13'],
  ['yesterday', '2026-01-01', '2025-12-31..2025-12-31'],
  ['yesterday', '2024-03-01', '2024-02-29..2024-02-29'],
  ['last7', '2026-10-14', '2026-10-08..2026-10-14'],
  ['last7', '2026-01-03', '2025-12-28..2026-01-03'],
  ['month', '2026-10-14', '2026-10-01..2026-10-14'],
  ['month', '2026-01-01', '2026-01-01..2026-01-01'],
  ['month', '2026-12-31', '2026-12-01..2026-12-31'],
  ['last3m', '2026-10-14', '2026-07-14..2026-10-14'],
  ['last3m', '2026-05-31', '2026-02-28..2026-05-31'], // clamp, non-leap
  ['last3m', '2024-05-31', '2024-02-29..2024-05-31'], // clamp, leap
  ['last3m', '2026-01-15', '2025-10-15..2026-01-15'], // year rollover
  ['last3m', '2026-03-01', '2025-12-01..2026-03-01'],
  ['last3m', '2026-08-31', '2026-05-31..2026-08-31'], // no clamp needed
  ['last3m', '2026-11-30', '2026-08-30..2026-11-30'],
  ['lastyear', '2026-10-14', '2025-01-01..2025-12-31'],
  ['lastyear', '2026-01-01', '2025-01-01..2025-12-31'],
  ['lastyear', '2025-02-10', '2024-01-01..2024-12-31'], // leap year as target
]
for (const [p, today, want] of cases) {
  const got = dates(p, today)
  check(`${p} @ ${today} → ${want}${got === want ? '' : ` (got ${got})`}`, got === want)
}

// ---- isSingleDay ----
check('yesterday is single day', resolveRange('yesterday', '2026-10-14', IST).isSingleDay)
check('month on the 1st is single day', resolveRange('month', '2026-10-01', IST).isSingleDay)
check('last7 is not single day', !resolveRange('last7', '2026-10-14', IST).isSingleDay)
check('lastyear is not single day', !resolveRange('lastyear', '2026-10-14', IST).isSingleDay)

// ---- UTC bounds ----
/** Local wall-clock `YYYY-MM-DD HH:mm` of an instant in tz. */
function wall(d: Date, tz: string): string {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d))
    p[x.type] = x.value
  const hh = p.hour === '24' ? '00' : p.hour
  return `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}`
}

const nextDay = (s: string) =>
  new Date(Date.parse(`${s}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)

function checkBounds(tz: string, p: RangePreset, today: string) {
  const r = resolveRange(p, today, tz)
  check(
    `${tz} ${p} @ ${today}: start is ${r.fromDate} 00:00 local`,
    wall(r.startUtc, tz) === `${r.fromDate} 00:00`,
  )
  check(
    `${tz} ${p} @ ${today}: end is ${nextDay(r.toDate)} 00:00 local (exclusive)`,
    wall(r.endUtc, tz) === `${nextDay(r.toDate)} 00:00`,
  )
  check(`${tz} ${p} @ ${today}: start < end`, r.startUtc < r.endUtc)
}

// +05:30 (no DST)
check(
  'IST yesterday @ 2026-10-14 → 2026-10-12T18:30Z .. 2026-10-13T18:30Z',
  (() => {
    const r = resolveRange('yesterday', '2026-10-14', IST)
    return (
      r.startUtc.toISOString() === '2026-10-12T18:30:00.000Z' &&
      r.endUtc.toISOString() === '2026-10-13T18:30:00.000Z'
    )
  })(),
)
for (const p of RANGE_PRESETS) checkBounds(IST, p, '2026-10-14')

// New York: spring forward 2026-03-08, fall back 2026-11-01
for (const today of [
  '2026-03-08',
  '2026-03-09',
  '2026-03-10',
  '2026-11-01',
  '2026-11-02',
  '2026-11-03',
  '2026-04-01',
]) {
  for (const p of RANGE_PRESETS) checkBounds(NY, p, today)
}
// A range spanning a DST change is 1h shorter / longer than N*24h.
{
  const r = resolveRange('yesterday', '2026-03-09', NY) // Mar 8, 23h long
  check('NY spring-forward day is 23h', r.endUtc.getTime() - r.startUtc.getTime() === 23 * 3600000)
  const f = resolveRange('yesterday', '2026-11-02', NY) // Nov 1, 25h long
  check('NY fall-back day is 25h', f.endUtc.getTime() - f.startUtc.getTime() === 25 * 3600000)
}

// ---- parseRangePreset ----
for (const p of RANGE_PRESETS) check(`parse "${p}"`, parseRangePreset(p) === p)
const bad: unknown[] = [
  undefined,
  null,
  '',
  'LAST7',
  ' last7',
  'last30',
  'today',
  '__proto__',
  'constructor',
  'toString',
  ['last7'],
  ['last7', 'month'],
  7,
  {},
  true,
  '2026-10-14',
]
for (const b of bad) {
  let out: RangePreset | null | 'threw' = 'threw'
  try {
    out = parseRangePreset(b)
  } catch {
    /* handled below */
  }
  check(`parse ${JSON.stringify(b)} → null`, out === null)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
