/**
 * M37 #3 — storefront date picker: static-markup render checks + the pure
 * clamp, no database and no browser.
 *
 *   - a 7-day window renders the original chip strip (7 pressed-state buttons,
 *     the same grid classes), with none of the long-picker controls
 *   - 30 / 90 / 180-day windows render the scrollable strip: one button per
 *     bookable day, month headings, a "Jump to" control and a Calendar trigger;
 *     the last bookable date is a real, enabled button; nothing past it exists
 *   - closed weekdays are disabled and struck through in the long picker only
 *   - the picker itself never fetches (availability stays one call per
 *     selection, owned by the page)
 *   - clampDateToWindow: in-window kept; beyond → last bookable; past / junk →
 *     today
 *
 * M37 #4 (staff wizard) shares the same component: the "staff" variant keeps the
 * wizard's denser chip strip, the long picker is identical, the duplicated
 * DATE_WINDOW_DAYS constant is gone, and the wizard's windows come from the
 * server.
 *
 * Keyboard behaviour and 360px layout need a real browser and are not covered here.
 *
 *   npx tsx scripts/test-storefront-date-picker.tsx
 */
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { DatePicker } from '../components/ui/DatePicker'
import { CHIP_STRIP_MAX_DAYS, clampDateToWindow, dateOptions, lastBookableDate } from '../lib/booking/horizon'
import { addDays } from '../lib/booking/time'
import { advanceWindowLabel } from '../lib/booking/settings'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, got?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  (got: ${String(got).slice(0, 300)})`}`)
  if (c) pass++
  else fail++
}
const count = (html: string, needle: string | RegExp) =>
  typeof needle === 'string' ? html.split(needle).length - 1 : (html.match(needle) ?? []).length

const TODAY = '2045-04-20' // a Thursday
const render = (n: number, closed: number[] = [], value = TODAY) =>
  renderToStaticMarkup(<DatePicker dates={dateOptions(TODAY, n)} value={value} onChange={() => {}} closedWeekdays={closed} />)

// ── 7 days: unchanged ─────────────────────────────────────────────────────────
console.log('\n── 7-day venue ──')
{
  const h = render(7)
  check('renders the chip grid (grid-cols-7)', h.includes('grid grid-cols-7 gap-2'), h)
  check('7 date buttons', count(h, '<button') === 7)
  check('exactly one is pressed (the selected date)', count(h, 'aria-pressed="true"') === 1)
  check('shows weekday, day and month on each chip', h.includes('>Thu<') && h.includes('>20<') && h.includes('>Apr<'))
  check('no long-picker controls', !h.includes('Jump to') && !h.includes('Calendar'))
  check('closed weekdays are NOT struck out in the chip strip (same as before)', !render(7, [0, 1, 2, 3, 4, 5, 6]).includes('line-through'))
  check(`${CHIP_STRIP_MAX_DAYS} days still uses the chip strip`, !render(CHIP_STRIP_MAX_DAYS).includes('Jump to'))
}

