import 'server-only'
import { and, asc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { bookingSlots, bookings, resources } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { addDays, zonedTimeToUtc } from '@/lib/booking/time'
import { getReservationSettingsCore } from './settings'
import { lapseNoShowReservationsCore, freeTablesForWindow, type FreeTable } from './service'
import { reservationEnd, type ReservationSettings } from './rules'

export type ReservationRow = {
  bookingId: string
  bookingNumber: string
  status: string
  customerName: string | null
  customerPhone: string | null
  partySize: number | null
  reservedFor: Date
  reservedMinutes: number | null
  /** Reserved table while unseated, the occupied table once seated. */
  tableId: string | null
  tableName: string | null
  /** Set once the party was converted to a seated session. */
  seatedTableId: string | null
  source: string
  notes: string | null
}

/** [start, end) instants of a local calendar date in `timeZone`. */
export function dayBounds(dateStr: string, timeZone: string): { from: Date; to: Date } {
  return { from: zonedTimeToUtc(dateStr, '00:00', timeZone), to: zonedTimeToUtc(addDays(dateStr, 1), '00:00', timeZone) }
}

export function getReservationSettings(ctx: ActiveContext): Promise<ReservationSettings> {
  return withUser(ctx.user.id, (tx) => getReservationSettingsCore(tx, ctx.tenant.id))
}

/**
 * Reservations for a branch whose reserved time falls in [from, to), earliest
 * first. Lapses overdue no-shows first, so a list never shows a "confirmed"
 * reservation that the grace window has already forfeited. Cancelled ones are
 * included (the page filters) so a day's history stays readable.
 */
export function listReservations(
  ctx: ActiveContext,
  branchId: string,
  range: { from: Date; to: Date },
): Promise<ReservationRow[]> {
  return withUser(ctx.user.id, async (tx) => {
    await lapseNoShowReservationsCore(tx, ctx.tenant.id)
    return tx
      .select({
        bookingId: bookings.id,
        bookingNumber: bookings.bookingNumber,
        status: bookings.status,
        customerName: bookings.customerName,
        customerPhone: bookings.customerPhone,
        partySize: bookings.coverCount,
        reservedFor: sql<Date>`${bookings.reservedFor}`,
        reservedMinutes: bookings.reservedMinutes,
        tableId: sql<string | null>`coalesce(${bookings.resourceId}, ${bookingSlots.resourceId})`,
        tableName: resources.name,
        seatedTableId: bookings.resourceId,
        source: bookings.source,
        notes: bookings.notes,
      })
      .from(bookings)
      .leftJoin(bookingSlots, eq(bookingSlots.bookingId, bookings.id))
      .leftJoin(resources, sql`${resources.id} = coalesce(${bookings.resourceId}, ${bookingSlots.resourceId})`)
      .where(
        and(
          eq(bookings.tenantId, ctx.tenant.id),
          eq(bookings.branchId, branchId),
          isNotNull(bookings.reservedFor),
          gte(bookings.reservedFor, range.from),
          lt(bookings.reservedFor, range.to),
        ),
      )
      .orderBy(asc(bookings.reservedFor), asc(bookings.bookingNumber))
      .then((rows) => rows.map((r) => ({ ...r, reservedFor: new Date(r.reservedFor as unknown as string) })))
  })
}

/** Tables free for the venue's reservation length starting at `startsAt` (staff form). */
export function listFreeTables(ctx: ActiveContext, branchId: string, startsAt: Date, minutes: number): Promise<FreeTable[]> {
  return withUser(ctx.user.id, (tx) =>
    freeTablesForWindow(tx, ctx.tenant.id, branchId, startsAt, reservationEnd(startsAt, minutes)),
  )
}
