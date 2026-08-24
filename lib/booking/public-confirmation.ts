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
