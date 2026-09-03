import 'server-only'
import { cache } from 'react'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { withCustomer, withPublicTenant, withUser, type DB } from '@/db'
import { branches, customers, eventRegistrations, events, eventTeams } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import type { EventStatus, EventType } from './types'
import {
  ACTIVE_STATUSES,
  type EventParticipation,
  type EventRegistrationMode,
  type EventRegistrationStatus,
  type EventTeamOption,
} from './registration'

/**
 * The registration core (M15 #3) — every entry point a customer or a manager
 * reaches registrations through.
 *
 * ── Where the safety actually lives ─────────────────────────────────────────
 *
 * Not here. The capacity rule, the duplicate rule, the FIFO waitlist and the
 * authorisation are all inside migration 0079's functions, which hold
 * `select … from events … for update` while they decide. This module's job is
 * to open the right RLS-scoped transaction, call one of them, and turn a
 * refusal code into something a caller can act on.
 *
 * That division is deliberate. Capacity is a count across rows taken under a
 * lock; expressed in TypeScript it would be a read, a decision and a write with
 * a window between each, which is exactly the sequence the ticket forbids. So
 * the decision never leaves Postgres, and nothing in this file can be called in
 * a way that skips it — there is no `insert(eventRegistrations)` anywhere in
 * the codebase outside a test.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 *
 * Every customer-facing function takes a `customerId` that its caller got from
 * getCurrentCustomer() — a validated OTP session — and passes it ONLY to
 * withCustomer(), which pins `app.customer_id`. The SQL functions then read
 * current_customer_id() for themselves and take no identity argument at all, so
 * there is no parameter through which one customer could act as another.
 */

/** What a claim returns: either a refusal, or the entry that now exists. */
export type ClaimOutcome =
  | { ok: false; refusal: string }
  | {
      ok: true
      registrationId: string
      status: EventRegistrationStatus
      teamId: string | null
      /** The event's fee, read from the event row inside the database. */
      entryFee: string
    }

type ClaimRow = {
  refusal: string | null
  registration_id: string | null
  registration_status: EventRegistrationStatus | null
  team_id: string | null
  entry_fee: string | null
}

/**
 * Enter the signed-in customer for an event — the one write that creates a
 * registration.
 *
 * `teamName` is passed straight through and is only meaningful for a team
 * event; whether it is meaningful is decided by the EVENT's registration_mode
 * inside the function, not by whether the browser sent one.
 */
export async function claimEventRegistration(
  customerId: string,
  eventId: string,
  teamName: string | null,
): Promise<ClaimOutcome> {
  const row = await withCustomer(customerId, async (tx) => {
    const { rows } = await tx.execute<ClaimRow>(
      sql`select * from public.claim_event_registration(${eventId}::uuid, ${teamName}::text)`,
    )
    return rows[0]
  })

  if (!row || row.refusal) return { ok: false, refusal: row?.refusal ?? 'not_found' }
  return {
    ok: true,
    registrationId: row.registration_id!,
    status: row.registration_status!,
    teamId: row.team_id,
    entryFee: row.entry_fee ?? '0',
  }
}

/** Join an existing team. Returns 'joined' or a refusal code. */
export async function joinEventTeam(customerId: string, teamId: string): Promise<string> {
  return withCustomer(customerId, async (tx) => {
    const { rows } = await tx.execute<{ join_event_team: string }>(
      sql`select public.join_event_team(${teamId}::uuid) as join_event_team`,
    )
    return rows[0]?.join_event_team ?? 'not_found'
  })
}

/**
 * Cancel one's own registration. Returns 'cancelled' or a refusal code.
 *
 * The same SQL function serves staff (below); it decides which actor is calling
 * from whichever session context is set, so a customer connection can only ever
 * authorise as that customer.
 */
export async function cancelOwnEventRegistration(
  customerId: string,
  registrationId: string,
): Promise<string> {
  return withCustomer(customerId, async (tx) => {
    const { rows } = await tx.execute<{ cancel_event_registration: string }>(
      sql`select public.cancel_event_registration(${registrationId}::uuid) as cancel_event_registration`,
    )
    return rows[0]?.cancel_event_registration ?? 'not_found'
  })
}

/**
 * Cancel someone else's registration as an owner/manager.
 *
 * Identical function, different context: it authorises through
 * auth_is_manager(), so a cashier's connection gets 'not_found' even though the
 * action layer (requireManager) would already have refused. Cancelling frees
 * the place and promotes the waitlist in the same locked transaction.
 */
export async function cancelEventRegistrationAsStaff(
  userId: string,
  registrationId: string,
): Promise<string> {
  return withUser(userId, async (tx) => {
    const { rows } = await tx.execute<{ cancel_event_registration: string }>(
      sql`select public.cancel_event_registration(${registrationId}::uuid) as cancel_event_registration`,
    )
    return rows[0]?.cancel_event_registration ?? 'not_found'
  })
}

