/**
 * The transactional half of the event lifecycle — the core behind the events
 * management screen's status buttons.
 *
 * Takes a `tx`, same pattern as lib/kots/service.ts and lib/orders/service.ts,
 * so a caller can compose a status change with other work in one transaction.
 *
 * The RULES themselves (the transition table, the field validation) live in
 * ./lifecycle, which imports nothing server-side — that is what lets the client
 * form and this module share one definition instead of keeping two in sync.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { eventRegistrations, events } from '@/db/schema'
import { EventError, canTransition } from './lifecycle'
import type { EventStatus } from './types'

type Db = NodePgDatabase<typeof schema>

// Re-exported so server callers can take the rules and the core from one place.
export { EventError, EVENT_TRANSITIONS, canTransition, isTerminal, validateEventFields } from './lifecycle'

/**
 * Move one event to `newStatus`, rejecting illegal transitions.
 *
 * Scoped by tenant_id as well as id: RLS already confines the connection to the
 * caller's tenants, and this makes the intent explicit at the query level the
 * same way updateKotStatusCore does. `for update` holds the row so two managers
 * clicking at once cannot both read `registration_open` and both advance it.
 */
export async function updateEventStatusCore(
  tx: Db,
  ctx: { tenantId: string },
  eventId: string,
  newStatus: EventStatus,
): Promise<{ from: EventStatus; to: EventStatus }> {
  const [row] = await tx
    .select({ status: events.status })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenantId)))
    .for('update')
    .limit(1)

  if (!row) throw new EventError('Event not found.')

  if (row.status === newStatus) {
    throw new EventError(`This event is already ${newStatus.replace(/_/g, ' ')}.`)
  }
  if (!canTransition(row.status, newStatus)) {
    throw new EventError(
      `Cannot move a ${row.status.replace(/_/g, ' ')} event to ${newStatus.replace(/_/g, ' ')}.`,
    )
  }

  await tx
    .update(events)
    .set({ status: newStatus })
    .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenantId)))

  return { from: row.status, to: newStatus }
}

/**
 * Refuse an edit to the fee or capacity that registrations in flight would
 * make unfair or unsafe. Call it inside the same transaction, after the event
 * row is locked, so no registration can be claimed or paid between this read
 * and the write (claim and the payment webhook both take the same event lock).
 *
 *  - Fee: a customer with a live hold has been shown the old price and may
 *    already have an open Razorpay order for it. If the fee moves, their
 *    payment lands at the "wrong" price and confirm_event_registration_payment
 *    cancels them and flags a refund, so they lose the seat despite paying
 *    what they were shown. Refused while any live hold exists — including a
 *    change to 0 — rather than silently breaking those payments.
 *  - Capacity: refused below current occupancy, counted exactly as the
 *    database counts it (registered / checked-in, plus live holds).
 */
export async function assertEventEditAllowed(
  tx: Db,
  ctx: { tenantId: string },
  eventId: string,
  current: { entryFee: string; capacity: number | null },
  next: { entryFee: string; capacity: number | null },
): Promise<void> {
  const feeChanged = Number(current.entryFee) !== Number(next.entryFee)
  const capacityLowered =
    next.capacity !== null && (current.capacity === null || next.capacity < current.capacity)
  if (!feeChanged && !capacityLowered) return

  const [{ holds, occupied }] = await tx
    .select({
      holds: sql<number>`count(*) filter (where ${eventRegistrations.status} = 'pending_payment' and ${eventRegistrations.paymentHoldExpiresAt} > now())`.mapWith(Number),
      occupied: sql<number>`count(*) filter (where ${eventRegistrations.status} in ('registered', 'checked_in') or (${eventRegistrations.status} = 'pending_payment' and ${eventRegistrations.paymentHoldExpiresAt} > now()))`.mapWith(Number),
    })
    .from(eventRegistrations)
    .where(
      and(eq(eventRegistrations.tenantId, ctx.tenantId), eq(eventRegistrations.eventId, eventId)),
    )

  if (feeChanged && holds > 0) {
    throw new EventError(
      `${holds} ${holds === 1 ? 'person is' : 'people are'} part-way through paying the current entry fee. ` +
        'Wait for those payments to finish or expire before changing the fee.',
    )
  }
  if (capacityLowered && next.capacity! < occupied) {
    throw new EventError(
      `${occupied} place${occupied === 1 ? ' is' : 's are'} already taken or held, so the capacity cannot be lowered below ${occupied}. ` +
        'Cancel some registrations first.',
    )
  }
}
