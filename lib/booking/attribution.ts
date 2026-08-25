/**
 * Resolving which booking (if any) "owns" a resource right now — the
 * attribution rule an order uses to fold itself into that booking's bill
 * instead of settling standalone. Takes a `tx` rather than opening its own,
 * same convention as lib/orders/service.ts: it runs under whatever
 * transaction the caller already has (withUser for the staff POS, or
 * withPublicTenant for the public QR-at-station entry point), so it works
 * under either RLS scope without a fork.
 */
import { and, eq, gt, inArray, lte } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { bookingSlots, bookings } from '@/db/schema'

type Db = NodePgDatabase<typeof schema>

/**
 * The booking currently occupying `resourceId`, if any — an active slot
 * (`booking_slots.active = true`) whose time range contains `now`, on a
 * booking that's still confirmed or checked in. Null when the resource is
 * free (or a booking there is completed/cancelled/no_show), meaning an order
 * against it stays standalone.
 */
export async function getActiveBookingForResource(
  tx: Db,
  tenantId: string,
  resourceId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const [slot] = await tx
    .select({ bookingId: bookingSlots.bookingId })
    .from(bookingSlots)
    .innerJoin(bookings, eq(bookings.id, bookingSlots.bookingId))
    .where(
      and(
        eq(bookingSlots.tenantId, tenantId),
        eq(bookingSlots.resourceId, resourceId),
        eq(bookingSlots.active, true),
        lte(bookingSlots.startsAt, now),
        gt(bookingSlots.endsAt, now),
        inArray(bookings.status, ['confirmed', 'checked_in']),
      ),
    )
    .limit(1)
  return slot?.bookingId ?? null
}
