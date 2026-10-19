/**
 * Payroll report quick-range chips (M34 #8) — the wiring, not the date maths
 * (scripts/test-payroll-presets.ts covers that). Static-markup render, no
 * database and no browser:
 *
 *   - the payroll page renders <PeriodRangeFilter> and hands it the tenant's
 *     current period as maxPeriod (what the chips resolve against)
 *   - PeriodRangeFilter renders one chip per PAYROLL_PRESETS entry, linking to
 *     the preset's resolved ?from=&to=
 *   - the chip matching the current range is aria-current; a custom range
 *     highlights none
 *
 *   npx tsx scripts/test-payroll-chips-render.tsx
 */
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { PeriodRangeFilter } from '../components/reports/PeriodRangeFilter'
import { PAYROLL_PRESETS, PAYROLL_PRESET_LABELS, resolvePayrollPreset } from '../lib/reports/period-presets'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, got?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  (got: ${String(got).slice(0, 300)})`}`)
  if (c) pass++
  else fail++
}
const count = (html: string, needle: string) => html.split(needle).length - 1

const CUR = '2045-04'
// useRouter() needs a mounted app router; the filter never navigates in a static render.
const router = {} as AppRouterInstance
const render = (from: string, to: string) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PeriodRangeFilter basePath="/reports/payroll" from={from} to={to} maxPeriod={CUR} />
    </AppRouterContext.Provider>,
  )

// The page itself: it must render the filter and feed it the current period.
const page = readFileSync('app/(app)/reports/payroll/page.tsx', 'utf8')
check('payroll page imports PeriodRangeFilter', /import \{ PeriodRangeFilter \} from '@\/components\/reports\/PeriodRangeFilter'/.test(page))
check(
  'payroll page renders <PeriodRangeFilter … maxPeriod={currentPeriod} />',
  /<PeriodRangeFilter[^>]*maxPeriod=\{currentPeriod\}/.test(page),
)
check('page derives currentPeriod from the tenant timezone', /currentPeriod = todayInZone\(ctx\.tenant\.timezone\)/.test(page))

// The filter: one chip per preset, correct label and link.
const html = render('2044-11', CUR)
check('renders the quick-range nav', html.includes('aria-label="Quick date range"'))
check(`renders ${PAYROLL_PRESETS.length} chips`, count(html, '<li') === PAYROLL_PRESETS.length, count(html, '<li'))
for (const p of PAYROLL_PRESETS) {
  const r = resolvePayrollPreset(p, CUR)
  const href = `/reports/payroll?from=${r.from}&amp;to=${r.to}`
  check(`chip "${PAYROLL_PRESET_LABELS[p]}" links to ${r.from}..${r.to}`, html.includes(`href="${href}"`) && html.includes(`>${PAYROLL_PRESET_LABELS[p]}<`))
}

// Active state.
check('range = last 6 months → exactly that chip is active', count(html, 'aria-current="page"') === 1 && /aria-current="page"[^>]*>Last 6 months</.test(html))
check('custom range → no chip is active', count(render('2044-02', '2044-07'), 'aria-current') === 0)
check('range = this month → "This month" active', /aria-current="page"[^>]*>This month</.test(render(CUR, CUR)))

// Custom From/To still there.
check('custom From/To month inputs and Apply remain', count(html, 'type="month"') === 2 && html.includes('Apply'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
