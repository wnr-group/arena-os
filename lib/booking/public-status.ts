import 'server-only'
import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { bookings, bookingSlots, customers } from '@/db/schema'
import { normalizePhone } from '@/lib/customers/phone'

export type PublicBookingSummary = {
  /** bookings.confirmation_token — the same unguessable id /b/[token] is keyed by. */
  bookingToken: string
  bookingNumber: string
  status: string
  createdAt: string
  /** De-duplicated resource names across this booking's slots, e.g. ["PS5 Station 2"]. */
  resourceNames: string[]
  /** Earliest slot start / latest slot end, or null for a booking with no slots left to read. */
  startsAt: string | null
  endsAt: string | null
}

/** How far back the "My Booking" phone lookup looks for device bookings.
 *  Deliberately wider than RECENT_LOOKUP_WINDOW_MS (lib/orders/public-status.ts) —
 *  a device booking is normally made days or weeks ahead of the visit, so a
 *  48h window would hide an upcoming booking made last week. Still bounded,
 *  for the same reason: this is an unauthenticated phone lookup (no OTP/
 *  accounts yet — M9), so the window also bounds what a stranger who knows
 *  someone's phone number could see. */
const RECENT_BOOKING_LOOKUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Recent device/resource bookings for a phone number — the booking half of
 * the "My Booking" hub (lib/actions/my-bookings.ts), sitting next to
 * getRecentPublicOrdersByPhone (lib/orders/public-status.ts) for the food
 * half. Same narrow-by-design trust model: only what's needed to recognise
 * and open a booking (number/status/date/resource), nothing financial, and
 * only from the last RECENT_BOOKING_LOOKUP_WINDOW_MS.
 */
export async function getRecentPublicBookingsByPhone(
  tenantId: string,
  rawPhone: string,
): Promise<PublicBookingSummary[]> {
  const phone = normalizePhone(rawPhone)
  if (!phone) return []

  return withPublicTenant(tenantId, async (tx) => {
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.phone, phone)))
      .limit(1)
    if (!customer) return []

    const since = new Date(Date.now() - RECENT_BOOKING_LOOKUP_WINDOW_MS)
    const bookingRows = await tx
      .select({
        id: bookings.id,
        bookingNumber: bookings.bookingNumber,
        confirmationToken: bookings.confirmationToken,
        status: bookings.status,
        createdAt: bookings.createdAt,
      })
      .from(bookings)
      .where(
        and(eq(bookings.tenantId, tenantId), eq(bookings.customerId, customer.id), gte(bookings.createdAt, since)),
      )
      .orderBy(desc(bookings.createdAt))
      .limit(5)
    if (bookingRows.length === 0) return []

    const slotRows = await tx
      .select({
        bookingId: bookingSlots.bookingId,
        resourceName: bookingSlots.resourceName,
        startsAt: bookingSlots.startsAt,
        endsAt: bookingSlots.endsAt,
      })
      .from(bookingSlots)
      .where(
        and(
          eq(bookingSlots.tenantId, tenantId),
          inArray(
            bookingSlots.bookingId,
            bookingRows.map((b) => b.id),
          ),
        ),
      )
      .orderBy(bookingSlots.startsAt)

    const slotsByBooking = new Map<string, { resourceName: string; startsAt: Date; endsAt: Date }[]>()
    for (const row of slotRows) {
      slotsByBooking.set(row.bookingId, [...(slotsByBooking.get(row.bookingId) ?? []), row])
    }

    return bookingRows.map((b) => {
      const slots = slotsByBooking.get(b.id) ?? []
      return {
        bookingToken: b.confirmationToken,
        bookingNumber: b.bookingNumber,
        status: b.status,
        createdAt: b.createdAt.toISOString(),
        resourceNames: [...new Set(slots.map((s) => s.resourceName))],
        startsAt: slots[0]?.startsAt.toISOString() ?? null,
        // The latest-ENDING slot, not the last-by-START-time one — slots is
        // ordered by startsAt, and with overlapping/out-of-order slots those
        // are not the same row (e.g. 10:00–12:00 then 11:00–11:30: the second
        // starts later but ends earlier).
        endsAt:
          slots.length > 0
            ? new Date(Math.max(...slots.map((s) => s.endsAt.getTime()))).toISOString()
            : null,
      }
    })
  })
}
