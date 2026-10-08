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
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { events } from '@/db/schema'
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
