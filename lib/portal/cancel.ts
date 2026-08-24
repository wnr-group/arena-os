import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import type { DB } from '@/db'
import {
  auditLog,
  bookingCancellationSettings,
  bookings,
  bookingSlots,
} from '@/db/schema'

/**
 * Customer self-service cancellation (AROS-90) — the rules, in one place.
 *
 * Everything here runs inside a caller-supplied transaction that is ALREADY
 * customer-scoped (withCustomer). Like the readers in lib/portal/bookings.ts,
 * these take a transaction rather than a customer id: the tx IS the
 * authorisation, so there is no id parameter a route could smuggle a value
 * into.
 *
 * ── Where the state machine came from ───────────────────────────────────────
 *
 * There isn't an existing one to reuse. The staff path (setBookingStatus in
 * lib/actions/bookings.ts) writes whatever status it is handed with no
 * eligibility check at all — which is correct for staff, who are expected to
 * override, and completely wrong to expose to the public. So the rules below
 * are new, and they are deliberately STRICTER than the staff path rather than
 * different from it: every transition a customer can make is one staff could
 * already have made.
 *
 * What IS reused is the mechanism underneath. Setting status = 'cancelled'
 * fires trg_bookings_sync_slots (0003), the same trigger the staff path relies
 * on, which flips booking_slots.active to false in the same transaction and
 * releases the time for rebooking. No slot is touched by hand here, and no
 * second availability mechanism exists.
 */

/** Defaults for a tenant that has never opened the settings page. */
export const DEFAULT_CANCELLATION_SETTINGS = {
  customerCancellationEnabled: true,
  cutoffHours: 24,
} as const

export type CancellationPolicy = {
  enabled: boolean
  cutoffHours: number
}

export type CancelEligibility =
  | { ok: true; hasDeposit: boolean }
  | { ok: false; reason: CancelRefusal; message: string }

export type CancelRefusal =
  | 'not_found'
  | 'disabled'
  | 'wrong_status'
  | 'within_cutoff'
  | 'open_orders'

/**
 * The venue's rule, or the defaults. Readable by the customer on purpose — a
 * cancellation policy is posted terms, and the UI has to state it before
 * asking anyone to confirm.
 */
export async function getCancellationPolicy(tx: DB, tenantId: string): Promise<CancellationPolicy> {
  const [row] = await tx
    .select({
      enabled: bookingCancellationSettings.customerCancellationEnabled,
      cutoffHours: bookingCancellationSettings.cutoffHours,
    })
    .from(bookingCancellationSettings)
    .where(eq(bookingCancellationSettings.tenantId, tenantId))
    .limit(1)

  return {
    enabled: row?.enabled ?? DEFAULT_CANCELLATION_SETTINGS.customerCancellationEnabled,
    cutoffHours: row?.cutoffHours ?? DEFAULT_CANCELLATION_SETTINGS.cutoffHours,
  }
}

type BookingMeta = {
  hasOpenOrders: boolean
  hasDeposit: boolean
  rebookResourceTypeId: string | null
}

/**
 * The three facts about a booking that the portal needs but a customer must not
 * be able to read for themselves — see customer_booking_meta() in migration
 * 0047. Returns null when the booking is not this customer's.
 */
export async function getBookingMeta(tx: DB, bookingId: string): Promise<BookingMeta | null> {
  const { rows } = await tx.execute<{
    has_open_orders: boolean
    has_deposit: boolean
    rebook_resource_type_id: string | null
  }>(sql`select * from public.customer_booking_meta(${bookingId}::uuid)`)

  const row = rows[0]
  if (!row) return null
  return {
    hasOpenOrders: row.has_open_orders,
    hasDeposit: row.has_deposit,
    rebookResourceTypeId: row.rebook_resource_type_id,
  }
}

/**
 * Is this booking cancellable by its own customer, right now?
 *
 * ── The cutoff, and why no timezone appears in it ───────────────────────────
 *
 *   booking start − now ≥ cutoff_hours
 *
 * Both sides are absolute instants: booking_slots.starts_at is timestamptz and
 * `now()` is the database clock. Subtracting two instants gives a duration that
 * is the same number in every timezone, so the venue's zone is irrelevant to
 * the decision — it matters only when the times are DISPLAYED. That also makes
 * the rule immune to the overnight case that trips date-based arithmetic: a
 * booking running 22:00→02:00 is compared on its start instant, and no calendar
 * date is ever computed.
 *
 * min(starts_at) is the booking's start: a multi-slot booking becomes
 * uncancellable when its FIRST slot comes within the window, not its last.
 *
 * A booking with no slots at all has no start time; it falls back to being
 * treated as startable immediately, which means it is always inside the cutoff
 * and must go through staff. That is the safe direction for a row that should
 * not exist.
 */
