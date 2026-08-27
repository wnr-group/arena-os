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
 * Booking lifecycle states where the booking is still "happening" — the only
 * ones an order may ever attach to. Once a booking is completed, cancelled or
 * a no-show, it's over: food must land as a standalone order instead, never
 * folded into a bill that's already closed out (or never opened). Shared by
 * every attribution path (createOrderCore's direct-bookingId check below,
 * getActiveBookingForResource, and the public "add food to your visit" nudge
 * in lib/booking/public-confirmation.ts) so the rule can't drift between them.
 */
export const ACTIVE_BOOKING_STATUSES = ['confirmed', 'checked_in'] as const

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
        inArray(bookings.status, ACTIVE_BOOKING_STATUSES),
      ),
    )
    .limit(1)
  return slot?.bookingId ?? null
}
