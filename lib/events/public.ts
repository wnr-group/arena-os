import 'server-only'
import { cache } from 'react'
import { and, asc, eq, gte, inArray } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { branches, events } from '@/db/schema'
import {
  PUBLIC_EVENT_STATUSES,
  spotsRemaining,
  type EventStatus,
  type EventType,
  type TournamentFormat,
} from './types'
import type { EventRegistrationMode } from './registration'
import { getPublicEventTakenCounts } from './registrations'

/**
 * The PUBLIC event readers (M15 #2) — the only way an un-authenticated visitor
 * reaches the events table.
 *
 * ── Three things make this safe, and they are independent ───────────────────
 *
 * 1. The tenant is never taken from the browser. Callers pass a tenantId they
 *    got from getPublicTenantBySlug(), which resolves the SUBDOMAIN through the
 *    public_tenant_by_slug() SECURITY DEFINER function (0022). A visitor cannot
 *    influence it by supplying a query param, body field or header.
 *
 * 2. withPublicTenant() pins that id into `app.public_tenant_id` for the life
 *    of one transaction, and sets no user and no customer. Every staff policy
 *    (keyed off auth_tenant_ids()) therefore matches nothing.
 *
 * 3. events_public_select (0089) then admits only rows whose tenant matches
 *    that pin AND whose status is published/registration_open. So even the
 *    query below asking for a bare event id can only ever return a public event
 *    belonging to the pinned tenant — the id alone is not authority.
 *
 * The status predicate is repeated in the queries anyway. That is not
 * redundancy for its own sake: it keeps the intent visible at the call site and
 * makes the SQL explain plan use idx_events_public_upcoming. The policy remains
 * the thing that actually enforces it.
 */

export type PublicEvent = {
  id: string
  title: string
  type: EventType
  description: string | null
  bannerUrl: string | null
  startsAt: Date
  endsAt: Date
  capacity: number | null
  /** null when uncapped. See spotsRemaining() for the M15 #3 dependency. */
  spotsLeft: number | null
  entryFee: string
  tournamentFormat: TournamentFormat | null
  /** Solo vs team entry (M15 #3) — decides what "a place" and "the fee" mean. */
  registrationMode: EventRegistrationMode
  teamSize: number | null
  status: EventStatus
  branchName: string | null
}

const publicColumns = {
  id: events.id,
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
  branchName: branches.name,
}

/**
 * Attach the real headcount (M15 #3).
 *
 * `taken` comes from public_event_taken_counts() — a SECURITY DEFINER aggregate
 * over publicly visible events only, which is how a stranger learns how many
 * places are left without being given a single registration ROW. An event with
 * no entrants is absent from the map, hence the `?? 0`.
 */
function toPublicEvent(r: Omit<PublicEvent, 'spotsLeft'>, taken: Map<string, number>): PublicEvent {
  return { ...r, spotsLeft: spotsRemaining(r.capacity, taken.get(r.id) ?? 0) }
}

/**
 * Upcoming public events for one tenant, soonest first.
 *
 * "Upcoming" is `ends_at >= now` — an event that has already finished is not
 * something a visitor can act on, and it keeps the listing self-pruning without
 * anyone having to move it to `completed` on time.
 */
export const getPublicEvents = cache(async function getPublicEvents(
  tenantId: string,
  opts: { limit?: number } = {},
): Promise<PublicEvent[]> {
  const rows = await withPublicTenant(tenantId, (tx) => {
    const q = tx
      .select(publicColumns)
      .from(events)
      .leftJoin(branches, eq(branches.id, events.branchId))
      .where(
        and(
          eq(events.tenantId, tenantId),
          inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
          gte(events.endsAt, new Date()),
        ),
      )
      .orderBy(asc(events.startsAt))
    return opts.limit ? q.limit(opts.limit) : q
  })
  const taken = await getPublicEventTakenCounts(tenantId)
  return rows.map((r) => toPublicEvent(r, taken))
})

/**
 * A small number of upcoming events for the homepage promotion. A thin alias
 * over getPublicEvents so the homepage cannot accidentally apply a different
 * visibility rule from the listing.
 */
export function getUpcomingPublicEvents(tenantId: string, limit: number): Promise<PublicEvent[]> {
  return getPublicEvents(tenantId, { limit })
}

/**
 * One public event by id, or null.
 *
 * Null covers every non-public case identically — unknown id, another tenant's
 * event, a draft, a cancelled event — because the caller 404s on null and a
 * visitor must not be able to tell those apart. Distinguishing them would leak
 * the existence of a private event.
 *
 * NOTE the tenantId predicate is belt-and-braces on top of the policy: even if
 * events_public_select were ever loosened, this query still cannot cross a
 * tenant boundary.
 */
export const getPublicEventById = cache(async function getPublicEventById(
  tenantId: string,
  eventId: string,
): Promise<PublicEvent | null> {
  // A malformed id would make Postgres raise 22P02 rather than return no rows,
  // which would surface as a 500 on a URL a visitor simply typed wrong.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) return null

  const [row] = await withPublicTenant(tenantId, (tx) =>
    tx
      .select(publicColumns)
      .from(events)
      .leftJoin(branches, eq(branches.id, events.branchId))
      .where(
        and(
          eq(events.id, eventId),
          eq(events.tenantId, tenantId),
          inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
        ),
      )
      .limit(1),
  )
  if (!row) return null
  return toPublicEvent(row, await getPublicEventTakenCounts(tenantId))
})
