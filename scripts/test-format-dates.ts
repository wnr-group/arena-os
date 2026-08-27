/**
 * Proves prettyDate() renders a plain calendar date unchanged at every timezone
 * offset the world actually uses.
 *
 *   npx tsx scripts/test-format-dates.ts
 *
 * Pure logic, so like scripts/test-pricing.ts it needs no database.
 *
 * ── What this exists to stop coming back ────────────────────────────────────
 *
 * prettyDate() used to anchor the date at 12:00 UTC and format that instant in
 * the caller's timezone. Noon survives any offset within ±11 hours, so every
 * test anyone was likely to run by hand — Kolkata, London, New York — passed,
 * while a venue in Auckland (UTC+12) or Kiritimati (UTC+14) saw every date in
 * the app rendered one day late.
 *
 * The sweep below therefore walks the FULL offset range rather than a couple of
 * familiar zones, and includes both DST states of the southern-hemisphere zones
 * where the offset changes across the year.
 */
import { prettyDate } from '../lib/format'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

/**
 * Every IANA zone below, spanning UTC-11 to UTC+14 — the real extremes, not a
 * comfortable middle. Kiritimati is the furthest east on Earth; Midway the
 * furthest west in common use.
 */
const ZONES = [
  'Pacific/Midway', // UTC-11
  'Pacific/Honolulu', // UTC-10
  'America/Anchorage', // UTC-9/-8
  'America/Los_Angeles', // UTC-8/-7
  'America/Denver', // UTC-7/-6
  'America/Chicago', // UTC-6/-5
  'America/New_York', // UTC-5/-4
  'America/Sao_Paulo', // UTC-3
  'Atlantic/Azores', // UTC-1/0
  'Europe/London', // UTC+0/+1
  'Europe/Berlin', // UTC+1/+2
  'Europe/Moscow', // UTC+3
  'Asia/Dubai', // UTC+4
  'Asia/Kolkata', // UTC+5:30  ← the project default
  'Asia/Kathmandu', // UTC+5:45  ← a 45-minute offset
  'Asia/Dhaka', // UTC+6
  'Asia/Bangkok', // UTC+7
  'Asia/Shanghai', // UTC+8
  'Asia/Tokyo', // UTC+9
  'Australia/Darwin', // UTC+9:30
  'Australia/Sydney', // UTC+10/+11
  'Pacific/Norfolk', // UTC+11/+12
  'Pacific/Auckland', // UTC+12/+13  ← was off by one
  'Pacific/Chatham', // UTC+12:45/+13:45
  'Pacific/Kiritimati', // UTC+14      ← was off by one
  'UTC',
]

/** '2026-08-28' → '28 Aug 2026', so a rendered string can be checked exactly. */
function expectedFor(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]
  return `${d} ${month} ${y}`
}

async function main() {
  // ══ 1. the regression, named ═══════════════════════════════════════════════
  section('the UTC+12-and-beyond regression')

  check(
    'Pacific/Auckland renders 28 Aug as 28 Aug, not 29',
    prettyDate('2026-08-28', 'Pacific/Auckland').includes('28 Aug 2026'),
  )
  check(
    'Pacific/Kiritimati (UTC+14) renders 28 Aug as 28 Aug',
    prettyDate('2026-08-28', 'Pacific/Kiritimati').includes('28 Aug 2026'),
  )
  check(
    'Pacific/Chatham (UTC+12:45) renders 28 Aug as 28 Aug',
    prettyDate('2026-08-28', 'Pacific/Chatham').includes('28 Aug 2026'),
  )
  check(
    '…and the weekday is right too, not shifted with the day',
    prettyDate('2026-08-28', 'Pacific/Auckland').startsWith('Fri,'),
  )

  // ══ 2. the full offset sweep ═══════════════════════════════════════════════
  section('every offset from UTC-11 to UTC+14')

  // Dates chosen to cross the traps: month end, year end, leap day, and a day
  // either side of a DST transition in both hemispheres.
  const DATES = [
    '2026-01-01', // year start
    '2026-02-28',
    '2026-03-01',
    '2026-03-29', // EU DST forward
    '2026-04-05', // AU/NZ DST back
    '2026-06-15',
    '2026-08-28', // the reported case
    '2026-10-25', // EU DST back
    '2026-12-31', // year end
    '2028-02-29', // leap day
  ]

  let mismatches = 0
  const seen: string[] = []
  for (const zone of ZONES) {
    for (const date of DATES) {
      const out = prettyDate(date, zone)
      if (!out.includes(expectedFor(date))) {
        mismatches++
        if (seen.length < 5) seen.push(`${zone} ${date} → ${out}`)
      }
    }
  }
  if (mismatches > 0) console.log('   first mismatches:', seen.join(' | '))
  check(
    `all ${ZONES.length} zones × ${DATES.length} dates round-trip the calendar date`,
    mismatches === 0,
  )

  // Every zone must agree with every other — a calendar date has no zone, so
  // the rendered string cannot legitimately differ between them.
  let disagreements = 0
  for (const date of DATES) {
    const rendered = new Set(ZONES.map((z) => prettyDate(date, z)))
    if (rendered.size !== 1) disagreements++
  }
  check('the same date renders identically in every zone', disagreements === 0)

  // ══ 3. the parameter is genuinely ignored ══════════════════════════════════
  section('the timeZone argument')

  check(
    'omitting it gives the same answer as passing one',
    prettyDate('2026-08-28') === prettyDate('2026-08-28', 'Pacific/Auckland'),
  )
  check(
    '…and a nonsense zone cannot break it',
    prettyDate('2026-08-28', 'Not/AZone').includes('28 Aug 2026'),
  )

  // ══ 4. leap day and boundaries ═════════════════════════════════════════════
  section('boundaries')

  check('the leap day is 29 Feb, not 1 Mar', prettyDate('2028-02-29').includes('29 Feb 2028'))
  check('1 January keeps its year', prettyDate('2026-01-01').includes('1 Jan 2026'))
  check('31 December keeps its year', prettyDate('2026-12-31').includes('31 Dec 2026'))
  check('a single-digit day is not zero-padded', prettyDate('2026-06-05').includes('5 Jun 2026'))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
