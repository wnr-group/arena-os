/**
 * Payroll report month presets (M34 #8) — pure logic, no database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-payroll-presets.ts
 */
import { PAYROLL_PRESETS, matchingPayrollPresets, resolvePayrollPreset } from '../lib/reports/period-presets'
import { shiftPayrollPeriod } from '../lib/format'
import { todayInZone } from '../lib/booking/time'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
type P = (typeof PAYROLL_PRESETS)[number]
const eq = (p: P, cur: string, from: string, to: string) =>
  JSON.stringify(resolvePayrollPreset(p, cur)) === JSON.stringify({ from, to })

check('This month = current..current', eq('month', '2045-04', '2045-04', '2045-04'))
check('Last 3 months = 3 periods incl. current', eq('last3m', '2045-04', '2045-02', '2045-04'))
check('Last 6 months = default (current-5..current)', eq('last6m', '2045-04', '2044-11', '2045-04'))
check('Last year = Jan..Dec previous year', eq('lastyear', '2045-04', '2044-01', '2044-12'))

// Year boundaries
check('January: last 3 months spans previous Nov–Jan', eq('last3m', '2045-01', '2044-11', '2045-01'))
check('January: last 6 months spans into previous year', eq('last6m', '2045-01', '2044-08', '2045-01'))
check('January: last year is the previous calendar year', eq('lastyear', '2045-01', '2044-01', '2044-12'))
check('December: last year is still the previous year', eq('lastyear', '2045-12', '2044-01', '2044-12'))

let sizes = true
for (const cur of ['2044-01', '2044-02', '2044-12', '2045-01', '2045-06']) {
  const y = resolvePayrollPreset('lastyear', cur)
  if (y.from !== `${y.to.slice(0, 4)}-01` || shiftPayrollPeriod(y.from, 11) !== y.to) sizes = false
  const t = resolvePayrollPreset('last3m', cur)
  if (shiftPayrollPeriod(t.from, 2) !== t.to) sizes = false
}
check('last year spans 12 periods, last 3 months spans 3', sizes)

// Current period comes from the tenant's local today, not server time.
const now = new Date('2045-03-31T20:00:00Z') // 01:30 Apr 1 in IST, still Mar 31 in NY
const istCur = todayInZone('Asia/Kolkata', now).slice(0, 7)
const nyCur = todayInZone('America/New_York', now).slice(0, 7)
check('current period follows the tenant zone', istCur === '2045-04' && nyCur === '2045-03')
check('presets follow it', eq('month', istCur, '2045-04', '2045-04') && eq('month', nyCur, '2045-03', '2045-03'))

// Active chip derivation
const act = (f: string, t: string) => matchingPayrollPresets(f, t, '2045-04').join(',')
check('preset URL highlights its chip', act('2045-02', '2045-04') === 'last3m')
check('default (no params) load highlights Last 6 months', act('2044-11', '2045-04') === 'last6m')
check('custom range highlights none', act('2045-01', '2045-03') === '')
check(
  'each preset highlights exactly one chip',
  PAYROLL_PRESETS.every((p) => {
    const x = resolvePayrollPreset(p, '2045-04')
    return matchingPayrollPresets(x.from, x.to, '2045-04').length === 1
  }),
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
