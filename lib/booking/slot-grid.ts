import { and, eq } from 'drizzle-orm'
import type { DB } from '@/db'
import { workingHours } from '@/db/schema'
import { dayWindow, type DayHours } from './availability'
import { BookingError } from './booking-error'
import { getBookingSettingsCore } from './settings'
import { todayInZone, weekdayInZone } from './time'

const MIN = 60_000
const DEFAULT_HOURS: DayHours = { openTime: '10:00', closeTime: '22:00', isClosed: false, open24h: false }

/**
 * Pure check that one slot sits on the venue's booking grid: it starts a whole
 * number of steps after the day's opening, lasts a whole number of steps, and
 * fits inside that day's working hours. This is the same grid
 * availableStartTimes() offers, so a slot the UI listed always passes and a
 * hand-built request (10:07 → 10:43) is refused. Returns a message or null.
 */
export function slotGridError(
  slot: { startsAt: Date; endsAt: Date },
  timeZone: string,
  hours: DayHours,
  stepMinutes: number,
  /** The start is already fixed (a checked-in booking being lengthened or
   *  shortened): it may pre-date a step change, so only the END must sit on the grid. */
  opts: { endOnly?: boolean } = {},
): string | null {
  const dateStr = todayInZone(timeZone, slot.startsAt)
  if (hours.isClosed) return 'The venue is closed on that day.'
  const { open, close } = dayWindow(dateStr, timeZone, hours)
  if (slot.startsAt < open || slot.endsAt > close) return 'That time is outside working hours.'
  const step = stepMinutes * MIN
  if (opts.endOnly) {
    return (slot.endsAt.getTime() - open.getTime()) % step === 0
      ? null
      : `End times are in ${stepMinutes}-minute steps from opening time.`
  }
  if ((slot.startsAt.getTime() - open.getTime()) % step !== 0) {
    return `Start times are in ${stepMinutes}-minute steps from opening time.`
  }
  if ((slot.endsAt.getTime() - slot.startsAt.getTime()) % step !== 0) {
    return `Booking length must be a multiple of ${stepMinutes} minutes.`
  }
  return null
}

/**
 * Enforce the grid for reserved (future) bookings made through the staff wizard
 * and the public storefront. Reads the venue step and the branch's working hours
 * through `tx`, so it serves withUser and withPublicTenant alike. A slot booked
 * at a named setup is skipped: day-rate setups run open → close of whole days
 * (priceBookingSlots validates those against dayWindow itself).
 *
 * Not called for backdated entry, walk-ins or table reservations, which have
 * their own time rules.
 */
export async function assertSlotsOnGrid(
  tx: DB,
  ctx: { tenantId: string; timezone: string },
  branchId: string,
  slots: { startsAt: string; endsAt: string; setupId?: string }[],
  opts: { endOnly?: boolean } = {},
): Promise<void> {
  const { slotStepMinutes } = await getBookingSettingsCore(tx, ctx.tenantId)
  for (const s of slots) {
    if (s.setupId) continue
    const startsAt = new Date(s.startsAt)
    const endsAt = new Date(s.endsAt)
    const dow = weekdayInZone(todayInZone(ctx.timezone, startsAt), ctx.timezone)
    const [row] = await tx
      .select({
        openTime: workingHours.openTime,
        closeTime: workingHours.closeTime,
        isClosed: workingHours.isClosed,
        open24h: workingHours.open24h,
      })
      .from(workingHours)
      .where(and(eq(workingHours.branchId, branchId), eq(workingHours.dayOfWeek, dow)))
    const err = slotGridError({ startsAt, endsAt }, ctx.timezone, row ?? DEFAULT_HOURS, slotStepMinutes, opts)
    if (err) throw new BookingError(err)
  }
}
