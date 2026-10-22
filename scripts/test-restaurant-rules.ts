/**
 * Pure restaurant-report rules (M20 / AROS-179) — no database.
 *
 *   npx tsx scripts/test-restaurant-rules.ts
 */
import { DAYPARTS, daypartOf, daysInRange, round2, safeDiv, tipPercent, turnsPerTablePerDay } from '../lib/reports/restaurant-rules'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

// ── dayparts ────────────────────────────────────────────────────────────────
check('05:00 is breakfast, 10:59 still breakfast', daypartOf(5) === 'breakfast' && daypartOf(10) === 'breakfast')
check('11:00 flips to lunch', daypartOf(11) === 'lunch' && daypartOf(14) === 'lunch')
check('15:00 snacks, 18 snacks', daypartOf(15) === 'snacks' && daypartOf(18) === 'snacks')
check('19:00 dinner, 22 dinner', daypartOf(19) === 'dinner' && daypartOf(22) === 'dinner')
check('23:00 and midnight and 04:00 are late night (band wraps)', daypartOf(23) === 'late_night' && daypartOf(0) === 'late_night' && daypartOf(4) === 'late_night')
let covered = true
for (let h = 0; h < 24; h++) if (!DAYPARTS.some((d) => d.key === daypartOf(h))) covered = false
check('every hour belongs to exactly one daypart', covered)
const counts = new Map<string, number>()
for (let h = 0; h < 24; h++) counts.set(daypartOf(h), (counts.get(daypartOf(h)) ?? 0) + 1)
check('band sizes are 6/4/4/4/6 hours', [...counts.values()].sort().join() === [4, 4, 4, 6, 6].sort().join())
check('out-of-range hours are normalised', daypartOf(24) === 'late_night' && daypartOf(-1) === 'late_night')

// ── arithmetic ──────────────────────────────────────────────────────────────
check('safeDiv divides', safeDiv(10, 4) === 2.5)
check('safeDiv by zero is null, not Infinity/NaN', safeDiv(10, 0) === null && safeDiv(0, 0) === null)
check('safeDiv rejects a non-finite numerator', safeDiv(NaN, 3) === null)
check('round2 to paise', round2(12.3456) === 12.35)

check('days in a single-day range is 1', daysInRange('2026-09-15', '2026-09-15') === 1)
check('days in range is inclusive', daysInRange('2026-09-01', '2026-09-30') === 30)
check('days in range spans a month boundary', daysInRange('2026-09-28', '2026-10-02') === 5)

check('3 finished sessions, 3 tables, 1 day -> 1 turn per table', turnsPerTablePerDay(3, 3, 1) === 1)
check('12 sessions, 4 tables, 3 days -> 1 turn', turnsPerTablePerDay(12, 4, 3) === 1)
check('turns round to 2dp', turnsPerTablePerDay(10, 3, 1) === 3.33)
check('no tables -> null, not a divide by zero', turnsPerTablePerDay(5, 0, 1) === null)
check('zero sessions -> 0 turns on a real floor? null only when there is nothing to divide by', turnsPerTablePerDay(0, 3, 1) === 0)

check('tip percent', tipPercent(250, 3000) === 8.33)
check('tip percent with no sales is null', tipPercent(10, 0) === null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