type ParticipationRow = {
  registration_id: string
  registration_status: EventRegistrationStatus
  is_captain: boolean
  is_own_registration: boolean
  team_id: string | null
  team_name: string | null
  team_member_count: number | null
  waitlist_position: number | null
  paid_amount: string | null
  refund_required: boolean | null
  hold_expires_at: Date | string | null
}

/**
 * Where the signed-in customer stands in one event, or null when they are not
 * in it at all.
 *
 * Covers team players who hold no registration of their own — their captain
 * does — which is why this goes through my_event_participation() rather than
 * selecting the table directly.
 */
export async function getMyEventParticipation(
  customerId: string,
  eventId: string,
): Promise<EventParticipation | null> {
  const row = await withCustomer(customerId, async (tx) => {
    const { rows } = await tx.execute<ParticipationRow>(
      sql`select * from public.my_event_participation(${eventId}::uuid)`,
    )
    return rows[0] ?? null
  })
  if (!row) return null

  return {
    registrationId: row.registration_id,
    status: row.registration_status,
    isCaptain: row.is_captain,
    isOwnRegistration: row.is_own_registration,
    teamId: row.team_id,
    teamName: row.team_name,
    teamMemberCount: row.team_member_count ?? 0,
    waitlistPosition: row.waitlist_position,
    paidAmount: row.paid_amount,
    refundRequired: row.refund_required,
    holdExpiresAt: row.hold_expires_at ? new Date(row.hold_expires_at) : null,
  }
}

type TeamRow = { team_id: string; team_name: string; member_count: number; team_size: number }

function toTeamOption(r: TeamRow): EventTeamOption {
  return {
    teamId: r.team_id,
    teamName: r.team_name,
    memberCount: Number(r.member_count),
    teamSize: Number(r.team_size),
  }
}

/**
 * The teams entered in one event, for the "join a team" list.
 *
 * Two entry points because the page is reachable both signed-out (a visitor
 * deciding whether to sign in) and signed-in. public_event_teams() derives the
 * tenant from whichever context is pinned, so neither caller passes one.
 */
export function listPublicEventTeams(tenantId: string, eventId: string): Promise<EventTeamOption[]> {
  return withPublicTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<TeamRow>(
      sql`select * from public.public_event_teams(${eventId}::uuid)`,
    )
    return rows.map(toTeamOption)
  })
}

export function listEventTeamsForCustomer(
  customerId: string,
  eventId: string,
): Promise<EventTeamOption[]> {
  return withCustomer(customerId, async (tx) => {
    const { rows } = await tx.execute<TeamRow>(
      sql`select * from public.public_event_teams(${eventId}::uuid)`,
    )
    return rows.map(toTeamOption)
  })
}

/**
 * Places already taken, per event, for the public listing and detail pages.
 *
 * Goes through public_event_taken_counts(), which returns only an aggregate and
 * only for publicly visible events — a visitor gets a number, never a row.
 *
 * Wrapped in React cache() like the public event readers themselves, so a page
 * rendering the listing, the homepage strip and a detail card in one request
 * counts once rather than three times.
 */
export const getPublicEventTakenCounts = cache(async function getPublicEventTakenCounts(
  tenantId: string,
): Promise<Map<string, number>> {
  const rows = await withPublicTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<{ event_id: string; taken: number }>(
      sql`select * from public.public_event_taken_counts(${tenantId}::uuid)`,
    )
    return rows
  })
  return new Map(rows.map((r) => [r.event_id, Number(r.taken)]))
})

/** One customer's own entries, newest first — the portal list. */
export type MyEventRegistration = {
  registrationId: string
  status: EventRegistrationStatus
  eventId: string
  title: string
  type: EventType
  eventStatus: EventStatus
  startsAt: Date
  endsAt: Date
  branchName: string | null
  teamName: string | null
  paidAmount: string
  refundRequired: boolean
  holdExpiresAt: Date | null
  entryFee: string
}

export function listMyEventRegistrations(customerId: string): Promise<MyEventRegistration[]> {
  return withCustomer(customerId, (tx) =>
    tx
      .select({
        registrationId: eventRegistrations.id,
        status: eventRegistrations.status,
        eventId: events.id,
        title: events.title,
        type: events.type,
        eventStatus: events.status,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        branchName: branches.name,
        teamName: eventTeams.name,
        paidAmount: eventRegistrations.paidAmount,
        refundRequired: eventRegistrations.refundRequired,
        holdExpiresAt: eventRegistrations.paymentHoldExpiresAt,
        entryFee: events.entryFee,
      })
      .from(eventRegistrations)
      // The customer can read `events` (events_customer_select, 0079) and their
      // own registration rows, and nothing else on either table.
      .innerJoin(events, eq(events.id, eventRegistrations.eventId))
      .leftJoin(branches, eq(branches.id, events.branchId))
      .leftJoin(eventTeams, eq(eventTeams.id, eventRegistrations.teamId))
      .where(eq(eventRegistrations.customerId, customerId))
      .orderBy(desc(events.startsAt)),
  )
}

