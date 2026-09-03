import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { withUser, type DB } from '@/db'
import { customers, eventRegistrations, eventTeams, events } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/**
 * DAY-OF CHECK-IN (M15 #5).
 *
 * The manual path already existed — checkInEventRegistrationCore() in
 * ./registrations.ts, reached from the entrants table. This module adds the
 * three things that ticket asks for on top: resolving a QR token, the live
 * counts, promoting the waitlist for a no-show, and the checked-in list a
 * future bracket ticket will seed from.
 *
 * ── No second scanning system ───────────────────────────────────────────────
 *
 * The token is `event_registrations.check_in_token` (migration 0085), which is
 * the SAME shape as `bookings.confirmation_token` (0026) that /bookings/scan
 * already resolves: a v4 uuid, unique per tenant, looked up as
 * (tenant_id, token) with the tenant taken from the staff session. The scan
 * ACTION mirrors checkInBookingByToken() in lib/actions/bookings.ts, including
 * its "extract the uuid from whatever the scanner typed" step — a keyboard
 * wedge may deliver a full URL or a bare token, and both have to work.
 *
 * ── No second capacity system ───────────────────────────────────────────────
 *
 * Promotion delegates to `promote_event_waitlist()` (0081), the same function
 * cancellation already calls. Every capacity, FIFO and paid-event rule stays in
 * one place, under the lock it already takes.
 */

export type CheckInRefusal =
  | 'not_found'
  | 'cancelled'
  | 'waitlisted'
  | 'awaiting_payment'
  | 'event_cancelled'

/** What the scan screen shows once a token resolves. No ids, no payment data. */
export type CheckedInEntrant = {
  customerName: string | null
  teamName: string | null
  eventTitle: string
  checkedInAt: Date | null
}

export type CheckInOutcome =
  | { ok: true; alreadyCheckedIn: boolean; entrant: CheckedInEntrant }
  | { ok: false; reason: CheckInRefusal }

/** Staff-facing sentence for each refusal. One place, so the UI never invents one. */
export function checkInRefusalMessage(reason: CheckInRefusal): string {
  switch (reason) {
    case 'not_found':
      return 'No registration found for that code.'
    case 'cancelled':
      return 'That registration was cancelled — it cannot be checked in.'
    case 'waitlisted':
      return 'This entrant is on the waitlist. Promote them to a place first, then scan again.'
    case 'awaiting_payment':
      return 'Entry has not been paid for yet. Take payment before checking them in.'
    case 'event_cancelled':
      return 'This event has been cancelled.'
  }
}

/**
 * Resolve a scanned check-in token and admit the holder.
 *
 * ── The tenant is NEVER taken from the scan ─────────────────────────────────
 *
 * It comes from the staff session and is part of the WHERE clause, so a token
 * belonging to another business matches nothing and is reported exactly like a
 * token that does not exist. That indistinguishability is deliberate: a scan
 * must not confirm that some other tenant holds the row. The event is likewise
 * read FROM the row rather than supplied, so no argument can point a scan at a
 * different event's registrant.
 *
 * ── The eligibility ladder, and why each rung is reported separately ────────
 *
 *   cancelled          they withdrew, or staff removed them.
 *   waitlisted         a place was never granted. Admitting here would be
 *                      precisely the capacity bypass the ticket forbids — the
 *                      queue is consumed by promote_event_waitlist() under a
 *                      lock, and a scanner must not become a second way in.
 *   pending_payment    a paid event whose money has not arrived. `registered`
 *                      is reached ONLY through
 *                      confirm_event_registration_payment() from a verified
 *                      webhook (0082), so "has it been paid?" is already
 *                      answered by the status — there is no second, forgeable
 *                      payment check here, and there must not be one.
 *   event cancelled    nobody is arriving.
 *
 * Distinct reasons because the counter needs to say WHY: "pay at the desk" and
 * "you are not on the list" are different conversations.
 *
 * ── Idempotent, and the first timestamp is the true one ─────────────────────
 *
 * An already-checked-in registration returns ok with `alreadyCheckedIn: true`
 * and writes NOTHING — a second scan must not move the arrival time. Two staff
 * scanning at once serialise on `for update`; the second sees `checked_in` and
 * takes that branch, so the row is written exactly once.
 */
