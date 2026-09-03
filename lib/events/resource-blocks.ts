import 'server-only'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { DB } from '@/db'
import { bookingSlots, eventResources, events, resources, resourceTypes } from '@/db/schema'
import { EventError } from './lifecycle'
import type { EventStatus } from './types'

/**
 * EVENT RESOURCE BLOCKING — the transactional core (M15 #4).
 *
 * ══ AN EVENT BLOCK IS A booking_slots ROW ═══════════════════════════════════
 *
 * There is no second availability system here, and that is the entire design.
 * Migration 0084 lets `booking_slots` carry an `event_id` instead of a
 * `booking_id`, so the constraint 0003 already declared —
 *
 *     exclude using gist (resource_id with =, tstzrange(starts_at, ends_at) with &&)
 *     where (active)
 *
 * — becomes the mutual exclusion between events and bookings, enforced by
 * Postgres rather than by anything in this file remembering to check.
 *
 * What that buys, and what this module therefore does NOT contain:
 *
 *   * no availability query. lib/booking/public-availability.ts and
 *     lib/actions/availability.ts read `booking_slots` on `active` +
 *     `resource_id` and never join `bookings`, so an event row is already in
 *     their answers. Neither file changes.
 *   * no booking-creation check. createBookingCore() inserts its slots and lets
 *     the constraint reject overlap; an event block is just another row it can
 *     collide with. The public path and the staff walk-in path are both covered
 *     without a line changing, and both already translate 23P01 into their own
 *     "that time was just taken" message.
 *   * no boundary arithmetic. `tstzrange(a, b)` is `[a, b)`, so a booking that
 *     ends exactly when an event starts does not overlap it. The rule is
 *     inherited, not restated.
 *
 * ══ THE ORDER OF OPERATIONS, AND WHY IT IS THIS ONE ═════════════════════════
 *
 * Everything below runs inside ONE transaction supplied by the caller, and in
 * this order:
 *
 *   1. lock the event row (`for update`) — two managers editing at once
 *      serialise, exactly as updateEventStatusCore does;
 *   2. lock the BRANCH (advisory, transaction-scoped) — see the note on
 *      lockBranchResources below;
 *   3. release this event's existing blocks;
 *   4. re-materialise from the current selection.
 *
 * Release-then-reapply inside one transaction is what makes an edit atomic. The
 * released rows are invisible to everyone else until commit, so there is no
 * instant at which a station this event still owns looks bookable — and if step
 * 4 hits a conflict, the whole thing rolls back and the OLD blocks stand. An
 * event is therefore never partially blocked.
 *
 * ══ WHY A CONFLICT IS A REFUSAL, NEVER A DELETION ═══════════════════════════
 *
 * If a customer already holds a booking inside the window, the event is
 * refused. Nothing cancels, moves or edits that booking — the ticket is
 * explicit, and it is the right default besides: a business decides whether to
 * ring a customer and move them, and support can do it by hand. What this
 * module will not do is make that decision silently at 2am.
 */

/** Statuses whose events hold their resources. */
const BLOCKING_STATUSES: readonly EventStatus[] = [
  'published',
  'registration_open',
  'full',
  'in_progress',
]

/**
 * Does an event in this status reserve its resources?
 *
 * ── The lifecycle rule, stated once ─────────────────────────────────────────
 *
 *   draft              NO. A manager drafting next month's tournament must not
 *                      make ten stations unbookable today. The selection is
 *                      kept; nothing is reserved.
 *   published          YES. It has been announced; the stations are committed.
 *   registration_open  YES.
 *   full               YES — and this is the one worth saying out loud. `full`
 *                      means capacity is reached, NOT that the event stopped
 *                      needing its stations. Releasing here would hand the
 *                      room away from the very event that filled it.
 *   in_progress        YES. It is happening.
 *   completed          NO. It is over; the time is bookable again.
 *   cancelled          NO. Released.
 *
 * Exported so the UI can explain the state without restating the rule, and so
 * the test suite asserts the same predicate the writer uses.
 */
export function statusBlocks(status: EventStatus): boolean {
  return BLOCKING_STATUSES.includes(status)
}

