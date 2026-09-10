import 'server-only'
import { and, eq, isNotNull } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { bookings, bookingSlots, paymentIntents } from '@/db/schema'
import { ACTIVE_BOOKING_STATUSES } from '@/lib/booking/attribution'

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
  /**
   * The venue is still owed a deposit on this booking.
   *
   * A booking is `confirmed` from the instant it is created — payment is a
   * SEPARATE step, and every exit from the Razorpay flow (success, failure,
   * script error, and the customer simply closing the modal) lands on this
   * page. So `status` alone cannot answer "has this been paid for", and
   * anything that should not greet an unpaid customer with a celebration has
   * to consult this instead.
   *
   * Derived the same way lib/payments/deposit-settlement.ts derives it — a
   * `paid` intent carrying a gateway payment id — so there is one definition
   * of a settled deposit, not two. The frontend Razorpay callback is never
   * consulted: only the verified webhook writes that row.
   */
  awaitingPayment: boolean
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
        deposit: bookings.deposit,
      })
      .from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.confirmationToken, token)))
      .limit(1)
    if (!booking) return null

    // Only asked when a deposit was actually required, so a venue that takes no
    // deposits pays for no extra query. payment_intents_public_select scopes
    // this to the pinned tenant, the same policy the rest of this read relies on.
    const depositDue = Number(booking.deposit) > 0
    const paidDeposits = depositDue
      ? await tx
          .select({ id: paymentIntents.id })
          .from(paymentIntents)
          .where(
            and(
              eq(paymentIntents.tenantId, tenantId),
              eq(paymentIntents.bookingId, booking.id),
              eq(paymentIntents.status, 'paid'),
              isNotNull(paymentIntents.gatewayPaymentId),
            ),
          )
          .limit(1)
      : []

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
      awaitingPayment: depositDue && paidDeposits.length === 0,
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

/**
 * Resolve a booking's confirmation_token for the "Add food to your visit"
 * nudge (components/public-booking/BookingConfirmation.tsx) — same
 * unguessable-token trust model as getPublicBookingByToken above, but
 * returns the internal id/branchId placeOnlineOrder needs to attach the
 * order to this booking (see lib/actions/public-orders.ts), and returns null
 * for a cancelled/no-show/completed booking (ACTIVE_BOOKING_STATUSES) so a
 * stale link degrades to a plain standalone order instead of erroring. This
 * is only the early, out-of-transaction check for what the checkout page
 * OFFERS — createOrderCore re-checks the same statuses, inside the
 * transaction that actually creates the order, as the authoritative gate.
 */
export async function getPublicBookingForOrder(tenantId: string, token: string): Promise<PublicBookingForOrder | null> {
  return withPublicTenant(tenantId, async (tx) => {
    const [booking] = await tx
      .select({ id: bookings.id, branchId: bookings.branchId, bookingNumber: bookings.bookingNumber, status: bookings.status })
      .from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.confirmationToken, token)))
      .limit(1)
    if (!booking || !(ACTIVE_BOOKING_STATUSES as readonly string[]).includes(booking.status)) return null
    return { id: booking.id, branchId: booking.branchId, bookingNumber: booking.bookingNumber }
  })
}
