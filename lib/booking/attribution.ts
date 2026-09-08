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
 *
 * MUST stay exactly in sync with idx_bookings_open_table_session's WHERE
 * clause (migration 0071: `status in ('confirmed', 'checked_in')`) — that
 * partial unique index is the only thing guaranteeing getActiveBookingForResource's
 * table-session branch below ever has at most one row to find, which is why
 * it's allowed to .limit(1) with no ORDER BY. Add a status here without
 * widening the index too and that guarantee silently stops holding: more than
 * one "active" booking could exist per table, and .limit(1) would return an
 * arbitrary one instead of erroring. scripts/test-resource-attribution.ts
 * asserts the two stay identical.
 */
export const ACTIVE_BOOKING_STATUSES = ['confirmed', 'checked_in'] as const

/**
 * The booking currently occupying `resourceId`, if any. Two shapes of
 * "occupying", tried in order:
 *
 *   1. An active timed slot (`booking_slots.active = true`) whose range
 *      contains `now` — the gaming/studio/VR path, on a booking that's still
 *      confirmed or checked in.
 *   2. An M17 table session, which has no booking_slots row at all — it links
 *      the table directly via `bookings.resource_id` instead (see migration
 *      0071's header for why). Checked only when (1) finds nothing, so a
 *      timed-slot resource is untouched by this branch. `bookings.resource_id`
 *      is null for every non-table-session booking, so this never matches a
 *      gaming/studio/VR booking regardless of tenant industry — no explicit
 *      "is this a restaurant" check is needed. At most one session can be
 *      open per table (idx_bookings_open_table_session, 0071), so there's
 *      never a tie to break.
 *
 * Null when the resource is free (or whatever's there is
 * completed/cancelled/no_show), meaning an order against it stays standalone.
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
  if (slot) return slot.bookingId

  const [session] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        eq(bookings.resourceId, resourceId),
        inArray(bookings.status, ACTIVE_BOOKING_STATUSES),
      ),
    )
    .limit(1)
  return session?.id ?? null
}
