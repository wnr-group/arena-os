/**
 * Walk-in waitlist — the transactional core (M20 / AROS-177).
 *
 * A party joins (waiting), the host notifies them when a table is ready
 * (notified), and seating them opens the normal M17 table session through
 * seatTableSessionCore — so the reservation guard, the open-session unique
 * index and billing all behave exactly as for any walk-in.
 */
import 'server-only'
import { and, asc, eq, inArray, isNotNull, gte, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { bookings, notifications, resourceTypes, resources, waitlistEntries } from '@/db/schema'
import { BookingError, seatTableSessionCore } from '@/lib/booking/service'
import { isValidPhone, normalizePhone } from '@/lib/customers/phone'
import { getConfiguredProvider } from '@/lib/notifications/provider'
import { getReservationSettingsCore } from '@/lib/reservations/settings'
import {
  ACTIVE_WAITLIST_STATUSES,
  averageTurnMinutes,
  buildReadyMessage,
  estimateWaitMinutes,
  validateWaitlistInput,
  whatsappUrl,
} from './rules'

type Db = NodePgDatabase<typeof schema>
type Ctx = { tenantId: string; timezone: string; membershipId: string | null }

const MIN = 60_000

async function requireWaitlistEnabled(tx: Db, tenantId: string): Promise<void> {
  const s = await getReservationSettingsCore(tx, tenantId)
  if (!s.waitlistEnabled) throw new BookingError('The waitlist is not enabled for this business.')
}

export type AddWaitlistInput = {
  branchId: string
  name: string
  phone?: string
  partySize: number
  quotedWaitMinutes?: number | null
  notes?: string
}

export async function addWaitlistEntryCore(tx: Db, ctx: Ctx, input: AddWaitlistInput): Promise<{ id: string }> {
  await requireWaitlistEnabled(tx, ctx.tenantId)
  const problem = validateWaitlistInput(input)
  if (problem) throw new BookingError(problem)

  const rawPhone = input.phone?.trim()
  if (rawPhone && !isValidPhone(rawPhone)) throw new BookingError('Enter a valid 10-digit phone number.')

  const [row] = await tx
    .insert(waitlistEntries)
    .values({
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      name: input.name.trim(),
      phone: rawPhone ? normalizePhone(rawPhone) : null,
      partySize: input.partySize,
      quotedWaitMinutes: input.quotedWaitMinutes ?? null,
      notes: input.notes?.trim() || null,
      createdBy: ctx.membershipId,
    })
    .returning({ id: waitlistEntries.id })
  return row
}

/** Lock an entry and require it to still be in the queue. */
async function lockActiveEntry(tx: Db, tenantId: string, entryId: string) {
  const [e] = await tx
    .select()
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.id, entryId), eq(waitlistEntries.tenantId, tenantId)))
    .for('update')
    .limit(1)
  if (!e) throw new BookingError('Waitlist entry not found.')
  if (!ACTIVE_WAITLIST_STATUSES.includes(e.status as never)) {
    throw new BookingError(`This party is already ${e.status}.`)
  }
  return e
}

export async function leaveWaitlistCore(tx: Db, ctx: Ctx, entryId: string): Promise<void> {
  const e = await lockActiveEntry(tx, ctx.tenantId, entryId)
  await tx
    .update(waitlistEntries)
    .set({ status: 'left', leftAt: new Date() })
    .where(and(eq(waitlistEntries.id, e.id), eq(waitlistEntries.tenantId, ctx.tenantId)))
}

/**
 * Phase 1 of "Notify": flag the party notified and hand back what to send. No
 * network I/O here — the caller commits this, then calls sendWaitlistReady in
 * its own transaction (same rule as lib/notifications/service.ts).
 */
export async function markWaitlistNotifiedCore(
  tx: Db,
  ctx: Ctx,
  entryId: string,
  venueName: string,
): Promise<{ id: string; name: string; phone: string | null; message: string; whatsappUrl: string | null }> {
  const e = await lockActiveEntry(tx, ctx.tenantId, entryId)
  await tx
    .update(waitlistEntries)
    .set({ status: 'notified', notifiedAt: new Date() })
    .where(and(eq(waitlistEntries.id, e.id), eq(waitlistEntries.tenantId, ctx.tenantId)))
  const message = buildReadyMessage(e.name, venueName)
  return { id: e.id, name: e.name, phone: e.phone, message, whatsappUrl: whatsappUrl(e.phone, message) }
}

export type WaitlistSendOutcome = { status: 'sent' | 'skipped' | 'failed'; skipReason?: string }

/**
 * Phase 2: send the text through the M3 seam and record exactly one
 * `notifications` row. NEVER throws — an SMS hiccup must not undo the host's
 * "notified" flag. With no provider configured (today: AROS-53 not built) this
 * records `skipped / not_configured`; the host falls back to the WhatsApp link.
 */