/**
 * Serialise everything that touches one branch's resource blocks.
 *
 * The exclusion constraint alone already makes DOUBLE-BOOKING impossible — it
 * is a database constraint, and no interleaving defeats it. This lock exists
 * for the composite operations the constraint cannot see as a unit:
 *
 *   * a 'branch' event enumerates the branch's resources and then inserts a row
 *     per resource. A station created between the enumeration and the insert
 *     would be missed by this event. (Migration 0084's trigger closes the same
 *     hole from the other direction, for a resource created while a block is
 *     already committed; the lock closes the window where neither side can see
 *     the other yet.)
 *   * an edit releases and re-inserts. Two concurrent edits of two different
 *     events could each pass their own conflict pre-check against rows the
 *     other is about to write.
 *
 * `pg_advisory_xact_lock` on the branch id, the same idiom lib/platform/usage.ts
 * uses per tenant, released automatically at commit or rollback. Keyed on the
 * BRANCH rather than the tenant so two branches of one business do not queue
 * behind each other.
 */
async function lockBranchResources(tx: DB, branchId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${branchId}, 0))`)
}

type EventRow = {
  id: string
  tenantId: string
  branchId: string
  startsAt: Date
  endsAt: Date
  status: EventStatus
  resourceScope: 'none' | 'branch' | 'specific'
}

/** The event, locked, or a clear refusal. */
async function lockEvent(tx: DB, tenantId: string, eventId: string): Promise<EventRow> {
  const [row] = await tx
    .select({
      id: events.id,
      tenantId: events.tenantId,
      branchId: events.branchId,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      status: events.status,
      resourceScope: events.resourceScope,
    })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
    .for('update')
    .limit(1)

  if (!row) throw new EventError('Event not found.')
  return row as EventRow
}

/**
 * The resources this event should hold, resolved from its scope.
 *
 * Both branches read `resources` under the caller's own RLS-scoped
 * transaction, so a station belonging to another tenant cannot appear here even
 * if its id were supplied — and 0084's composite FK makes the cross-tenant
 * selection unrepresentable in the first place.
 *
 * Only `status = 'available'` stations are blocked. One in maintenance is
 * already unbookable by every availability reader, so reserving it would add a
 * row that changes nothing and would have to be reconciled later.
 */
async function resolveTargets(
  tx: DB,
  event: EventRow,
): Promise<{ id: string; name: string; typeName: string }[]> {
  if (event.resourceScope === 'none') return []

  const base = {
    id: resources.id,
    name: resources.name,
    typeName: sql<string>`coalesce(${resourceTypes.name}, 'Resource')`,
  }

  if (event.resourceScope === 'branch') {
    return tx
      .select(base)
      .from(resources)
      .leftJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
      .where(
        and(
          eq(resources.tenantId, event.tenantId),
          eq(resources.branchId, event.branchId),
          eq(resources.status, 'available'),
        ),
      )
  }

  // 'specific' — the manager's selection, joined to the live catalogue so a
  // station deleted or moved out of the branch since selection simply drops out
  // rather than producing a block against a row that no longer belongs here.
  return tx
    .select(base)
    .from(eventResources)
    .innerJoin(resources, eq(resources.id, eventResources.resourceId))
    .leftJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(
      and(
        eq(eventResources.eventId, event.id),
        eq(eventResources.tenantId, event.tenantId),
        eq(resources.tenantId, event.tenantId),
        eq(resources.branchId, event.branchId),
        eq(resources.status, 'available'),
      ),
    )
}

/** A resource that could not be reserved, and what is holding it. */
export type BlockConflict = {
  resourceId: string
  resourceName: string
  /** 'booking' — a customer holds it. 'event' — another event does. */
  heldBy: 'booking' | 'event'
  startsAt: Date
  endsAt: Date
}

/**
 * What would stop this event reserving `targets` over its window.
 *
 * Read inside the same transaction and after the same locks as the write, so
 * the answer cannot go stale between the check and the insert. It is NOT the
 * guarantee — the exclusion constraint is, and it would reject the insert even
 * if this returned nothing. This exists so a manager gets "Station 3 is booked
 * 18:00–19:00" instead of a constraint violation.
 *
 * `&&` on tstzrange is the same operator the constraint uses, so "overlap" here
 * means precisely what it means there — including the half-open boundary.
 */
export async function findBlockConflicts(
  tx: DB,
  event: { id: string; tenantId: string; startsAt: Date; endsAt: Date },
  targetIds: string[],
): Promise<BlockConflict[]> {
  if (targetIds.length === 0) return []

  const rows = await tx
    .select({
      resourceId: bookingSlots.resourceId,
      resourceName: bookingSlots.resourceName,
      eventId: bookingSlots.eventId,
      startsAt: bookingSlots.startsAt,
      endsAt: bookingSlots.endsAt,
    })
    .from(bookingSlots)
    .where(
      and(
        eq(bookingSlots.tenantId, event.tenantId),
        inArray(bookingSlots.resourceId, targetIds),
        eq(bookingSlots.active, true),
        // This event's own rows are not conflicts with itself. On the
        // release-then-reapply path they are already gone; this makes the
        // reader correct when called on its own, for the UI's conflict preview.
        sql`(${bookingSlots.eventId} is null or ${bookingSlots.eventId} <> ${event.id})`,
        sql`tstzrange(${bookingSlots.startsAt}, ${bookingSlots.endsAt}) && tstzrange(${event.startsAt}, ${event.endsAt})`,
      ),
    )
    .orderBy(bookingSlots.startsAt)

  return rows.map((r) => ({
    resourceId: r.resourceId,
    resourceName: r.resourceName,
    heldBy: r.eventId ? ('event' as const) : ('booking' as const),
    startsAt: r.startsAt,
    endsAt: r.endsAt,
  }))
}

/** Human sentence for a set of conflicts — the manager-facing refusal. */
function conflictMessage(conflicts: BlockConflict[]): string {
  const fmt = (d: Date) =>
    d.toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const first = conflicts[0]
  const held = first.heldBy === 'event' ? 'another event' : 'a booking'
  const more =
    conflicts.length > 1 ? ` (and ${conflicts.length - 1} more resource${conflicts.length > 2 ? 's' : ''})` : ''
  return (
    `${first.resourceName} is already held by ${held} from ${fmt(first.startsAt)} to ${fmt(first.endsAt)}${more}. ` +
    `Free it, pick different resources, or move the event.`
  )
}

/**
 * Drop this event's blocks.
 *
 * A DELETE rather than `active = false`. A booking keeps cancelled slots
 * because they are part of a customer's history and the portal renders them
 * (0046); an event block is bookkeeping with no such reader, and leaving
 * inactive rows behind would mean every reapply had to reason about which of
 * several dead generations to revive. Deleting makes reapply a clean insert and
 * makes "blocks for this event" mean exactly one thing.
 *
 * Idempotent: calling it on an event that holds nothing deletes nothing and
 * succeeds. That is what makes cancellation safe to retry.
 *
 * Scoped by tenant AND event id, so it can never touch another event's blocks
 * or any customer booking — a booking's rows have `event_id is null` and are
 * not matched by this predicate at all.
 */
export async function releaseEventBlocks(
  tx: DB,
  tenantId: string,
  eventId: string,
): Promise<number> {
  const deleted = await tx
    .delete(bookingSlots)
    .where(
      and(
        eq(bookingSlots.tenantId, tenantId),
        eq(bookingSlots.eventId, eventId),
      ),
    )
    .returning({ id: bookingSlots.id })
  return deleted.length
}

export type SyncResult = {
  scope: 'none' | 'branch' | 'specific'
  status: EventStatus
  /** How many resources the event now holds. 0 when its status does not block. */
  blocked: number
  released: number
}

/**
 * Bring one event's blocks into line with its current window, scope, selection
 * and status. THE single entry point — creation, edit, status change and
 * cancellation all call this and nothing else.
 *
 * Idempotent by construction: it computes the target set from the event's
 * current row and replaces whatever is there. Running it twice changes nothing
 * the second time, which is what makes it safe on a retried action and safe to
 * call from a status transition that may already have been applied.
 *
 * Throws EventError naming the conflict when the event cannot hold what it
 * claims. The caller's transaction then rolls back, so a failed edit leaves the
 * PREVIOUS blocks intact rather than a half-applied set.
 */
export async function syncEventBlocks(
  tx: DB,
  tenantId: string,
  eventId: string,
): Promise<SyncResult> {
  const event = await lockEvent(tx, tenantId, eventId)
  await lockBranchResources(tx, event.branchId)

  // Always release first — an event that has stopped blocking, changed window,
  // changed branch or dropped a resource must not keep a stale row, and the
  // old rows would otherwise collide with the new ones on reapply.
  const released = await releaseEventBlocks(tx, tenantId, eventId)

  if (!statusBlocks(event.status) || event.resourceScope === 'none') {
    return { scope: event.resourceScope, status: event.status, blocked: 0, released }
  }

  const targets = await resolveTargets(tx, event)
  if (targets.length === 0) {
    // A 'specific' event whose stations were all deleted, or a branch with no
    // bookable resources. Nothing to hold; not an error.
    return { scope: event.resourceScope, status: event.status, blocked: 0, released }
  }

  // Named conflicts, for the message. The constraint below is the guarantee.
  const conflicts = await findBlockConflicts(tx, event, targets.map((t) => t.id))
  if (conflicts.length > 0) throw new EventError(conflictMessage(conflicts))

  await tx.insert(bookingSlots).values(
    targets.map((t) => ({
      tenantId,
      bookingId: null,
      eventId,
      resourceId: t.id,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      // An event block is a reservation, not a sale. It never reaches an
      // invoice: lib/billing/invoice.ts loads slots by booking_id, and an event
      // row has none, so it cannot be billed to anyone.
      rateApplied: '0',
      slotTotal: '0',
      resourceName: t.name,
      resourceTypeName: t.typeName,
      active: true,
    })),
  )

  return {
    scope: event.resourceScope,
    status: event.status,
    blocked: targets.length,
    released,
  }
}

/**
 * Replace an event's resource SELECTION, then resync its blocks.
 *
 * The selection is validated against the live catalogue rather than trusted:
 * every id must be a resource of THIS tenant in THIS event's branch. A caller
 * passing another tenant's station id gets a refusal, and 0084's composite FK
 * would refuse it a second time at the database.
 */
export async function setEventResources(
  tx: DB,
  tenantId: string,
  eventId: string,
  resourceIds: string[],
): Promise<SyncResult> {
  const event = await lockEvent(tx, tenantId, eventId)

  const wanted = [...new Set(resourceIds)]
  if (event.resourceScope === 'specific' && wanted.length === 0) {
    throw new EventError('Choose at least one resource, or set the event to reserve nothing.')
  }

  if (wanted.length > 0) {
    const valid = await tx
      .select({ id: resources.id })
      .from(resources)
      .where(
        and(
          eq(resources.tenantId, tenantId),
          eq(resources.branchId, event.branchId),
          inArray(resources.id, wanted),
        ),
      )
    if (valid.length !== wanted.length) {
      // Deliberately does not say WHICH id failed, or whether it exists
      // elsewhere — that would confirm the existence of another tenant's row.
      throw new EventError('One or more selected resources do not belong to this event’s branch.')
    }
  }

  await tx
    .delete(eventResources)
    .where(and(eq(eventResources.tenantId, tenantId), eq(eventResources.eventId, eventId)))

  if (wanted.length > 0) {
    await tx
      .insert(eventResources)
      .values(wanted.map((resourceId) => ({ tenantId, eventId, resourceId })))
  }

  return syncEventBlocks(tx, tenantId, eventId)
}

/** The selection, for the management UI. Ids plus display names. */
export async function listEventResources(
  tx: DB,
  tenantId: string,
  eventId: string,
): Promise<{ resourceId: string; name: string }[]> {
  return tx
    .select({ resourceId: eventResources.resourceId, name: resources.name })
    .from(eventResources)
    .innerJoin(resources, eq(resources.id, eventResources.resourceId))
    .where(and(eq(eventResources.tenantId, tenantId), eq(eventResources.eventId, eventId)))
    .orderBy(resources.sortOrder, resources.name)
}

/** Which resources this event currently HOLDS. The blocks, not the selection. */
export async function listEventBlocks(
  tx: DB,
  tenantId: string,
  eventId: string,
): Promise<{ resourceId: string; resourceName: string; startsAt: Date; endsAt: Date }[]> {
  return tx
    .select({
      resourceId: bookingSlots.resourceId,
      resourceName: bookingSlots.resourceName,
      startsAt: bookingSlots.startsAt,
      endsAt: bookingSlots.endsAt,
    })
    .from(bookingSlots)
    .where(and(eq(bookingSlots.tenantId, tenantId), eq(bookingSlots.eventId, eventId)))
    .orderBy(bookingSlots.resourceName)
}

/**
 * Bookable stations in a branch, for the management UI's picker.
 *
 * `ne(status, 'inactive')` rather than `eq(status, 'available')`: a station in
 * maintenance should still be listable so a manager can plan an event around a
 * machine that will be back, while a retired one should not.
 */
export async function listBranchResources(
  tx: DB,
  tenantId: string,
  branchId: string,
): Promise<{ id: string; name: string; typeName: string; status: string }[]> {
  return tx
    .select({
      id: resources.id,
      name: resources.name,
      typeName: sql<string>`coalesce(${resourceTypes.name}, 'Resource')`,
      status: sql<string>`${resources.status}::text`,
    })
    .from(resources)
    .leftJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(
      and(
        eq(resources.tenantId, tenantId),
        eq(resources.branchId, branchId),
        ne(resources.status, 'inactive'),
      ),
    )
    .orderBy(resources.sortOrder, resources.name)
}

