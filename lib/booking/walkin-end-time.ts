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