export async function sendWaitlistReady(
  tx: Db,
  ctx: { tenantId: string },
  p: { phone: string | null; message: string },
): Promise<WaitlistSendOutcome> {
  async function record(status: 'sent' | 'skipped' | 'failed', skipReason?: string, providerMessageId?: string) {
    await tx.insert(notifications).values({
      tenantId: ctx.tenantId,
      customerId: null,
      orderId: null,
      channel: 'sms',
      kind: 'waitlist_ready',
      recipientPhone: p.phone,
      messageBody: p.message,
      status,
      skipReason: skipReason ?? null,
      providerMessageId: providerMessageId ?? null,
    })
    return { status, skipReason } as WaitlistSendOutcome
  }

  try {
    if (!p.phone) return await record('skipped', 'no_phone')
    const provider = getConfiguredProvider()
    if (!provider) return await record('skipped', 'not_configured')
    try {
      const r = await provider.send(p.phone, p.message)
      return await record('sent', undefined, r.providerMessageId)
    } catch (e) {
      console.error('[waitlist] ready send failed:', e instanceof Error ? e.message : e)
      return await record('failed', 'provider_error')
    }
  } catch (e) {
    console.error('[waitlist] could not record notification:', e instanceof Error ? e.message : e)
    return { status: 'failed', skipReason: 'record_error' }
  }
}

export type SeatWaitlistInput = {
  entryId: string
  resourceId: string
  /** Defaults to the party size they queued with. */
  coverCount?: number
  overrideReservation?: boolean
}

/** Seat a queued party: opens the table session and clears them from the queue, atomically. */
export async function seatWaitlistEntryCore(
  tx: Db,
  ctx: Ctx,
  input: SeatWaitlistInput,
): Promise<{ bookingId: string; bookingNumber: string }> {
  const e = await lockActiveEntry(tx, ctx.tenantId, input.entryId)
  const created = await seatTableSessionCore(tx, ctx, {
    branchId: e.branchId,
    resourceId: input.resourceId,
    coverCount: input.coverCount ?? e.partySize,
    customerName: e.name,
    customerPhone: e.phone ?? undefined,
    notes: e.notes ?? undefined,
    overrideReservation: input.overrideReservation,
  })
  await tx
    .update(waitlistEntries)
    .set({ status: 'seated', seatedAt: new Date(), bookingId: created.id })
    .where(and(eq(waitlistEntries.id, e.id), eq(waitlistEntries.tenantId, ctx.tenantId)))
  return { bookingId: created.id, bookingNumber: created.bookingNumber }
}

export type WaitEstimate = {
  minutes: number
  avgTurnMinutes: number
  freeTables: number
  queueAhead: number
}

/**
 * Quote for a party joining now, from real turnover: the mean length of the
 * branch's finished table sessions over the last 30 days (default 60 min until
 * there are enough), and how long each occupied table has already been seated.
 */
export async function estimateNewPartyWait(
  tx: Db,
  tenantId: string,
  branchId: string,
  now: Date = new Date(),
): Promise<WaitEstimate> {
  const tables = await tx
    .select({ id: resources.id })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(
      and(
        eq(resources.tenantId, tenantId),
        eq(resources.branchId, branchId),
        eq(resources.status, 'available'),
        eq(resourceTypes.hourlyRate, '0'),
      ),
    )
    .orderBy(asc(resources.sortOrder))
  const tableIds = tables.map((t) => t.id)

  const since = new Date(now.getTime() - 30 * 24 * 60 * MIN)
  const finished = await tx
    .select({
      minutes: sql<number>`extract(epoch from (${bookings.completedAt} - ${bookings.checkedInAt})) / 60`,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        eq(bookings.branchId, branchId),
        eq(bookings.status, 'completed'),
        isNotNull(bookings.resourceId),
        isNotNull(bookings.checkedInAt),
        isNotNull(bookings.completedAt),
        gte(bookings.completedAt, since),
      ),
    )
  const avg = averageTurnMinutes(finished.map((f) => Number(f.minutes)))

  const open =
    tableIds.length === 0
      ? []
      : await tx
          .select({ checkedInAt: bookings.checkedInAt })
          .from(bookings)
          .where(
            and(
              eq(bookings.tenantId, tenantId),
              inArray(bookings.resourceId, tableIds),
              inArray(bookings.status, ['confirmed', 'checked_in']),
            ),
          )
  const elapsed = open.map((o) => (o.checkedInAt ? Math.max(0, Math.floor((now.getTime() - o.checkedInAt.getTime()) / MIN)) : 0))

  const [{ n: queueAhead }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.tenantId, tenantId),
        eq(waitlistEntries.branchId, branchId),
        inArray(waitlistEntries.status, ['waiting', 'notified']),
      ),
    )

  const freeTables = Math.max(0, tableIds.length - open.length)
  return {
    minutes: estimateWaitMinutes({ avgTurnMinutes: avg, occupiedElapsedMinutes: elapsed, freeTables, queueAhead }),
    avgTurnMinutes: avg,
    freeTables,
    queueAhead,
  }
}
