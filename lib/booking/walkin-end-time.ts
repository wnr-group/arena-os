/**
 * Turning the "Fix end time" input (a bare HH:mm in the branch's timezone) into
 * the absolute instant correctWalkinEndTime wants (M31 #2).
 *
 * A bare time of day is ambiguous across midnight, so it resolves to the
 * EARLIEST occurrence that is after the session started: a 23:30 session that
 * runs to 00:30 and is corrected to "00:15" means the next day's 00:15, while
 * "23:45" means the same evening. Whether the result is acceptable (in the
 * future, within 24h, …) is left entirely to the server — this only picks the
 * day.
 *
 * Pure and dependency-free (uses lib/booking/time's Intl helpers only), so the
 * client dialog and its test can both import it.
 */
import { addDays, todayInZone, zonedTimeToUtc } from './time'

export type ResolvedEnd = {
  /** ISO instant to send as `newEndAt`. */
  iso: string
  /** True when the resolved end falls on a later calendar day than the start. */
  nextDay: boolean
}

export function resolveCorrectedEnd(startsAtIso: string, timeStr: string, timeZone: string): ResolvedEnd | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeStr)) return null
  const startsAt = new Date(startsAtIso)
  if (Number.isNaN(startsAt.getTime())) return null

  const startDate = todayInZone(timeZone, startsAt)
  for (let offset = 0; offset <= 2; offset++) {
    const candidate = zonedTimeToUtc(addDays(startDate, offset), timeStr, timeZone)
    if (candidate.getTime() > startsAt.getTime()) return { iso: candidate.toISOString(), nextDay: offset > 0 }
  }
  return null
}

/**
 * M32 #2 — the checkout dialog's "This was a while ago" date+time picker.
 *
 * `<input type="datetime-local">` yields a wall-clock string with no zone
 * ("2026-10-02T14:30"). It is read as the BRANCH's wall time (the same zone the
 * rest of the dialog renders in), never the browser's, so a device in another
 * zone can't shift the bill.
 *
 * Client-side validation is a convenience only — checkoutWalkinCore re-checks
 * every bound and is the actual guard. LATE_CHECKOUT_MAX_DAYS mirrors the
 * server's WALKIN_LATE_CHECKOUT_MAX_DAYS (a test pins them equal); it is
 * repeated here because lib/booking/walkin.ts is server-only.
 */
export const LATE_CHECKOUT_MAX_DAYS = 7

/** An instant as a datetime-local value ('YYYY-MM-DDTHH:mm') in `timeZone`. */
export function toDatetimeLocal(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date)
  const hh = (parts.find((p) => p.type === 'hour')?.value ?? '00').replace(/^24$/, '00')
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00'
  return `${todayInZone(timeZone, date)}T${hh}:${mm}`
}

export type LateEndResult = { iso: string } | { error: string }

export function resolveLateCheckoutEnd(
  value: string,
  timeZone: string,
  now: Date,
  startsAtIso: string,
): LateEndResult {
  const m = /^(\d{4}-\d{2}-\d{2})T(([01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  if (!m) return { error: 'Enter a valid date and time.' }
  const end = zonedTimeToUtc(m[1], m[2], timeZone)
  // Date.UTC silently rolls an impossible date (2030-02-30) over to the next
  // month, so round-trip the instant and reject anything that doesn't read
  // back as exactly what was typed.
  if (Number.isNaN(end.getTime()) || toDatetimeLocal(end, timeZone) !== value) {
    return { error: 'Enter a valid date and time.' }
  }
  if (end.getTime() > now.getTime()) return { error: 'The end time can’t be in the future.' }
  if (now.getTime() - end.getTime() > LATE_CHECKOUT_MAX_DAYS * 24 * 60 * 60_000) {
    return { error: `Pick a time within the last ${LATE_CHECKOUT_MAX_DAYS} days.` }
  }
  if (end.getTime() <= new Date(startsAtIso).getTime()) return { error: 'The end time must be after the session started.' }
  return { iso: end.toISOString() }
}