// ── staff readers ────────────────────────────────────────────────────────────

/** One entrant, as the manager's door list shows them. */
export type EventEntrant = {
  registrationId: string
  status: EventRegistrationStatus
  customerId: string
  customerName: string | null
  customerPhone: string
  teamId: string | null
  teamName: string | null
  paidAmount: string
  refundRequired: boolean
  createdAt: Date
  waitlistPosition: number | null
}

/**
 * The entrants for one event.
 *
 * Runs through withUser() on the restricted connection, so the
 * event_registrations_select policy (0079) is what confines it to the caller's
 * tenant; the explicit tenant predicate is the same belt-and-braces the other
 * event readers use. Waitlisted entries are numbered in FIFO order — the same
 * (created_at, id) ordering promote_event_waitlist() promotes by, so the number
 * a manager reads is the order the database will actually use.
 */
export async function listEventEntrants(
  ctx: ActiveContext,
  eventId: string,
): Promise<EventEntrant[]> {
  const rows = await withUser(ctx.user.id, (tx) =>
    tx
      .select({
        registrationId: eventRegistrations.id,
        status: eventRegistrations.status,
        customerId: eventRegistrations.customerId,
        customerName: customers.name,
        customerPhone: customers.phone,
        teamId: eventRegistrations.teamId,
        teamName: eventTeams.name,
        paidAmount: eventRegistrations.paidAmount,
        refundRequired: eventRegistrations.refundRequired,
        createdAt: eventRegistrations.createdAt,
      })
      .from(eventRegistrations)
      .innerJoin(customers, eq(customers.id, eventRegistrations.customerId))
      .leftJoin(eventTeams, eq(eventTeams.id, eventRegistrations.teamId))
      .where(
        and(
          eq(eventRegistrations.tenantId, ctx.tenant.id),
          eq(eventRegistrations.eventId, eventId),
        ),
      )
      .orderBy(asc(eventRegistrations.createdAt), asc(eventRegistrations.id)),
  )

  let queue = 0
  return rows.map((r) => ({
    ...r,
    waitlistPosition: r.status === 'waitlisted' ? ++queue : null,
  }))
}

/** Live entries per event, for the manager list's "12 / 16 entered" column. */
export async function getEventEntrantCounts(ctx: ActiveContext): Promise<Map<string, number>> {
  const rows = await withUser(ctx.user.id, (tx) =>
    tx
      .select({
        eventId: eventRegistrations.eventId,
        taken: sql<number>`count(*)`.mapWith(Number),
      })
      .from(eventRegistrations)
      .where(
        and(
          eq(eventRegistrations.tenantId, ctx.tenant.id),
          // Confirmed and at-the-door only. A live payment hold is a place the
          // venue cannot sell twice, so it counts here too — the same set
          // OCCUPYING_STATUSES names and event_registration_occupancy() counts.
          inArray(eventRegistrations.status, ['registered', 'checked_in', 'pending_payment']),
        ),
      )
      .groupBy(eventRegistrations.eventId),
  )
  return new Map(rows.map((r) => [r.eventId, r.taken]))
}

/**
 * Mark an entrant as arrived.
 *
 * Plain UPDATE rather than a locked function, deliberately: checked_in is
 * reached only from `registered`, and both occupy a place, so the transition
 * cannot change occupancy and needs no capacity guard. The status predicate in
 * the WHERE makes it a no-op if someone else got there first. RLS
 * (event_registrations_manager_write) is the second gate behind requireManager().
 */
export async function checkInEventRegistrationCore(
  tx: DB,
  ctx: { tenantId: string },
  registrationId: string,
): Promise<boolean> {
  const updated = await tx
    .update(eventRegistrations)
    .set({ status: 'checked_in', checkedInAt: new Date() })
    .where(
      and(
        eq(eventRegistrations.id, registrationId),
        eq(eventRegistrations.tenantId, ctx.tenantId),
        eq(eventRegistrations.status, 'registered'),
      ),
    )
    .returning({ id: eventRegistrations.id })
  return updated.length > 0
}

/** Re-exported so a server caller can take the rules and the core from one place. */
export {
  ACTIVE_STATUSES,
  OCCUPYING_STATUSES,
  refusalMessage,
  type EventRegistrationMode,
  type EventRegistrationStatus,
} from './registration'

/** Narrow guard used by the actions when parsing a mode off a form. */
export function isEventRegistrationMode(v: unknown): v is EventRegistrationMode {
  return v === 'solo' || v === 'team'
}

/** Every status that blocks a second entry — re-exported shape for readability. */
export const ACTIVE_REGISTRATION_STATUSES: readonly EventRegistrationStatus[] = ACTIVE_STATUSES