export async function checkInByTokenCore(
  tx: DB,
  ctx: { tenantId: string },
  token: string,
): Promise<CheckInOutcome> {
  const [row] = await tx
    .select({
      id: eventRegistrations.id,
      status: eventRegistrations.status,
      checkedInAt: eventRegistrations.checkedInAt,
      customerName: customers.name,
      teamName: eventTeams.name,
      eventTitle: events.title,
      eventStatus: events.status,
    })
    .from(eventRegistrations)
    .innerJoin(customers, eq(customers.id, eventRegistrations.customerId))
    .innerJoin(events, eq(events.id, eventRegistrations.eventId))
    .leftJoin(eventTeams, eq(eventTeams.id, eventRegistrations.teamId))
    .where(
      and(
        eq(eventRegistrations.tenantId, ctx.tenantId),
        eq(eventRegistrations.checkInToken, token),
      ),
    )
    .for('update', { of: eventRegistrations })
    .limit(1)

  if (!row) return { ok: false, reason: 'not_found' }

  const entrant: CheckedInEntrant = {
    customerName: row.customerName,
    teamName: row.teamName,
    eventTitle: row.eventTitle,
    checkedInAt: row.checkedInAt,
  }

  if (row.status === 'checked_in') return { ok: true, alreadyCheckedIn: true, entrant }
  if (row.eventStatus === 'cancelled') return { ok: false, reason: 'event_cancelled' }
  if (row.status === 'cancelled') return { ok: false, reason: 'cancelled' }
  if (row.status === 'waitlisted') return { ok: false, reason: 'waitlisted' }
  if (row.status === 'pending_payment') return { ok: false, reason: 'awaiting_payment' }

  const now = new Date()
  await tx
    .update(eventRegistrations)
    .set({ status: 'checked_in', checkedInAt: now })
    .where(
      and(
        eq(eventRegistrations.id, row.id),
        eq(eventRegistrations.tenantId, ctx.tenantId),
        // The status predicate again, beside the row lock: belt and braces, and
        // it makes the write a provable no-op if anything changed underneath.
        eq(eventRegistrations.status, 'registered'),
      ),
    )

  return { ok: true, alreadyCheckedIn: false, entrant: { ...entrant, checkedInAt: now } }
}

export type EventCheckInCounts = {
  /** Confirmed and NOT yet arrived — `registered` in the strict sense. */
  registered: number
  /** Arrived. */
  checkedIn: number
  /** registered + checkedIn: every confirmed place, however it has been spent. */
  confirmed: number
  waitlisted: number
  /** Holding a place while their payment window runs. Nobody has paid yet. */
  pendingPayment: number
  cancelled: number
}

/**
 * The live counts for one event, aggregated in SQL.
 *
 * ── "Registered" means NOT YET ARRIVED, and the UI says so ──────────────────
 *
 * The ticket asks for this choice to be explicit. `registered` here is the
 * strict status, so the headline numbers PARTITION the confirmed set rather
 * than overlapping: an entrant is either still expected or already in. The
 * total is returned as `confirmed` alongside, so no caller has to re-derive
 * either meaning by addition and get it subtly wrong.
 *
 * Cancelled entries appear in NONE of the active numbers; they are reported on
 * their own. `pending_payment` is also its own number: it occupies a place
 * (event_registration_occupancy counts it) but no money has arrived, so folding
 * it into "registered" would tell a manager more people are coming than are.
 */
export async function getEventCheckInCounts(
  ctx: ActiveContext,
  eventId: string,
): Promise<EventCheckInCounts> {
  const rows = await withUser(ctx.user.id, (tx) =>
    tx
      .select({
        registered: sql<number>`count(*) filter (where ${eventRegistrations.status} = 'registered')`.mapWith(Number),
        checkedIn: sql<number>`count(*) filter (where ${eventRegistrations.status} = 'checked_in')`.mapWith(Number),
        waitlisted: sql<number>`count(*) filter (where ${eventRegistrations.status} = 'waitlisted')`.mapWith(Number),
        pendingPayment: sql<number>`count(*) filter (where ${eventRegistrations.status} = 'pending_payment')`.mapWith(Number),
        cancelled: sql<number>`count(*) filter (where ${eventRegistrations.status} = 'cancelled')`.mapWith(Number),
      })
      .from(eventRegistrations)
      .where(
        and(
          eq(eventRegistrations.tenantId, ctx.tenant.id),
          eq(eventRegistrations.eventId, eventId),
        ),
      ),
  )

  const row = rows[0]
  const registered = row?.registered ?? 0
  const checkedIn = row?.checkedIn ?? 0
  return {
    registered,
    checkedIn,
    confirmed: registered + checkedIn,
    waitlisted: row?.waitlisted ?? 0,
    pendingPayment: row?.pendingPayment ?? 0,
    cancelled: row?.cancelled ?? 0,
  }
}

