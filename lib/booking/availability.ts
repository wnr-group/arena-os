import { zonedTimeToUtc } from './time'

export type Interval = { startsAt: Date; endsAt: Date }

export type DayHours = {
  openTime: string // 'HH:mm'
  closeTime: string // 'HH:mm'
  isClosed: boolean
}

export type AvailabilityOptions = {
  /** Length of the booking being placed, minutes. */
  durationMinutes: number
  /** Grid step for candidate start times, minutes (default 30). */
  slotMinutes?: number
  /** Required gap before/after existing bookings, minutes (default 0). */
  bufferMinutes?: number
  /** Don't offer start times before this instant (e.g. "now" for today). */
  notBefore?: Date
}

const MIN = 60_000

/** True if [aStart,aEnd) and [bStart,bEnd) overlap. */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd
}

/**
 * Does a booking of [start, start+duration) fit the working day and avoid every
 * existing (active) slot, honouring buffer? This is the app-side pre-check; the
 * database exclusion constraint is the ultimate guard against races.
 */
export function isRangeAvailable(
  start: Date,
  durationMinutes: number,
  dayOpen: Date,
  dayClose: Date,
  existing: Interval[],
  bufferMinutes = 0,
): boolean {
  const end = new Date(start.getTime() + durationMinutes * MIN)
  if (start < dayOpen || end > dayClose) return false
  const buf = bufferMinutes * MIN
  for (const s of existing) {
    if (overlaps(start, end, new Date(s.startsAt.getTime() - buf), new Date(s.endsAt.getTime() + buf))) {
      return false
    }
  }
  return true
}

/**
 * Candidate start times (as instants) at which a booking of `durationMinutes`
 * can be placed on a single resource for a given local date.
 */
export function availableStartTimes(
  dateStr: string,
  timeZone: string,
  hours: DayHours,
  existing: Interval[],
  opts: AvailabilityOptions,
): Date[] {
  if (hours.isClosed) return []

  const slotMinutes = opts.slotMinutes ?? 30
  const buffer = opts.bufferMinutes ?? 0
  const dayOpen = zonedTimeToUtc(dateStr, hours.openTime, timeZone)
  const dayClose = zonedTimeToUtc(dateStr, hours.closeTime, timeZone)

  const out: Date[] = []
  const step = slotMinutes * MIN
  for (let t = dayOpen.getTime(); t + opts.durationMinutes * MIN <= dayClose.getTime(); t += step) {
    const start = new Date(t)
    if (opts.notBefore && start < opts.notBefore) continue
    if (isRangeAvailable(start, opts.durationMinutes, dayOpen, dayClose, existing, buffer)) {
      out.push(start)
    }
  }
  return out
}

/** Hours (decimal) between two instants — for pricing a slot. */
export function durationHours(startsAt: Date, endsAt: Date): number {
  return (endsAt.getTime() - startsAt.getTime()) / (60 * MIN)
}
