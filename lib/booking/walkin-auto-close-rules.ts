import { addDays, todayInZone, weekdayInZone, zonedTimeToUtc } from './time'

/** One weekday's opening hours, as stored in working_hours. */
export type DayHours = { openTime: string; closeTime: string; isClosed: boolean; open24h: boolean }

/** What a branch with no working_hours row for a weekday is treated as (same as availability). */
export const DEFAULT_DAY_HOURS: DayHours = { openTime: '10:00', closeTime: '22:00', isClosed: false, open24h: false }

/**
 * The first closing time strictly after `start`, scanning up to a week of days.
 *
 * A day the venue is closed is skipped (a walk-in started then runs to the next
 * closing). A walk-in that starts on a 24-hour day has no closing time to stop
 * at, so this returns null for it and only the max-length rule can close it.
 * close_time is always after open_time (no overnight hours), so a closing time
 * is a wall-clock time on the same calendar day.
 */
export function nextClosingAfter(start: Date, timeZone: string, hoursByDow: Map<number, DayHours>): Date | null {
  const startDate = todayInZone(timeZone, start)
  for (let i = 0; i < 8; i++) {
    const date = addDays(startDate, i)
    const hours = hoursByDow.get(weekdayInZone(date, timeZone)) ?? DEFAULT_DAY_HOURS
    if (hours.open24h) {
      if (i === 0) return null
      continue
    }
    if (hours.isClosed) continue
    const close = zonedTimeToUtc(date, hours.closeTime, timeZone)
    if (close.getTime() > start.getTime()) return close
  }
  return null
}

/**
 * When an open-tab walk-in must be auto-closed: the EARLIER of start + the
 * max-length limit (if set) and the next closing time (if that option is on).
 * Null when neither rule gives a time.
 */
export function walkinCloseDeadline(input: {
  startsAt: Date
  timeZone: string
  limitMinutes: number | null
  atClosing: boolean
  hoursByDow: Map<number, DayHours>
}): Date | null {
  const times: number[] = []
  if (input.limitMinutes !== null) times.push(input.startsAt.getTime() + input.limitMinutes * 60_000)
  if (input.atClosing) {
    const closing = nextClosingAfter(input.startsAt, input.timeZone, input.hoursByDow)
    if (closing) times.push(closing.getTime())
  }
  return times.length > 0 ? new Date(Math.min(...times)) : null
}
