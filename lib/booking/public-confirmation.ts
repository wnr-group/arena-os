import 'server-only'
import { and, eq } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { bookings, bookingSlots } from '@/db/schema'

export type PublicBookingSlot = {
  resourceName: string
  resourceTypeName: string
  startsAt: string
  endsAt: string
}

export type PublicBookingConfirmation = {
  bookingNumber: string
  status: string
  customerName: string | null
  total: string
  createdAt: string
  slots: PublicBookingSlot[]
}

/**
 * Look a booking up by its confirmation_token for the public confirmation
 * page (app/(public)/b/[token]) — never by bookingNumber, which is
 * sequential and guessable (see 0026_booking_confirmation_token.sql). RLS
 * (bookings_public_select, 0023) only scopes this to the pinned tenant; the
 * one-specific-token filter here is what actually stops enumeration, same
 * trust model as the customer-phone lookup in lib/customers/service.ts.
 */
export async function getPublicBookingByToken(
  tenantId: string,
  token: string,
): Promise<PublicBookingConfirmation | null> {
  return withPublicTenant(tenantId, async (tx) => {
    const [booking] = await tx
      .select({
        id: bookings.id,
        bookingNumber: bookings.bookingNumber,
        status: bookings.status,
        customerName: bookings.customerName,
        total: bookings.total,
        createdAt: bookings.createdAt,
      })
      .from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.confirmationToken, token)))
      .limit(1)
    if (!booking) return null

    const slots = await tx
      .select({
        resourceName: bookingSlots.resourceName,
        resourceTypeName: bookingSlots.resourceTypeName,
        startsAt: bookingSlots.startsAt,
        endsAt: bookingSlots.endsAt,
      })
      .from(bookingSlots)
      .where(and(eq(bookingSlots.tenantId, tenantId), eq(bookingSlots.bookingId, booking.id)))
      .orderBy(bookingSlots.startsAt)

    return {
      bookingNumber: booking.bookingNumber,
      status: booking.status,
      customerName: booking.customerName,
      total: booking.total,
      createdAt: booking.createdAt.toISOString(),
      slots: slots.map((s) => ({
        resourceName: s.resourceName,
        resourceTypeName: s.resourceTypeName,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
      })),
    }
  })
}

export type PublicBookingForOrder = { id: string; branchId: string; bookingNumber: string }

/** Bookings still open enough that food ordered against them should land on
 *  the same bill — mirrors BookingConfirmation's CAN_ADD_FOOD_STATUSES. */
const ORDERABLE_STATUSES = new Set(['confirmed', 'checked_in'])

/**
 * Resolve a booking's confirmation_token for the "Add food to your visit"
 * nudge (components/public-booking/BookingConfirmation.tsx) — same
 * unguessable-token trust model as getPublicBookingByToken above, but
 * returns the internal id/branchId placeOnlineOrder needs to attach the
 * order to this booking (see lib/actions/public-orders.ts), and returns null
 * for a cancelled/no-show/completed booking so a stale link degrades to a
 * plain standalone order instead of erroring.
 */
export async function getPublicBookingForOrder(tenantId: string, token: string): Promise<PublicBookingForOrder | null> {
  return withPublicTenant(tenantId, async (tx) => {
    const [booking] = await tx
      .select({ id: bookings.id, branchId: bookings.branchId, bookingNumber: bookings.bookingNumber, status: bookings.status })
      .from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.confirmationToken, token)))
      .limit(1)
    if (!booking || !ORDERABLE_STATUSES.has(booking.status)) return null
    return { id: booking.id, branchId: booking.branchId, bookingNumber: booking.bookingNumber }
  })
}
