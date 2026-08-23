/**
 * The date range every report is filtered by (AROS-64).
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────
 * A range is two plain `YYYY-MM-DD` calendar dates, and BOTH ENDS ARE
 * INCLUSIVE: { start: '2026-08-01', end: '2026-08-01' } is one day — the whole
 * of the 1st — not an empty range. That matches how a human reads "1 Aug to
 * 1 Aug" on a filter form, and how the existing readers already behave
 * (lib/reports/employees.ts, lib/performance/data.ts, both documented as
 * "[from, to] inclusive").
 *
 * ── WHY PLAIN DATES, NOT Date OBJECTS ───────────────────────────────────────
 * A JS `Date` is an instant, so the moment one enters the picture the answer
 * depends on the machine's zone and "the 1st" can quietly become the 31st.
 * Calendar dates have no such failure mode: they compare and sort correctly as
 * strings, and they are exactly what `<input type="date">` and the aggregated
 * `day` column both speak. Consumers that must reach absolute time convert at
 * the last moment with the tenant's zone, via the existing helpers:
 *
 *     const startUtc = zonedTimeToUtc(range.start, '00:00', tz)          // ≥
 *     const endUtc   = zonedTimeToUtc(addDays(range.end, 1), '00:00', tz) // <
 *
 * i.e. a half-open [start, end) instant window, which is the ONLY off-by-one-
 * safe way to include the last day (an inclusive `<= 23:59:59` comparison
 * loses the final second). lib/reports/daily-revenue.ts needs none of this:
 * v_daily_revenue.day is already a calendar date in the branch's zone, so it
 * is compared date-to-date with no conversion at all.
 *
 * Nothing report-specific belongs in this file — it is pure date handling,
 * reusable by AROS-65/66/67 and by any future export.
 */

import { addDays, todayInZone } from '@/lib/booking/time'

/** A validated, inclusive `[start, end]` span of calendar days. */
export type DateRange = {
  /** `YYYY-MM-DD`, inclusive. */
  start: string
  /** `YYYY-MM-DD`, inclusive — the whole of this day counts. */
  end: string
}

/** A range the caller supplied but that cannot be honoured. */
export class DateRangeError extends Error {}

/** The most days a single report may span. A year of daily rows is already a
 *  big CSV; anything beyond it is a report that should be aggregated coarser. */
export const MAX_RANGE_DAYS = 366

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Is this a real calendar date in `YYYY-MM-DD` form?
 *
 * The regex alone is not enough: '2026-02-30' and '2026-13-01' match it and
 * are not days. Round-tripping through Date.UTC catches those — the components
 * only survive intact if the date genuinely exists.
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * Validate a caller-supplied range, or throw.
 *
 * For server actions and any path where a bad range is a bug or an abuse
 * attempt worth surfacing. Pages reading `?from=&to=` off a URL want
 * resolveDateRange() below instead, which falls back rather than throwing.
 */
export function parseDateRange(
  input: { start?: unknown; end?: unknown },
  options: { maxDays?: number } = {},
): DateRange {
  const { start, end } = input
  if (!isCalendarDate(start)) throw new DateRangeError('Enter a valid start date (YYYY-MM-DD).')
  if (!isCalendarDate(end)) throw new DateRangeError('Enter a valid end date (YYYY-MM-DD).')
  // String comparison is date comparison for this format — it is zero-padded
  // and big-endian, so it sorts chronologically.
  if (start > end) throw new DateRangeError('The start date must not be after the end date.')

  const maxDays = options.maxDays ?? MAX_RANGE_DAYS
  const days = daysInRange({ start, end })
  if (days > maxDays) {
    throw new DateRangeError(`That range covers ${days} days; the maximum is ${maxDays}.`)
  }

  return { start, end }
}

/**
 * Best-effort range from untrusted input (a query string), never throwing.
 *
 * This is the behaviour the report pages already hand-roll — default to the
 * last N days ending today in the tenant's zone, ignore anything unparseable,
 * and clamp a reversed range instead of erroring at a manager who dragged the
 * dates the wrong way round. Centralised here so every report agrees, and so
 * "today" is always the TENANT's today rather than the server's.
 */
export function resolveDateRange(
  input: { start?: unknown; end?: unknown },
  options: { timeZone: string; defaultDays?: number; maxDays?: number; now?: Date },
): DateRange {
  const { timeZone, defaultDays = 30, now } = options
  const maxDays = options.maxDays ?? MAX_RANGE_DAYS

  const today = todayInZone(timeZone, now ?? new Date())
  const end = isCalendarDate(input.end) ? input.end : today
  // defaultDays counts the end day itself, so 30 days back from today is
  // today − 29: a "last 30 days" report shows 30 rows, not 31.
  const fallbackStart = addDays(end, -(defaultDays - 1))
  let start = isCalendarDate(input.start) ? input.start : fallbackStart

  // Reversed → collapse to a single day rather than refuse.
  if (start > end) start = end
  // Too wide → keep the end (the recent side is what a manager is looking at)
  // and pull the start forward.
  if (daysInRange({ start, end }) > maxDays) start = addDays(end, -(maxDays - 1))

  return { start, end }
}

/** Days covered, counting BOTH ends: start === end is 1. */
export function daysInRange(range: DateRange): number {
  const ms = Date.UTC(...ymd(range.end)) - Date.UTC(...ymd(range.start))
  return Math.round(ms / 86_400_000) + 1
}

/**
 * Every calendar day in the range, ascending — for reports that must show a
 * zero row for a day nothing happened (the aggregate simply has no row for it).
 */
export function eachDay(range: DateRange): string[] {
  const days: string[] = []
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) days.push(d)
  return days
}

/** The last `days` calendar days ending today in `timeZone`, inclusive. */
export function lastNDays(days: number, timeZone: string, now: Date = new Date()): DateRange {
  const end = todayInZone(timeZone, now)
  return { start: addDays(end, -(days - 1)), end }
}

function ymd(dateStr: string): [number, number, number] {
  const [y, m, d] = dateStr.split('-').map(Number)
  return [y, m - 1, d]
}
