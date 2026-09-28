import { zonedTimeToUtc, todayInZone } from './time'

export type Interval = { startsAt: Date; endsAt: Date }

export type DayHours = {
  openTime: string // 'HH:mm'
  closeTime: string // 'HH:mm'
  isClosed: boolean
  /** Open a full 24 hours (00:00 → next midnight); open/close are ignored when
   *  set (migration 0098). Optional so existing callers/DEFAULT_HOURS that
   *  predate it read as false. */
  open24h?: boolean
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
 * A local date's open/close instants for a given DayHours (M24 #4: pulled out
 * of availableStartTimes so getDayRangeWindow — which needs D1's open and a
 * DIFFERENT day Dn's close, not one day's own pair — can share the exact same
 * open24h handling instead of re-deriving it).
 *
 * "Open 24 hours" (migration 0098): the day runs 00:00 → the NEXT midnight,
 * so the final 11:30 PM–12:00 AM slot fits (a same-day close time can never
 * reach midnight). open/close are ignored for such a day.
 */
export function dayWindow(dateStr: string, timeZone: string, hours: DayHours): { open: Date; close: Date } {
  const open = zonedTimeToUtc(dateStr, hours.open24h ? '00:00' : hours.openTime, timeZone)
  let close: Date
  if (hours.open24h) {
    close = zonedTimeToUtc(dateStr, '00:00', timeZone)
    close.setUTCDate(close.getUTCDate() + 1)
  } else {
    close = zonedTimeToUtc(dateStr, hours.closeTime, timeZone)
  }
  return { open, close }
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
  const { open: dayOpen, close: dayClose } = dayWindow(dateStr, timeZone, hours)

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

/**
 * Whole calendar days a per-day setup's window spans, in `timeZone` (M24 #2)
 * — for a slot booked "D1 open -> Dn close", this is (Dn - D1) + 1, i.e. the
 * inclusive day count a day-rate setup prices against
 * (lib/booking/service.ts:priceBookingSlots). Computed off each instant's OWN
 * calendar date (todayInZone), not a raw ms/86400000 division, so it can't be
 * thrown off by a DST shift or by the two instants sitting at different
 * times of day (open vs. close).
 */
export function daysInRange(startsAt: Date, endsAt: Date, timeZone: string): number {
  const [sy, sm, sd] = todayInZone(timeZone, startsAt).split('-').map(Number)
  const [ey, em, ed] = todayInZone(timeZone, endsAt).split('-').map(Number)
  const days = Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / (24 * 60 * MIN)) + 1
  return Math.max(1, days)
}