/** One participant who actually turned up. The seeding input (§9). */
export type CheckedInParticipant = {
  registrationId: string
  eventId: string
  customerId: string
  customerName: string | null
  teamId: string | null
  teamName: string | null
  checkedInAt: Date
}

/**
 * Everyone who has checked in for one event, in arrival order.
 *
 * Exists so the future bracket ticket takes a server-side reader rather than
 * reaching into the check-in UI for its participant list. It deliberately
 * implements NO seeding — no ranking, no bracket shape, no ordering rule beyond
 * arrival. Those are that ticket's decisions, and guessing at them here is
 * exactly what it would then have to undo.
 *
 * Arrival order is the one ordering that is a fact rather than a policy, and it
 * is made stable by the id tiebreak so two calls return the same list.
 */
export async function listCheckedInParticipants(
  ctx: ActiveContext,
  eventId: string,
): Promise<CheckedInParticipant[]> {
  const rows = await withUser(ctx.user.id, (tx) =>
    tx
      .select({
        registrationId: eventRegistrations.id,
        eventId: eventRegistrations.eventId,
        customerId: eventRegistrations.customerId,
        customerName: customers.name,
        teamId: eventRegistrations.teamId,
        teamName: eventTeams.name,
        checkedInAt: eventRegistrations.checkedInAt,
      })
      .from(eventRegistrations)
      .innerJoin(customers, eq(customers.id, eventRegistrations.customerId))
      .leftJoin(eventTeams, eq(eventTeams.id, eventRegistrations.teamId))
      .where(
        and(
          eq(eventRegistrations.tenantId, ctx.tenant.id),
          eq(eventRegistrations.eventId, eventId),
          eq(eventRegistrations.status, 'checked_in'),
        ),
      )
      .orderBy(asc(eventRegistrations.checkedInAt), asc(eventRegistrations.id)),
  )

  // Every checked_in row has a timestamp — both writers set it in the same
  // statement as the status — but the column is nullable, so this narrows
  // rather than asserts.
  return rows.flatMap((r) => (r.checkedInAt ? [{ ...r, checkedInAt: r.checkedInAt }] : []))
}

/**
 * Promote the waitlist for one event, as staff (§7).
 *
 * A thin wrapper over `promote_event_waitlist()` — the SAME function
 * cancel_event_registration() already calls — so there is exactly one
 * implementation of "who is next, is there room, and what does a paid event owe
 * them". Reusing it is what makes this capacity-safe and FIFO-correct without
 * restating either rule:
 *
 *   * it re-reads occupancy under the event lock on every iteration, so two
 *     staff clicking Promote at once cannot both consume the same place;
 *   * it stops at capacity, so promotion can never exceed it;
 *   * on a PAID event it promotes to `pending_payment` with a 24-hour hold, NOT
 *     to `registered`. Nobody is marked paid without a verified webhook — which
 *     is also why a promoted entrant on a paid event still cannot be checked in
 *     until they actually pay;
 *   * with no free place it promotes nobody and returns 0, so calling it twice
 *     is harmless.
 *
 * The event is re-read under the caller's RLS FIRST, because the function takes
 * a bare event id: that read is what proves the event belongs to this tenant
 * before the id is passed to a SECURITY DEFINER routine. A foreign id finds
 * nothing and returns 0 rather than reaching the function at all.
 */
export async function promoteEventWaitlistAsStaff(
  ctx: ActiveContext,
  eventId: string,
): Promise<number> {
  return withUser(ctx.user.id, async (tx) => {
    const [ev] = await tx
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenant.id)))
      .limit(1)
    if (!ev) return 0

    const res = await tx.execute(
      sql`select public.promote_event_waitlist_as_staff(${eventId}::uuid) as promoted`,
    )
    return Number((res.rows[0] as { promoted: number | string })?.promoted ?? 0)
  })
}
