import 'server-only'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { branches, eventResources, eventSeries, events, resources } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import type { EventRow, EventWithBranch } from './types'

/**
 * Event readers.
 *
 * Every query runs through withUser() on the restricted app connection, so the
 * events_select policy (0076) is what actually confines the result to the
 * caller's tenant. The explicit tenantId predicate is belt-and-braces and makes
 * the intent readable at the call site — the same shape lib/happy-hours/data.ts
 * and lib/loyalty/data.ts use.
 *
 * These return the shared EventRow/EventWithBranch types from ./types, so the
 * public listing, registration and bracket stories can consume the same reader
 * output rather than re-selecting columns by hand.
 */

/** One tenant's events, soonest first. */
export function listEvents(ctx: ActiveContext): Promise<EventWithBranch[]> {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: events.id,
        tenantId: events.tenantId,
        branchId: events.branchId,
        title: events.title,
        type: events.type,
        description: events.description,
        bannerUrl: events.bannerUrl,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        capacity: events.capacity,
        entryFee: events.entryFee,
        tournamentFormat: events.tournamentFormat,
        registrationMode: events.registrationMode,
        teamSize: events.teamSize,
        status: events.status,
        resourceScope: events.resourceScope,
        createdAt: events.createdAt,
        updatedAt: events.updatedAt,
        branchName: branches.name,
      })
      .from(events)
      .leftJoin(branches, eq(branches.id, events.branchId))
      .where(eq(events.tenantId, ctx.tenant.id))
      .orderBy(asc(events.startsAt)),
  )
}

/** One event by id, or null when it does not exist in the caller's tenant. */
export function getEvent(ctx: ActiveContext, eventId: string): Promise<EventRow | null> {
  return withUser(ctx.user.id, async (tx) => {
    const [row] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenant.id)))
      .limit(1)
    return row ? toEventRow(row) : null
  })
}

/** The branches a manager may attach an event to — the event form's dropdown. */
export function listEventBranches(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.status, 'active')))
      .orderBy(desc(branches.isPrimary), asc(branches.name)),
  )
}

/** Narrows a raw select() row to the shared EventRow shape. */
function toEventRow(r: typeof events.$inferSelect): EventRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    branchId: r.branchId,
    title: r.title,
    type: r.type,
    description: r.description,
    bannerUrl: r.bannerUrl,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    capacity: r.capacity,
    entryFee: r.entryFee,
    tournamentFormat: r.tournamentFormat,
    registrationMode: r.registrationMode,
    teamSize: r.teamSize,
    status: r.status,
    resourceScope: r.resourceScope,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/**
 * Which stations each event has SELECTED (M15 #4), as eventId → resourceIds.
 *
 * One query for the whole list rather than one per event — the management page
 * renders every event, and a per-row read would be an N+1 on a page that
 * already loads three lists.
 */
export async function listEventResourceSelections(
  ctx: ActiveContext,
): Promise<Map<string, string[]>> {
  const rows = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ eventId: eventResources.eventId, resourceId: eventResources.resourceId })
      .from(eventResources)
      .where(eq(eventResources.tenantId, ctx.tenant.id)),
  )
  const map = new Map<string, string[]>()
  for (const r of rows) map.set(r.eventId, [...(map.get(r.eventId) ?? []), r.resourceId])
  return map
}

/**
 * The stations a manager may attach to an event, per branch — the picker.
 *
 * Retired ('inactive') stations are excluded: they cannot be booked, so
 * reserving one would be a no-op the manager would have to reason about. One
 * in maintenance IS listed, because an event next month can legitimately claim
 * a machine that is being repaired today.
 */
export function listBookableResources(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: resources.id,
        branchId: resources.branchId,
        name: resources.name,
        status: resources.status,
      })
      .from(resources)
      .where(and(eq(resources.tenantId, ctx.tenant.id), ne(resources.status, 'inactive')))
      .orderBy(asc(resources.sortOrder), asc(resources.name)),
  )
}
/**
 * The recurring series a manager configures (M15 #8).
 *
 * Read-only here; generation belongs to scripts/run-recurring-events.ts, which
 * is the single code path that creates an occurrence. `occurrences` is a count
 * so the list can say "12 generated" without loading them.
 */
export async function listEventSeries(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: eventSeries.id,
        branchId: eventSeries.branchId,
        branchName: branches.name,
        title: eventSeries.title,
        type: eventSeries.type,
        cadence: eventSeries.cadence,
        weekday: eventSeries.weekday,
        dayOfMonth: eventSeries.dayOfMonth,
        startTime: eventSeries.startTime,
        durationMinutes: eventSeries.durationMinutes,
        nextRun: eventSeries.nextRun,
        untilDate: eventSeries.untilDate,
        isActive: eventSeries.isActive,
        capacity: eventSeries.capacity,
        entryFee: eventSeries.entryFee,
        registrationMode: eventSeries.registrationMode,
        teamSize: eventSeries.teamSize,
        tournamentFormat: eventSeries.tournamentFormat,
        description: eventSeries.description,
        occurrences: sql<number>`(
          select count(*) from public.events e where e.series_id = ${eventSeries.id}
        )`.mapWith(Number),
      })
      .from(eventSeries)
      .leftJoin(branches, eq(branches.id, eventSeries.branchId))
      .where(eq(eventSeries.tenantId, ctx.tenant.id))
      .orderBy(desc(eventSeries.isActive), asc(eventSeries.title)),
  )
}