// ── long windows ─────────────────────────────────────────────────────────────
for (const n of [30, 90, 180]) {
  console.log(`\n── ${n}-day venue ──`)
  const h = render(n)
  const dates = dateOptions(TODAY, n)
  const last = lastBookableDate(TODAY, n)
  check(`one button per bookable day (${n}) plus the Calendar trigger`, count(h, /data-date="/g) === n && count(h, '<button') === n + 1, count(h, '<button'))
  check('the first date is today and is pressed', h.includes(`data-date="${TODAY}" aria-pressed="true"`) || /data-date="2045-04-20"[^>]*aria-pressed="true"/.test(h))
  check(`the last bookable date (${last}) is an enabled button`, new RegExp(`data-date="${last}"(?![^>]*disabled)`).test(h))
  check('nothing beyond the last bookable date is rendered', !h.includes(`data-date="${addDays(last, 1)}"`))
  check('month headings are real headings', count(h, '<h3') === new Set(dates.map((d) => d.slice(0, 7))).size)
  check('has a Jump-to control with a month option per heading', h.includes('Jump to') && count(h, '<option') === new Set(dates.map((d) => d.slice(0, 7))).size)
  check('has a calendar trigger wired as a dialog opener', h.includes('aria-haspopup="dialog"') && h.includes('aria-expanded="false"') && h.includes('Calendar'))
  check('the popover is not rendered until opened (no 90-day prefetch of anything)', !h.includes('role="dialog"'))
  check('every date button is a real <button type="button"> with aria-pressed', count(h, /<button type="button" data-date="/g) === n && count(h, /data-date="[^"]*" aria-pressed="(true|false)"/g) === n)
  check('the strip is a labelled group', h.includes('role="group"') && h.includes('aria-label="Pick a date"'))
}

// ── closed days ──────────────────────────────────────────────────────────────
console.log('\n── closed days (30-day venue, Sundays closed) ──')
{
  const h = render(30, [0])
  const sundays = dateOptions(TODAY, 30).filter((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 0)
  check(`${sundays.length} Sundays are disabled and struck through`, count(h, /disabled=""[^>]*title="Closed"|title="Closed"[^>]*disabled=""/g) >= sundays.length || count(h, 'line-through') >= sundays.length, count(h, 'line-through'))
  check('every Sunday button is disabled', sundays.every((d) => new RegExp(`data-date="${d}"[^>]*disabled`).test(h)))
  check('a weekday is not disabled', !new RegExp(`data-date="2045-04-24"[^>]*disabled`).test(h))
  const sel = render(30, [4], TODAY) // today (Thursday) closed but selected
  check('a closed day that is currently selected stays selectable (the page explains it)', !new RegExp(`data-date="${TODAY}"[^>]*disabled`).test(sel))
}

// ── the picker never fetches ─────────────────────────────────────────────────
console.log('\n── no per-day availability fetch ──')
{
  const src = readFileSync('components/ui/DatePicker.tsx', 'utf8')
  check('DatePicker imports no server action and calls no fetch', !/lib\/actions|fetch\(|getPublic/.test(src))
}

// ── clamp ────────────────────────────────────────────────────────────────────
console.log('\n── clampDateToWindow ──')
{
  const c = (d: string | undefined, n = 30) => clampDateToWindow(d, TODAY, n)
  const last30 = lastBookableDate(TODAY, 30)
  check('no date → today, not clamped', c(undefined).date === TODAY && !c(undefined).clamped)
  check('in-window date is kept', c('2045-05-01').date === '2045-05-01' && !c('2045-05-01').clamped)
  check('the last bookable date is kept', c(last30).date === last30 && !c(last30).clamped)
  check('the day after clamps to the last bookable date', c(addDays(last30, 1)).date === last30 && c(addDays(last30, 1)).clamped)
  check('a date a year out clamps to the last bookable date', c('2046-04-20').date === last30 && c('2046-04-20').clamped)
  check('a past date clamps to today', c('2045-04-01').date === TODAY && c('2045-04-01').clamped)
  check('reason: past → "past", not "beyond"', c('2045-04-01').reason === 'past')
  check('reason: beyond the window → "beyond"', c(addDays(last30, 1)).reason === 'beyond' && c('2046-04-20').reason === 'beyond')
  check('reason: junk / impossible → "invalid"', c('nope').reason === 'invalid' && c('2045-02-30').reason === 'invalid')
  check('reason: in-window / absent → null', c('2045-05-01').reason === null && c(undefined).reason === null)
  check('junk / impossible dates clamp to today', c('nope').date === TODAY && c('2045-02-30').date === TODAY && c('2045-02-30').clamped)
  check('with a 7-day window the same date clamps tighter', c('2045-05-01', 7).date === '2045-04-26')
}

// ── staff wizard (M37 #4): same component, staff styling ─────────────────────
console.log('\n── staff variant ──')
{
  const staff = (n: number, closed: number[] = []) =>
    renderToStaticMarkup(
      <DatePicker variant="staff" dates={dateOptions(TODAY, n)} value={TODAY} onChange={() => {}} closedWeekdays={closed} />,
    )
  const h7 = staff(7)
  check('7-day staff strip keeps the wizard styling (gap-1.5, rounded-xl chips)', h7.includes('grid grid-cols-7 gap-1.5 sm:gap-2') && h7.includes('rounded-xl') && h7.includes('text-base'), h7)
  check('7-day staff strip has 7 pressed-state buttons and no long-picker controls', count(h7, '<button') === 7 && !h7.includes('Jump to'))
  check('public variant is unchanged by the staff variant (still rounded-2xl)', render(7).includes('rounded-2xl') && !render(7).includes('rounded-xl border'))
  for (const n of [30, 90, 180]) {
    const h = staff(n, [0])
    const last = lastBookableDate(TODAY, n)
    check(`staff ${n}-day: strip + calendar, last bookable date enabled, nothing beyond`,
      h.includes('Jump to') && h.includes('Calendar') && count(h, /data-date="/g) === n &&
        new RegExp(`data-date="${last}"(?![^>]*disabled)`).test(h) && !h.includes(`data-date="${addDays(last, 1)}"`))
  }
  check('long staff picker markup is identical to the public one', staff(30, [0]) === render(30, [0]))
}

console.log('\n── one shared component, no duplicate constants ──')
{
  const wizard = readFileSync('components/bookings/new/FutureWizard.tsx', 'utf8')
  const pub1 = readFileSync('components/public-booking/ResourceBookingPage.tsx', 'utf8')
  const pub2 = readFileSync('components/public-booking/ResourceTypeBookingPage.tsx', 'utf8')
  check('FutureWizard no longer defines DATE_WINDOW_DAYS', !wizard.includes('DATE_WINDOW_DAYS'))
  check('no storefront page defines or uses DATE_WINDOW_DAYS', !pub1.includes('DATE_WINDOW_DAYS') && !pub2.includes('DATE_WINDOW_DAYS'))
  check('all three import the one DatePicker from components/ui', [wizard, pub1, pub2].every((f) => f.includes("from '@/components/ui/DatePicker'")))
  check('the wizard takes its window from the server (maxAdvanceDays prop)', wizard.includes('maxAdvanceDays') && wizard.includes('windowDates(today, maxAdvanceDays)'))
  const page = readFileSync('app/(app)/bookings/new/page.tsx', 'utf8')
  check('the page reads the setting via the staff context and fails closed', page.includes('maxAdvanceDaysOrDefault(ctx)'))
  const walkin = readFileSync('components/bookings/new/WalkinWizard.tsx', 'utf8')
  check('the walk-in wizard gains no horizon', !/maxAdvanceDays|horizon|DatePicker/.test(walkin))
  check('the hint reads "up to <label> ahead" and links managers to Settings -> Hours',
    wizard.includes('advanceWindowLabel(maxAdvanceDays)') && wizard.includes('href="/settings/hours"') && wizard.includes('canChangeSettings'))
  check('advanceWindowLabel: presets and unlisted values', advanceWindowLabel(90) === '3 months' && advanceWindowLabel(7) === '7 days' && advanceWindowLabel(45) === '45 days')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
