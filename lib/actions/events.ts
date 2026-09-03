'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { events } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { uploadImage, deleteImage } from '@/lib/storage/s3'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'
import { EventError, updateEventStatusCore, validateEventFields } from '@/lib/events/service'
import { EVENT_STATUSES, EVENT_TYPES, TOURNAMENT_FORMATS } from '@/lib/events/types'
import { setEventResources, syncEventBlocks } from '@/lib/events/resource-blocks'
import {
  checkInByTokenCore,
  checkInRefusalMessage,
  promoteEventWaitlistAsStaff,
} from '@/lib/events/check-in'
import {
  cancelEventRegistrationAsStaff,
  checkInEventRegistrationCore,
} from '@/lib/events/registrations'
import { refusalMessage } from '@/lib/events/registration'

/**
 * Event management actions (M15 #1).
 *
 * Every mutation goes through requireManager(), so a cashier or floor member
 * gets an AuthError before a query runs. That is the FIRST of two gates: the
 * events_manager_write policy in migration 0078 is the second, and it holds
 * even if a future action here forgets its guard.
 */

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof EventError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code, constraint } = pgError(e)
  // The database's own guards, surfaced as sentences. These should be
  // unreachable — validateEventFields() checks the same rules first — but a
  // constraint name leaking to a manager would be a poor way to find out.
  if (code === '23514') {
    if (constraint === 'events_window') return { error: 'End time must be after start time.' }
    if (constraint === 'events_tournament_format') {
      return { error: 'Only tournaments have a bracket format, and every tournament needs one.' }
    }
    if (constraint === 'events_team_size') {
      return { error: 'A team event needs a team size of 2–50, and a solo event needs none.' }
    }
    return { error: 'That event is not valid. Please check the dates, capacity and fee.' }
  }
  // 23503 = foreign_key_violation. On this table it means the branch does not
  // exist IN THIS TENANT — the composite FK cannot match a branch belonging to
  // someone else, which is exactly the cross-tenant guarantee we want.
  if (code === '23503') return { error: 'That venue is not available for this business.' }
  console.error('[events] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

function revalidateEventPaths() {
  // The manager screen, plus every public surface an event appears on: the
  // listing, the detail page and the homepage promotion.
  revalidatePath('/settings/events')
  revalidatePath('/events')
  revalidatePath('/events/[eventId]', 'page')
  revalidatePath('/')
}

/**
 * `capacity` accepts '' from an empty form field and maps it to null —
 * "unlimited" — rather than 0, which the database rejects.
 */
const eventInput = z.object({
  id: z.string().uuid().optional(),
  branchId: z.string().uuid('Select a venue'),
  title: z.string().trim().min(1, 'Title is required').max(200, 'Title is too long'),
  type: z.enum(EVENT_TYPES as [string, ...string[]]),
  description: z.string().trim().max(5000).optional().or(z.literal('')),
  bannerUrl: z.string().url().max(2000).optional().or(z.literal('')),
  startsAt: z.string().min(1, 'Start time is required'),
  endsAt: z.string().min(1, 'End time is required'),
  // The empty literal MUST come first. z.coerce.number() happily turns '' into
  // 0, so with the branches the other way round a blank "unlimited" capacity
  // parsed as 0 and then failed the >= 1 rule — the exact opposite of what the
  // manager asked for.
  capacity: z
    .union([z.literal(''), z.coerce.number().int()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : Number(v))),
  entryFee: z.coerce.number().default(0),
  tournamentFormat: z
    .enum(TOURNAMENT_FORMATS as [string, ...string[]])
    .optional()
    .or(z.literal(''))
    .transform((v) => (v === '' || v === undefined ? null : v)),
  // M15 #3. Solo unless the manager says otherwise, so every event created
  // before teams existed keeps meaning exactly what it did.
  registrationMode: z.enum(['solo', 'team']).default('solo'),
  // Same empty-literal-first shape as `capacity`, and for the same reason:
  // z.coerce.number() turns '' into 0, which would fail the >= 2 rule instead
  // of meaning "not a team event".
  teamSize: z
    .union([z.literal(''), z.coerce.number().int()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : Number(v))),
  /** M15 #4 — what the event reserves. Defaults to reserving nothing. */
  resourceScope: z.enum(['none', 'branch', 'specific']).optional(),
  /** Only meaningful for scope 'specific'. Validated against the branch server-side. */
  resourceIds: z.array(z.string().uuid()).max(500).optional(),
})

export async function upsertEvent(input: z.input<typeof eventInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = eventInput.parse(input)

    const startsAt = new Date(v.startsAt)
    const endsAt = new Date(v.endsAt)

    const invalid = validateEventFields({
      type: v.type as (typeof EVENT_TYPES)[number],
      startsAt,
      endsAt,
      capacity: v.capacity,
      entryFee: v.entryFee,
      tournamentFormat: v.tournamentFormat as (typeof TOURNAMENT_FORMATS)[number] | null,
      registrationMode: v.registrationMode,
      // A solo event never carries a team size, whatever the form left in the
      // field when the manager switched the mode back.
      teamSize: v.registrationMode === 'team' ? v.teamSize : null,
    })
    if (invalid) return { error: invalid }

    await withUser(ctx.user.id, async (tx) => {
      let eventId: string
      const values = {
        tenantId: ctx.tenant.id,
        branchId: v.branchId,
        title: v.title,
        type: v.type as (typeof EVENT_TYPES)[number],
        description: v.description ? v.description : null,
        bannerUrl: v.bannerUrl ? v.bannerUrl : null,
        startsAt,
        endsAt,
        capacity: v.capacity,
        // numeric column: send a fixed-2 string so no float ever reaches money.
        entryFee: v.entryFee.toFixed(2),
        tournamentFormat: v.tournamentFormat as (typeof TOURNAMENT_FORMATS)[number] | null,
        registrationMode: v.registrationMode,
        teamSize: v.registrationMode === 'team' ? v.teamSize : null,
        resourceScope: v.resourceScope ?? 'none',
      }

      if (v.id) {
        // Status is deliberately NOT settable here — it moves only through
        // setEventStatus() so every change passes the transition table.
        await tx
          .update(events)
          .set(values)
          .where(and(eq(events.id, v.id), eq(events.tenantId, ctx.tenant.id)))
        eventId = v.id
      } else {
        const [created] = await tx
          .insert(events)
          .values({ ...values, createdBy: ctx.membershipId })
          .returning({ id: events.id })
        eventId = created.id
      }

      // ── M15 #4: resources, in the SAME transaction as the event ──────────
      //
      // Not a follow-up write. If the window moved onto a station somebody has
      // booked, setEventResources() throws and THIS WHOLE STATEMENT rolls back
      // — the event keeps its old time and its old blocks rather than being
      // saved with a window it cannot hold. That is what makes an edit atomic
      // in the sense the ticket asks for.
      //
      // Always called, even when scope is 'none' and the list is empty: a
      // manager switching an event from 'specific' back to 'none', or moving
      // its window, must release what it held. syncEventBlocks() recomputes
      // from the row it just wrote, so every edit path converges.
      await setEventResources(
        tx,
        ctx.tenant.id,
        eventId,
        (v.resourceScope ?? 'none') === 'specific' ? (v.resourceIds ?? []) : [],
      )
    })

    revalidateEventPaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}

/** Move an event through its lifecycle. Rejects any transition the table forbids. */
export async function setEventStatus(eventId: string, status: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    const parsed = z
      .object({ eventId: z.string().uuid(), status: z.enum(EVENT_STATUSES as [string, ...string[]]) })
      .parse({ eventId, status })

    await withUser(ctx.user.id, async (tx) => {
      await updateEventStatusCore(
        tx,
        { tenantId: ctx.tenant.id },
        parsed.eventId,
        parsed.status as (typeof EVENT_STATUSES)[number],
      )
      // The lifecycle IS the release mechanism (M15 #4 §6/§7). Publishing takes
      // the stations, completing and cancelling give them back, and 'full' —
      // which is a capacity fact, not an operational one — keeps them. One call
      // in the same transaction as the transition, so the two can never
      // disagree: statusBlocks() in lib/events/resource-blocks.ts is the single
      // place that decides which way round it is.
      //
      // Publishing an event onto a booked station throws here, which rolls the
      // TRANSITION back too. The manager is told what is in the way rather than
      // ending up with a published event holding nothing.
      await syncEventBlocks(tx, ctx.tenant.id, parsed.eventId)
    })

    revalidateEventPaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteEvent(eventId: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    const id = z.string().uuid().parse(eventId)

    const bannerUrl = await withUser(ctx.user.id, async (tx) => {
      const [row] = await tx
        .select({ bannerUrl: events.bannerUrl })
        .from(events)
        .where(and(eq(events.id, id), eq(events.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!row) throw new EventError('Event not found.')
      await tx.delete(events).where(and(eq(events.id, id), eq(events.tenantId, ctx.tenant.id)))
      return row.bannerUrl
    })

    // Best-effort, after the row is gone: deleteImage never throws, and an
    // orphaned object is cheaper than a failed delete. Same order lib/actions
    // /menu.ts uses.
    await deleteImage(bannerUrl)

    revalidateEventPaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Event banner upload — reuses the shared S3 helper, which owns MIME/size
 * validation and the random object key. No second upload mechanism.
 */
export async function uploadEventBanner(formData: FormData): Promise<{ url?: string; error?: string }> {
  try {
    const ctx = await requireManager()
    const file = formData.get('file')
    if (!(file instanceof File)) return { error: 'No file provided.' }
    const url = await uploadImage(file, `tenants/${ctx.tenant.id}/events`)
    return { url }
  } catch (e) {
    return fail(e)
  }
}

// ── entrants (M15 #3) ────────────────────────────────────────────────────────

/**
 * Cancel an entrant's registration as staff.
 *
 * Goes through the SAME cancel_event_registration() the customer path uses, so
 * there is exactly one implementation of "free the place, promote the queue,
 * flag any money for refund, write the audit entry". The function authorises
 * through auth_is_manager() on its own account, which is the database half of
 * the requireManager() below — a cashier's connection gets 'not_found' even if
 * this guard were ever removed.
 */
export async function cancelEventRegistration(registrationId: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    const id = z.string().uuid().parse(registrationId)

    const outcome = await cancelEventRegistrationAsStaff(ctx.user.id, id)
    if (outcome !== 'cancelled') return { error: refusalMessage(outcome) }

    revalidateEventPaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Mark an entrant as arrived.
 *
 * `registered → checked_in` only. Both statuses occupy a place, so this cannot
 * change occupancy and needs no capacity guard — see
 * checkInEventRegistrationCore. A no-op (someone else got there first, or the
 * entry is not confirmed) is reported rather than silently succeeding.
 */
export async function checkInEventRegistration(registrationId: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    const id = z.string().uuid().parse(registrationId)

    const ok = await withUser(ctx.user.id, (tx) =>
      checkInEventRegistrationCore(tx, { tenantId: ctx.tenant.id }, id),
    )
    if (!ok) return { error: 'Only a confirmed entrant can be checked in.' }

    revalidateEventPaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}
// ── M15 #5: QR check-in and waitlist promotion ───────────────────────────────

/** The uuid inside whatever the scanner delivered. Same shape as the booking scan. */
const CHECK_IN_TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * A scanned QR may arrive as a full URL, or as a bare token from a keyboard
 * wedge or a paste. The check_in_token is the only uuid in either, so this
 * pulls it out rather than demanding one exact format — identical to
 * extractConfirmationToken() in lib/actions/bookings.ts.
 */
function extractCheckInToken(raw: string): string | null {
  const match = raw.match(CHECK_IN_TOKEN_RE)
  return match ? match[0].toLowerCase() : null
}

export type EventCheckInActionResult = Result & {
  entrant?: {
    customerName: string | null
    teamName: string | null
    eventTitle: string
    checkedInAt: string | null
    alreadyCheckedIn: boolean
  }
}

/**
 * Check a registrant in from a scanned QR code.
 *
 * requireManager() is the authorization boundary — a server action is a public
 * POST endpoint, so a customer holding their own token cannot reach this and
 * cannot check themselves in. The TENANT comes from that session and is part of
 * the lookup, so a token from another business resolves to nothing.
 *
 * An already-checked-in scan is reported as such rather than as an error: the
 * counter needs "already in, at 18:04", not a red banner.
 */
export async function checkInEventRegistrationByToken(
  raw: string,
): Promise<EventCheckInActionResult> {
  try {
    const ctx = await requireManager()
    const scanned = z.string().min(1).max(500).parse(raw)
    const token = extractCheckInToken(scanned)
    if (!token) return { error: "That doesn't look like an event check-in code." }

    const outcome = await withUser(ctx.user.id, (tx) =>
      checkInByTokenCore(tx, { tenantId: ctx.tenant.id }, token),
    )
    if (!outcome.ok) return { error: checkInRefusalMessage(outcome.reason) }

    revalidateEventPaths()
    return {
      entrant: {
        customerName: outcome.entrant.customerName,
        teamName: outcome.entrant.teamName,
        eventTitle: outcome.entrant.eventTitle,
        checkedInAt: outcome.entrant.checkedInAt?.toISOString() ?? null,
        alreadyCheckedIn: outcome.alreadyCheckedIn,
      },
    }
  } catch (e) {
    return fail(e)
  }
}

export type PromoteActionResult = Result & { promoted?: number }

/**
 * Promote the next waitlisted entrant into a free place (no-show recovery).
 *
 * Delegates to promote_event_waitlist() — the same locked, capacity-checked,
 * FIFO function cancellation uses — so two staff clicking at once cannot both
 * consume one place, and a full event promotes nobody rather than overfilling.
 */
export async function promoteEventWaitlist(eventId: string): Promise<PromoteActionResult> {
  try {
    const ctx = await requireManager()
    const id = z.string().uuid().parse(eventId)

    const promoted = await promoteEventWaitlistAsStaff(ctx, id)

    revalidateEventPaths()
    return { promoted }
  } catch (e) {
    return fail(e)
  }
}
