'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withCustomer } from '@/db'
import { getCurrentCustomer } from '@/lib/auth/customer-session'
import { cancelOwnBooking } from '@/lib/portal/cancel'

/**
 * Customer-initiated booking actions (AROS-90).
 *
 * The first write the portal has ever exposed. Its whole security posture is
 * that the customer identity is taken from the SESSION and from nowhere else:
 *
 *   getCurrentCustomer()          ← httpOnly cookie, validated against
 *                                    customer_sessions and this subdomain
 *        ↓
 *   withCustomer(customer.id)     ← RLS narrows every table to that customer
 *        ↓
 *   cancelOwnBooking(tx, …)       ← re-checks ownership, state and cutoff
 *        ↓
 *   bookings_customer_cancel      ← the database permits exactly one transition
 *
 * The action's ONLY input is a booking id, which is a lookup key and never an
 * authorisation. No tenant id and no customer id crosses the wire; a caller who
 * submits somebody else's booking id gets the same "could not be found" answer
 * as one who submits a UUID that does not exist.
 */

const cancelInput = z.object({
  bookingId: z.string().uuid(),
})

export type CancelBookingResult = {
  ok?: true
  error?: string
  /**
   * True when the venue is holding a deposit against the cancelled booking, so
   * the UI can say it is going to staff rather than back to the card. Nothing
   * is refunded automatically — see lib/portal/cancel.ts.
   */
  depositReviewRequired?: boolean
}

export async function cancelMyBooking(
  raw: z.input<typeof cancelInput>,
): Promise<CancelBookingResult> {
  const customer = await getCurrentCustomer()
  if (!customer) {
    // The layout guard normally redirects long before this, but an action is
    // its own entry point and has to refuse on its own account — a POST does
    // not have to come from a page we rendered.
    return { error: 'Please sign in again to manage your bookings.' }
  }

  const parsed = cancelInput.safeParse(raw)
  if (!parsed.success) {
    return { error: 'That booking could not be found.' }
  }

  const outcome = await withCustomer(customer.id, (tx) =>
    cancelOwnBooking(tx, {
      bookingId: parsed.data.bookingId,
      // Both taken from the validated session, never from the caller.
      tenantId: customer.tenantId,
      customerId: customer.id,
    }),
  )

  if (!outcome.ok) return { error: outcome.message }

  // The booking moves from Upcoming to Past, and the overview's counts change.
  revalidatePath('/account/bookings')
  revalidatePath(`/account/bookings/${parsed.data.bookingId}`)
  revalidatePath('/account')

  return { ok: true, depositReviewRequired: outcome.depositReviewRequired }
}
