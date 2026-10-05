/**
 * M31 #2 — resolveCorrectedEnd: the "Fix end time" input's bare HH:mm becomes
 * the absolute instant correctWalkinEndTime receives. Pure (no DB).
 *
 *   npx tsx scripts/test-walkin-end-time-resolver.ts
 */
import { resolveCorrectedEnd } from '../lib/booking/walkin-end-time'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata' // UTC+5:30, no DST
// 2030-06-10 16:00 IST = 10:30 UTC
const start = '2030-06-10T10:30:00.000Z'

const same = resolveCorrectedEnd(start, '17:30', TZ)
check('a later time the same evening resolves to that day', same?.iso === '2030-06-10T12:00:00.000Z' && same.nextDay === false)

const earlier = resolveCorrectedEnd(start, '16:45', TZ)
check('an earlier-than-current but after-start time resolves to the same day', earlier?.iso === '2030-06-10T11:15:00.000Z' && earlier.nextDay === false)

const wrapped = resolveCorrectedEnd(start, '09:00', TZ)
check('a time-of-day before the start rolls to the NEXT day (server then judges the 24h bound)', wrapped?.iso === '2030-06-11T03:30:00.000Z' && wrapped.nextDay === true)

// Session started 23:30 IST (18:00 UTC) and crosses midnight
const lateStart = '2030-06-10T18:00:00.000Z'
const past = resolveCorrectedEnd(lateStart, '00:15', TZ)
check('a post-midnight time for a late-night session means the next calendar day', past?.iso === '2030-06-10T18:45:00.000Z' && past.nextDay === true)
const evening = resolveCorrectedEnd(lateStart, '23:45', TZ)
check('…while 23:45 stays on the starting evening', evening?.iso === '2030-06-10T18:15:00.000Z' && evening.nextDay === false)

check('a time equal to the start is not "after the start" — rolls forward', resolveCorrectedEnd(start, '16:00', TZ)?.nextDay === true)
check('an empty input resolves to nothing', resolveCorrectedEnd(start, '', TZ) === null)
check('a malformed time resolves to nothing', resolveCorrectedEnd(start, '25:99', TZ) === null && resolveCorrectedEnd(start, '5pm', TZ) === null)
check('a garbage start resolves to nothing', resolveCorrectedEnd('nope', '17:00', TZ) === null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
