import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { paymentIntents } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/**
 * Deposit state for a set of bookings, for rendering the booking list.
 *
 * Reads only the non-secret columns: a status and a gateway order id. No
 * credential, no key id — the key id reaches the browser only as part of a
 * checkout session the user explicitly started.
 *
 * The tenant comes from the authenticated context, never from the client, and
 * `payment_intents_rw` scopes the read again in the database.
 */
export type DepositState = {
  /** 'pending' — an order is open and awaiting the AROS-50 webhook. */
  status: 'pending' | 'paid'
}

export async function listDepositStates(
  ctx: ActiveContext,
  bookingIds: string[],
): Promise<Record<string, DepositState>> {
  if (bookingIds.length === 0) return {}

  const rows = await withUser(ctx.user.id, (tx) =>
    tx
      .select({
        bookingId: paymentIntents.bookingId,
        status: paymentIntents.status,
      })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, ctx.tenant.id),
          inArray(paymentIntents.bookingId, bookingIds),
          eq(paymentIntents.purpose, 'booking_deposit'),
          sql`${paymentIntents.status} in ('pending','paid')`,
        ),
      ),
  )

  const byBooking: Record<string, DepositState> = {}
  for (const row of rows) {
    // bookingId is only null on an order_payment intent (migration 0058),
    // which the purpose='booking_deposit' filter above already excludes —
    // this is belt-and-braces so the TS type (widened by that same
    // migration) doesn't need an unsound assertion.
    if (!row.bookingId) continue
    // 'paid' wins over 'pending': a booking that has settled a deposit and then
    // had a second order opened should read as paid.
    if (row.status === 'paid' || !byBooking[row.bookingId]) {
      byBooking[row.bookingId] = { status: row.status as 'pending' | 'paid' }
    }
  }
  return byBooking
}
