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
 * Keyboard behaviour and 360px layout need a real browser and are not covered here.
 *
 *   npx tsx scripts/test-storefront-date-picker.tsx
 */
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { DatePicker } from '../components/public-booking/DatePicker'
import { CHIP_STRIP_MAX_DAYS, clampDateToWindow, dateOptions, lastBookableDate } from '../lib/booking/horizon'
import { addDays } from '../lib/booking/time'

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
  const src = readFileSync('components/public-booking/DatePicker.tsx', 'utf8')
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
  check('junk / impossible dates clamp to today', c('nope').date === TODAY && c('2045-02-30').date === TODAY && c('2045-02-30').clamped)
  check('with a 7-day window the same date clamps tighter', c('2045-05-01', 7).date === '2045-04-26')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