export async function checkCancelEligibility(
  tx: DB,
  bookingId: string,
  tenantId: string,
): Promise<CancelEligibility> {
  const policy = await getCancellationPolicy(tx, tenantId)

  // RLS has already reduced `bookings` to this customer's rows, so a booking
  // that is not theirs simply is not here. Belt and braces: the customer_id
  // predicate is stated anyway, so this query is correct on its own terms.
  const [booking] = await tx
    .select({
      id: bookings.id,
      status: bookings.status,
      startsAt: sql<Date | null>`min(${bookingSlots.startsAt})`.mapWith(bookingSlots.startsAt),
      // Evaluated by Postgres against its own clock, not the Node process's.
      withinCutoff: sql<boolean>`coalesce(
        min(${bookingSlots.startsAt}) - now() < make_interval(hours => ${policy.cutoffHours}),
        true
      )`,
    })
    .from(bookings)
    .leftJoin(bookingSlots, eq(bookingSlots.bookingId, bookings.id))
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .groupBy(bookings.id)
    .limit(1)

  if (!booking) {
    // Also the "someone else's booking" answer. Identical on purpose: telling a
    // caller that a booking exists but is not theirs confirms its existence to
    // anyone walking UUIDs.
    return { ok: false, reason: 'not_found', message: 'That booking could not be found.' }
  }

  if (!policy.enabled) {
    return {
      ok: false,
      reason: 'disabled',
      message: 'This venue asks that cancellations be arranged with them directly.',
    }
  }

  // 'confirmed' only. Cancelled and completed are terminal; no_show is a record
  // of what happened; checked_in means the customer is already at the venue and
  // walking out is a conversation with the front desk. The database enforces
  // this same restriction independently (bookings_customer_cancel, 0047).
  if (booking.status !== 'confirmed') {
    return {
      ok: false,
      reason: 'wrong_status',
      message:
        booking.status === 'cancelled'
          ? 'This booking has already been cancelled.'
          : 'This booking can no longer be cancelled online. Please contact the venue.',
    }
  }

  if (booking.withinCutoff) {
    return {
      ok: false,
      reason: 'within_cutoff',
      message:
        policy.cutoffHours > 0
          ? `This booking can no longer be cancelled because it is within the cancellation period (${policy.cutoffHours} hours before the start time). Please contact the venue.`
          : 'This booking can no longer be cancelled because it has already started. Please contact the venue.',
    }
  }

  const meta = await getBookingMeta(tx, bookingId)
  if (!meta) {
    return { ok: false, reason: 'not_found', message: 'That booking could not be found.' }
  }

  // An open food order means the kitchen and the till are already involved.
  // Rather than reach into orders/kots from a customer context — which would
  // mean granting the portal write access to two more tables for a case that
  // barely occurs on a booking still a day away — this hands the whole thing to
  // staff, which is the same conservative direction the deposit rule takes.
  if (meta.hasOpenOrders) {
    return {
      ok: false,
      reason: 'open_orders',
      message:
        'This booking has an open order against it, so it needs to be cancelled by the venue. Please contact them.',
    }
  }

  return { ok: true, hasDeposit: meta.hasDeposit }
}

export type CancelOutcome =
  | { ok: true; depositReviewRequired: boolean }
  | { ok: false; reason: CancelRefusal | 'conflict'; message: string }

/**
 * Cancel the booking. Everything below happens in the caller's single
 * transaction, so the status change, the slot release (via the trigger) and the
 * audit entry either all commit or none of them do. There is no path that
 * leaves a cancelled booking holding an active slot, and none that frees a slot
 * without cancelling.
 */
export async function cancelOwnBooking(
  tx: DB,
  input: { bookingId: string; tenantId: string; customerId: string },
): Promise<CancelOutcome> {
  const eligibility = await checkCancelEligibility(tx, input.bookingId, input.tenantId)
  if (!eligibility.ok) return eligibility

  const now = new Date()

  // The status predicate is repeated here even though it was just checked.
  // Between the check and this write another request could have cancelled the
  // same booking; making the UPDATE itself conditional means the loser changes
  // nothing rather than double-cancelling or clobbering a staff decision.
  //
  // Exactly three columns are written. RLS cannot restrict an UPDATE to
  // specific columns (see the note on bookings_customer_cancel in 0047), so
  // this list is the thing that keeps a customer cancellation from touching
  // money, notes or times.
  const updated = await tx
    .update(bookings)
    .set({
      status: 'cancelled',
      cancelledAt: now,
      depositReviewRequired: eligibility.hasDeposit,
    })
    .where(
      and(
        eq(bookings.id, input.bookingId),
        eq(bookings.tenantId, input.tenantId),
        eq(bookings.status, 'confirmed'),
      ),
    )
    .returning({ id: bookings.id })

  if (updated.length === 0) {
    // Zero rows means either the race above, or RLS refusing the write. Both
    // are "this did not happen", and neither should look like success.
    return {
      ok: false,
      reason: 'conflict',
      message: 'This booking could not be cancelled. Please refresh and try again.',
    }
  }

  // Reuses audit_log (0018) rather than inventing a second trail. The actor is
  // a customer, not a membership, so actor_membership_id stays null and the
  // customer is identified inside the payload — the shape the customer INSERT
  // policy in 0047 pins exactly.
  await tx.insert(auditLog).values({
    tenantId: input.tenantId,
    actorMembershipId: null,
    action: 'booking.cancelled_by_customer',
    entityType: 'booking',
    entityId: input.bookingId,
    before: { status: 'confirmed' },
    after: {
      status: 'cancelled',
      cancelledAt: now.toISOString(),
      customerId: input.customerId,
      depositReviewRequired: eligibility.hasDeposit,
    },
  })

  return { ok: true, depositReviewRequired: eligibility.hasDeposit }
}
