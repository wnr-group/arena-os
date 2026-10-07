/**
 * M33 — the pure add-on pricing rules (lib/booking/addon-pricing.ts):
 *   - hourly add-ons bill exact elapsed hours × rate × quantity
 *   - daily add-ons bill ceil(elapsed hours / 24) day-blocks, minimum 1 —
 *     an elapsed-time rule, NOT calendar-dates-touched: the same 5-hour
 *     booking costs the same whether or not it crosses midnight
 *   - exactly 24h is one block; 24h + 1 minute is two
 *   - flat rate only: nothing about weekends/holidays/happy hours can move it
 *
 * Pure logic, no database:
 *
 *   npx tsx scripts/test-resource-addons-pricing.ts
 */
import { addonBillableUnits } from '../lib/booking/addon-pricing'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const IST = (iso: string) => new Date(`${iso}+05:30`)

// ── hourly ──────────────────────────────────────────────────────────────────
check(
  'hour: 3h window = 3 units',
  addonBillableUnits('hour', IST('2026-08-11T10:00:00'), IST('2026-08-11T13:00:00')) === 3,
)
check(
  'hour: 90 minutes = 1.5 units (exact, like a reserved slot)',
  addonBillableUnits('hour', IST('2026-08-11T10:00:00'), IST('2026-08-11T11:30:00')) === 1.5,
)

// ── daily ───────────────────────────────────────────────────────────────────
check(
  'day: 1 minute still bills one day-block (min 1)',
  addonBillableUnits('day', IST('2026-08-11T10:00:00'), IST('2026-08-11T10:01:00')) === 1,
)
check(
  'day: exactly 24h = 1 block',
  addonBillableUnits('day', IST('2026-08-11T10:00:00'), IST('2026-08-12T10:00:00')) === 1,
)
check(
  'day: 24h + 1 minute = 2 blocks',
  addonBillableUnits('day', IST('2026-08-11T10:00:00'), IST('2026-08-12T10:01:00')) === 2,
)
check(
  'day: 48h = 2 blocks',
  addonBillableUnits('day', IST('2026-08-11T10:00:00'), IST('2026-08-13T10:00:00')) === 2,
)
check(
  'day: 49h = 3 blocks',
  addonBillableUnits('day', IST('2026-08-11T10:00:00'), IST('2026-08-13T11:00:00')) === 3,
)

// The midnight-crossing ambiguity the rule exists to remove: a 5-hour booking
// is ONE day-block whether it sits inside one date or straddles midnight.
const sameDate = addonBillableUnits('day', IST('2026-08-11T14:00:00'), IST('2026-08-11T19:00:00'))
const crossesMidnight = addonBillableUnits('day', IST('2026-08-11T22:00:00'), IST('2026-08-12T03:00:00'))
check('day: 5h inside one date = 1 block', sameDate === 1)
check('day: 5h crossing midnight = 1 block (NOT 2 calendar dates)', crossesMidnight === 1)
check('day: same elapsed time prices identically either way', sameDate === crossesMidnight)

// Floating-point guard: exactly N×24h must not tip into N+1 from rounding.
check(
  'day: 72h = 3 blocks exactly',
  addonBillableUnits('day', IST('2026-08-11T00:00:00'), IST('2026-08-14T00:00:00')) === 3,
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
