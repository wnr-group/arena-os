/**
 * Proves walkinCloseDeadline / nextClosingAfter (lib/booking/walkin-auto-close-rules.ts):
 *   - max-length only, closing-time only, and both (earlier wins)
 *   - a walk-in started after closing runs to the next day's closing
 *   - closed days are skipped; a 24-hour start day has no closing time
 *   - missing hours fall back to 10:00-22:00
 *
 * Pure logic, no database.   npx tsx scripts/test-walkin-auto-close-rules.ts
 */
import { walkinCloseDeadline, type DayHours } from '../lib/booking/walkin-auto-close-rules'
import { zonedTimeToUtc } from '../lib/booking/time'

const TZ = 'Asia/Kolkata'
let failures = 0
function check(name: string, ok: boolean) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
const at = (date: string, time: string) => zonedTimeToUtc(date, time, TZ)
const same = (a: Date | null, b: Date) => a !== null && a.getTime() === b.getTime()

const open = (closeTime = '22:00'): DayHours => ({ openTime: '10:00', closeTime, isClosed: false, open24h: false })
// 2030-01-07 is a Monday (dow 1).
const allDays = (h: DayHours) => new Map<number, DayHours>([0, 1, 2, 3, 4, 5, 6].map((d) => [d, h]))

const start = at('2030-01-07', '19:00')

check('max length only', same(
  walkinCloseDeadline({ startsAt: start, timeZone: TZ, limitMinutes: 120, atClosing: false, hoursByDow: allDays(open()) }),
  at('2030-01-07', '21:00')))

check('closing only', same(
  walkinCloseDeadline({ startsAt: start, timeZone: TZ, limitMinutes: null, atClosing: true, hoursByDow: allDays(open()) }),
  at('2030-01-07', '22:00')))

check('both: closing is earlier', same(
  walkinCloseDeadline({ startsAt: start, timeZone: TZ, limitMinutes: 480, atClosing: true, hoursByDow: allDays(open()) }),
  at('2030-01-07', '22:00')))

check('both: max length is earlier', same(
  walkinCloseDeadline({ startsAt: start, timeZone: TZ, limitMinutes: 60, atClosing: true, hoursByDow: allDays(open()) }),
  at('2030-01-07', '20:00')))

check('neither rule -> null', walkinCloseDeadline({
  startsAt: start, timeZone: TZ, limitMinutes: null, atClosing: false, hoursByDow: allDays(open()),
}) === null)

check('started after closing -> next day closing', same(
  walkinCloseDeadline({ startsAt: at('2030-01-07', '23:00'), timeZone: TZ, limitMinutes: null, atClosing: true, hoursByDow: allDays(open()) }),
  at('2030-01-08', '22:00')))

const tuesdayClosed = allDays(open())
tuesdayClosed.set(2, { openTime: '10:00', closeTime: '22:00', isClosed: true, open24h: false })
check('closed next day is skipped', same(
  walkinCloseDeadline({ startsAt: at('2030-01-07', '23:00'), timeZone: TZ, limitMinutes: null, atClosing: true, hoursByDow: tuesdayClosed }),
  at('2030-01-09', '22:00')))

const mondayFull = allDays(open())
mondayFull.set(1, { openTime: '00:00', closeTime: '23:59', isClosed: false, open24h: true })
check('24h start day: closing rule gives nothing', walkinCloseDeadline({
  startsAt: start, timeZone: TZ, limitMinutes: null, atClosing: true, hoursByDow: mondayFull,
}) === null)
check('24h start day: max length still applies', same(
  walkinCloseDeadline({ startsAt: start, timeZone: TZ, limitMinutes: 120, atClosing: true, hoursByDow: mondayFull }),
  at('2030-01-07', '21:00')))

check('no hours rows -> 22:00 default', same(
  walkinCloseDeadline({ startsAt: start, timeZone: TZ, limitMinutes: null, atClosing: true, hoursByDow: new Map() }),
  at('2030-01-07', '22:00')))

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
