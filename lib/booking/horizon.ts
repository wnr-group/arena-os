/**
 * The advance-booking horizon (M37 #2) — pure date math, no DB.
 *
 * The venue chooses `maxAdvanceDays` (booking_settings, M37 #1). "N days" keeps
 * today's meaning: bookable dates are today … today + N − 1 in the TENANT's
 * timezone, so N = 7 is exactly the 7 date chips the UI always had.
 *
 * Built only on time.ts (todayInZone / zonedTimeToUtc / addDays), so it never
 * depends on the server's own zone.
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 * - A booking is in-horizon when its START date (tenant-local) is ≤ the last
 *   bookable date. A slot that starts on the last day and runs past midnight
 *   into the next is judged by its start, so it is allowed.
 * - A per-day (date-range) booking is judged by BOTH ends: its end date must
 *   also be ≤ the last bookable date. Callers pass `endsAt` for those only.
 * - Only the upper bound lives here. The past is a separate rule (backdated
 *   entry, M28; walk-in late checkout, M32) and is never judged by this file.
 */
import { addDays, todayInZone, zonedTimeToUtc } from './time'

/** The longest per-day (date-range) booking, in calendar days. */
export const MAX_DAY_RANGE_DAYS = 31

/** Last bookable calendar date: today + (N − 1). */
export function lastBookableDate(todayStr: string, maxAdvanceDays: number): string {
  return addDays(todayStr, maxAdvanceDays - 1)
}

/** Every bookable date, ascending — replaces the old fixed 7-date strips. */
export function dateOptions(todayStr: string, maxAdvanceDays: number): string[] {
  return Array.from({ length: maxAdvanceDays }, (_, i) => addDays(todayStr, i))
}

/** Is a plain tenant-local date inside the window? (Past dates are not this rule's concern.) */
export function isDateWithinHorizon(dateStr: string, todayStr: string, maxAdvanceDays: number): boolean {
  return dateStr <= lastBookableDate(todayStr, maxAdvanceDays)
}

/**
 * Is this booking inside the window?
 *
 * `endsAtUtcOrNull` is supplied ONLY for per-day (date-range) bookings, whose
 * end date must also be in range. For an ordinary slot pass null: it is judged
 * by its start alone, however late it runs. A day-range slot's end instant is
 * exclusive-ish ("Dn close"), so its date is taken 1ms before the instant, the
 * same convention the day-rate window uses.
 */
export function isWithinHorizon(
  startsAtUtc: Date,
  endsAtUtcOrNull: Date | null,
  todayStr: string,
  tz: string,
  maxAdvanceDays: number,
): boolean {
  const last = lastBookableDate(todayStr, maxAdvanceDays)
  if (todayInZone(tz, startsAtUtc) > last) return false
  if (endsAtUtcOrNull) {
    const endDate = todayInZone(tz, new Date(endsAtUtcOrNull.getTime() - 1))
    if (endDate > last) return false
  }
  return true
}

/** The first instant that is NOT bookable: 00:00 local on the day after the last bookable date. */
export function horizonEndsAt(todayStr: string, tz: string, maxAdvanceDays: number): Date {
  return zonedTimeToUtc(addDays(lastBookableDate(todayStr, maxAdvanceDays), 1), '00:00', tz)
}

/** User-facing refusal text. Same words on the storefront and in the admin wizard. */
export function horizonMessage(todayStr: string, maxAdvanceDays: number): string {
  return `Bookings can only be made up to ${lastBookableDate(todayStr, maxAdvanceDays)} (${maxAdvanceDays} day${maxAdvanceDays === 1 ? '' : 's'} ahead). Please pick an earlier date.`
}

/** Calendar days covered by a date range, both ends inclusive (start === end is 1). */
export function calendarDaysInRange(startDate: string, endDate: string): number {
  const [y1, m1, d1] = startDate.split('-').map(Number)
  const [y2, m2, d2] = endDate.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1
}

/**
 * Validate a per-day range picked as two plain dates: ordered, ≤ 31 days, and
 * ending inside the horizon. Returns the error text, or null if fine.
 */
export function dayRangeError(
  startDate: string,
  endDate: string,
  todayStr: string,
  maxAdvanceDays: number,
): string | null {
  if (endDate < startDate) return 'End date must be on or after the start date.'
  const days = calendarDaysInRange(startDate, endDate)
  if (days > MAX_DAY_RANGE_DAYS) {
    return `A day-rate booking can span at most ${MAX_DAY_RANGE_DAYS} days (you picked ${days}).`
  }
  if (!isDateWithinHorizon(endDate, todayStr, maxAdvanceDays)) return horizonMessage(todayStr, maxAdvanceDays)
  return null
}

/**
 * "Now" for the horizon check. Production always uses the real clock. Outside
 * production a script may pin it with ARENA_TEST_NOW (an ISO instant) so
 * fixtures that deliberately book on fixed far-future calendar dates — chosen
 * for their weekday and collision-free — stay valid without every one of them
 * being rewritten around today's date. Honoured ONLY when NODE_ENV is not
 * 'production', and it moves nothing but this check.
 */
export function horizonNow(): Date {
  const pinned = process.env.NODE_ENV !== 'production' ? process.env.ARENA_TEST_NOW : undefined
  if (pinned) {
    const d = new Date(pinned)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}

/**
 * Pull a requested date (e.g. a prefilled or rebook link) into the bookable
 * window instead of erroring: past or malformed → today, beyond → the last
 * bookable date. `clamped` says whether it had to move, so the UI can explain.
 */
export function clampDateToWindow(
  requested: string | undefined | null,
  todayStr: string,
  maxAdvanceDays: number,
): { date: string; clamped: boolean } {
  if (!requested) return { date: todayStr, clamped: false }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return { date: todayStr, clamped: true }
  const [y, m, d] = requested.split('-').map(Number)
  const real = new Date(Date.UTC(y, m - 1, d))
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) {
    return { date: todayStr, clamped: true }
  }
  if (requested < todayStr) return { date: todayStr, clamped: true }
  const last = lastBookableDate(todayStr, maxAdvanceDays)
  if (requested > last) return { date: last, clamped: true }
  return { date: requested, clamped: false }
}

/** A window this short keeps the original chip strip on the storefront, so 7-day venues look exactly as before. */
export const CHIP_STRIP_MAX_DAYS = 14
