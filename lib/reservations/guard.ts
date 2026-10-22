import 'server-only'
import { and, asc, eq, gt, isNotNull, isNull, lt } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { bookings, bookingSlots } from '@/db/schema'
import { BookingError } from '@/lib/booking/booking-error'
import { formatTimeInZone } from '@/lib/booking/time'
import { getReservationSettingsCore } from './settings'
import { reservationBlocksWalkin } from './rules'

type Db = NodePgDatabase<typeof schema>

/** A walk-in tried to take a table a reservation is about to need. The UI
 *  offers "seat anyway" for this one error, so it is its own class. */
export class ReservationConflictError extends BookingError {}

export type BlockingReservation = {
  bookingId: string
  customerName: string | null
  coverCount: number | null
  startsAt: Date
}

/**
 * The reservation (if any) that stops a walk-in being seated at `resourceId`
 * right now: confirmed, not yet seated, inside the walk-in buffer (or already
 * underway) and not yet lapsed past the no-show grace. Null when the venue has
 * not enabled reservations — the whole check is skipped, no other query runs.
 */
export async function findBlockingReservation(
  tx: Db,
  tenantId: string,
  resourceId: string,
  now: Date = new Date(),
): Promise<BlockingReservation | null> {
  const settings = await getReservationSettingsCore(tx, tenantId)
  if (!settings.enabled) return null

  const horizon = new Date(now.getTime() + settings.walkinBufferMinutes * 60_000)
  const candidates = await tx
    .select({
      bookingId: bookings.id,
      customerName: bookings.customerName,
      coverCount: bookings.coverCount,
      startsAt: bookingSlots.startsAt,
      endsAt: bookingSlots.endsAt,
    })
    .from(bookingSlots)
    .innerJoin(bookings, eq(bookings.id, bookingSlots.bookingId))
    .where(
      and(
        eq(bookingSlots.tenantId, tenantId),
        eq(bookingSlots.resourceId, resourceId),
        eq(bookingSlots.active, true),
        eq(bookings.status, 'confirmed'),
        isNotNull(bookings.reservedFor),
        isNull(bookings.resourceId),
        lt(bookingSlots.startsAt, horizon),
        gt(bookingSlots.endsAt, now),
      ),
    )
    .orderBy(asc(bookingSlots.startsAt))

  for (const c of candidates) {
    if (!c.endsAt) continue
    if (reservationBlocksWalkin({ startsAt: c.startsAt, endsAt: c.endsAt }, now, settings.walkinBufferMinutes, settings.noShowGraceMinutes)) {
      return { bookingId: c.bookingId, customerName: c.customerName, coverCount: c.coverCount, startsAt: c.startsAt }
    }
  }
  return null
}

/** Throws ReservationConflictError when a reservation blocks seating a walk-in. */
export async function assertNoUpcomingReservation(
  tx: Db,
  ctx: { tenantId: string; timezone: string },
  resourceId: string,
  now: Date = new Date(),
): Promise<void> {
  const blocking = await findBlockingReservation(tx, ctx.tenantId, resourceId, now)
  if (!blocking) return
  const who = blocking.customerName ? ` for ${blocking.customerName}` : ''
  const covers = blocking.coverCount ? ` (${blocking.coverCount} guests)` : ''
  throw new ReservationConflictError(
    `This table is reserved${who}${covers} at ${formatTimeInZone(blocking.startsAt, ctx.timezone)}. Seat them elsewhere, or seat anyway.`,
  )
}
