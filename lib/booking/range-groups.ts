/**
 * Day grouping for the multi-day bookings list (M34 #4). Pure, no DB.
 *
 * A booking is listed ONCE, under the first local day it touches inside the
 * range. `listRangeBookings` already collapses slots to one row per booking and
 * hands back `firstStartsAt` (earliest overlapping slot start), so a booking
 * that spans midnight is never duplicated; one carried in from before the range
 * is clamped onto the range's first day.
 */
import { todayInZone } from './time'

/** Local `YYYY-MM-DD` of `iso` in `tz`, never earlier than the range's first day. */
export function rangeDayKey(iso: string, fromDate: string, tz: string): string {
  const local = todayInZone(tz, new Date(iso))
  return local < fromDate ? fromDate : local
}

/**
 * Groups rows (already newest-first by `firstStartsAt`) into consecutive day
 * buckets, keeping the incoming order. Newest day first.
 */
export function groupByDay<T extends { firstStartsAt: string }>(
  rows: T[],
  fromDate: string,
  tz: string,
): { date: string; rows: T[] }[] {
  const groups: { date: string; rows: T[] }[] = []
  for (const row of rows) {
    const date = rangeDayKey(row.firstStartsAt, fromDate, tz)
    const last = groups[groups.length - 1]
    if (last && last.date === date) last.rows.push(row)
    else groups.push({ date, rows: [row] })
  }
  return groups
}
