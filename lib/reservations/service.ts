/**
 * Table reservations — the transactional core (M20 / AROS-176), shared by the
 * staff actions (withUser) and the public storefront (withPublicTenant).
 *
 * A reservation is an ordinary timed booking on a table resource (see 0150):
 * `booking_slots` carries the time window so the exclusion constraint blocks
 * double-booking, createBookingCore applies the M37 advance window, and
 * `bookings.resource_id` stays NULL until the party arrives. Seating converts
 * that same booking into the table session — it never creates a second one.
 */
import 'server-only'
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, bookingSlots, bookings, resourceTypes, resources, workingHours } from '@/db/schema'
import { BookingError, createBookingCore, type CreatedBooking } from '@/lib/booking/service'
import { dayWindow, type DayHours } from '@/lib/booking/availability'
import { todayInZone, weekdayInZone } from '@/lib/booking/time'
import { getReservationSettingsCore } from './settings'
import { assertNoUpcomingReservation } from './guard'
import {
  RESERVATION_LIMITS,
  RESERVATION_SLOT_MINUTES,
  STAFF_MAX_PARTY_SIZE,
  reservationEnd,
  type ReservationSettings,
} from './rules'

type Db = NodePgDatabase<typeof schema>

type Ctx = { tenantId: string; timezone: string; membershipId: string | null }

// Same fallback the rest of the booking code uses for a day with no row.
const DEFAULT_HOURS: DayHours = { openTime: '10:00', closeTime: '22:00', isClosed: false, open24h: false }

const MIN = 60_000
/** Staff may enter a reservation that started a moment ago (a phoned-in "we're
 *  on our way"); the public site may not. */
const STAFF_PAST_GRACE_MINUTES = 5

export type CreateReservationInput = {
  branchId: string
  resourceId: string
  /** ISO instant the party is expected. */
  startsAt: string
  /** Defaults to the venue's reservation length. */
  durationMinutes?: number
  partySize: number
  customerName?: string
  customerPhone?: string
  customerEmail?: string
  notes?: string
}

/** Load the settings and refuse unless reservations are on (and, for the
 *  storefront, open to the public). */
async function requireEnabled(tx: Db, tenantId: string, audience: 'staff' | 'public'): Promise<ReservationSettings> {
  const settings = await getReservationSettingsCore(tx, tenantId)
  if (!settings.enabled) throw new BookingError('Table reservations are not enabled for this business.')
  if (audience === 'public' && !settings.publicEnabled) {
    throw new BookingError('Online table reservations are not available right now.')
  }
  return settings
}

/** The 0071 table convention seatTableSessionCore uses: a resource whose type
 *  carries no hourly rate. */
async function loadTable(tx: Db, tenantId: string, resourceId: string) {
  const [t] = await tx
    .select({
      id: resources.id,
      name: resources.name,
      branchId: resources.branchId,
      status: resources.status,
      hourlyRate: resourceTypes.hourlyRate,
    })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(and(eq(resources.tenantId, tenantId), eq(resources.id, resourceId)))
    .limit(1)
  if (!t) throw new BookingError('Table not found.')
  if (Number(t.hourlyRate) !== 0) {
    throw new BookingError('This resource isn’t set up as a table — use a resource type with no hourly rate.')
  }
  if (t.status !== 'available') throw new BookingError('This table is not available.')
  return t
}

async function loadDayHours(tx: Db, tenantId: string, branchId: string, dateStr: string, timeZone: string): Promise<DayHours> {
  const [row] = await tx
    .select({
      openTime: workingHours.openTime,
      closeTime: workingHours.closeTime,
      isClosed: workingHours.isClosed,
      open24h: workingHours.open24h,
    })
    .from(workingHours)
    .where(
      and(
        eq(workingHours.tenantId, tenantId),
        eq(workingHours.branchId, branchId),
        eq(workingHours.dayOfWeek, weekdayInZone(dateStr, timeZone)),
      ),
    )
    .limit(1)
  return row ?? DEFAULT_HOURS
}

/**
 * Create a table reservation. Double-booking is rejected by the database
 * (booking_slots_no_overlap, 23P01), not by a check-then-insert race here.
 */
export async function createReservationCore(
  tx: Db,
  ctx: Ctx,
  input: CreateReservationInput,
  audience: 'staff' | 'public',
): Promise<CreatedBooking> {
  const settings = await requireEnabled(tx, ctx.tenantId, audience)

  const maxParty = audience === 'public' ? settings.maxPartySize : STAFF_MAX_PARTY_SIZE
  if (!Number.isInteger(input.partySize) || input.partySize < 1) {
    throw new BookingError('Party size must be a whole number of at least 1.')
  }
  if (input.partySize > maxParty) {
    throw new BookingError(
      audience === 'public'
        ? `For parties larger than ${settings.maxPartySize}, please call us to reserve.`
        : `Party size can’t exceed ${STAFF_MAX_PARTY_SIZE}.`,
    )
  }

  const minutes = input.durationMinutes ?? settings.defaultDurationMinutes
  const { min, max } = RESERVATION_LIMITS.defaultDurationMinutes
  if (!Number.isInteger(minutes) || minutes < min || minutes > max) {
    throw new BookingError(`A reservation must last between ${min} and ${max} minutes.`)
  }
  if (audience === 'public' && input.durationMinutes !== undefined && input.durationMinutes !== settings.defaultDurationMinutes) {
    // The storefront never chooses its own length — never trust it.
    throw new BookingError('Invalid reservation length.')
  }

  const name = input.customerName?.trim()
  if (!name) throw new BookingError('Enter the guest’s name.')
  if (audience === 'public' && !input.customerPhone?.trim()) throw new BookingError('Enter a phone number.')

  const start = new Date(input.startsAt)
  if (Number.isNaN(start.getTime())) throw new BookingError('Pick a valid time.')
  const pastGraceMs = (audience === 'staff' ? STAFF_PAST_GRACE_MINUTES : 0) * MIN
  if (start.getTime() < Date.now() - pastGraceMs) throw new BookingError('That time has already passed.')

  const table = await loadTable(tx, ctx.tenantId, input.resourceId)
  if (table.branchId !== input.branchId) throw new BookingError('Table belongs to a different branch.')

  // Within opening hours: must START while the venue is open. A party may
  // still be eating at close, so the end is not held to it.
  const dateStr = todayInZone(ctx.timezone, start)
  const hours = await loadDayHours(tx, ctx.tenantId, input.branchId, dateStr, ctx.timezone)
  if (hours.isClosed) throw new BookingError('We’re closed that day.')
  const { open, close } = dayWindow(dateStr, ctx.timezone, hours)
  if (start < open || start >= close) throw new BookingError('That time is outside our opening hours.')

  const created = await createBookingCore(tx, ctx, {
    branchId: input.branchId,
    customerName: name,
    customerPhone: input.customerPhone?.trim() || undefined,
    customerEmail: input.customerEmail?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    source: audience === 'public' ? 'online' : 'staff',
    discount: 0,
    deposit: 0,
    slots: [{ resourceId: input.resourceId, startsAt: start.toISOString(), endsAt: reservationEnd(start, minutes).toISOString() }],
    reservation: { coverCount: input.partySize, minutes },
  })

  // The public path has no membership (and no audit_log write access); staff
  // reservations are audited like the other table-session mutations.
  if (ctx.membershipId) {
    await tx.insert(auditLog).values({
      tenantId: ctx.tenantId,
      actorMembershipId: ctx.membershipId,
      action: 'reservation.created',
      entityType: 'booking',
      entityId: created.id,
      before: {},
      after: { tableId: input.resourceId, startsAt: start.toISOString(), minutes, partySize: input.partySize },
    })
  }
  return created
}

export type SeatReservationInput = {
  bookingId: string
  /** Seat at a different table than reserved (the reserved one is still taken). */
  resourceId?: string
  /** The party turned up with a different number of guests. */
  coverCount?: number
  /** Seat at a different table even though another reservation is imminent there. */
  overrideReservation?: boolean
}

/**
 * Convert a reservation into an open table session — the SAME booking: it gains
 * `resource_id`, becomes `checked_in`, and drops its reservation slot so the
 * seated table has exactly the shape seatTableSessionCore produces (the
 * exclusion constraint never sees a seated table). The original window survives
 * on bookings.reserved_for/reserved_minutes and in the audit entry.
 *
 * Accepts a `no_show` reservation too — a late arrival after the grace lapsed.
 * A table still occupied by another party is rejected by
 * idx_bookings_open_table_session (23P01/23505 mapped by the action layer),
 * rolling the slot delete back with it.
 */
export async function seatReservationCore(
  tx: Db,
  ctx: Ctx,
  input: SeatReservationInput,
): Promise<{ bookingId: string; resourceId: string; coverCount: number; tableName: string }> {
  await requireEnabled(tx, ctx.tenantId, 'staff')

  // Row lock (bookings_rw carries an UPDATE policy, so FOR UPDATE matches).
  const [b] = await tx
    .select({
      id: bookings.id,
      status: bookings.status,
      branchId: bookings.branchId,
      coverCount: bookings.coverCount,
      resourceId: bookings.resourceId,
      reservedFor: bookings.reservedFor,
    })
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.tenantId, ctx.tenantId)))
    .for('update')
    .limit(1)
  if (!b || !b.reservedFor) throw new BookingError('Reservation not found.')
  if (b.resourceId) throw new BookingError('This party is already seated.')
  if (b.status !== 'confirmed' && b.status !== 'no_show') {
    throw new BookingError(`This reservation is ${b.status.replace('_', ' ')} and can’t be seated.`)
  }

  const [slot] = await tx
    .select({ id: bookingSlots.id, resourceId: bookingSlots.resourceId, startsAt: bookingSlots.startsAt, endsAt: bookingSlots.endsAt })
    .from(bookingSlots)
    .where(and(eq(bookingSlots.bookingId, b.id), eq(bookingSlots.tenantId, ctx.tenantId)))
    .limit(1)
  if (!slot) throw new BookingError('This reservation has no table assigned.')

  const targetId = input.resourceId ?? slot.resourceId
  const table = await loadTable(tx, ctx.tenantId, targetId)
  if (table.branchId !== b.branchId) throw new BookingError('Table belongs to a different branch.')
  // A different table may itself be reserved for someone else shortly.
  if (targetId !== slot.resourceId && !input.overrideReservation) {
    await assertNoUpcomingReservation(tx, ctx, targetId)
  }

  const covers = input.coverCount ?? b.coverCount
  if (!covers || !Number.isInteger(covers) || covers < 1) {
    throw new BookingError('Guest count must be at least 1.')
  }

  const now = new Date()
  await tx.delete(bookingSlots).where(and(eq(bookingSlots.bookingId, b.id), eq(bookingSlots.tenantId, ctx.tenantId)))
  await tx
    .update(bookings)
    .set({
      status: 'checked_in',
      resourceId: targetId,
      coverCount: covers,
      checkedInAt: now,
      // A late arrival revives a lapsed no-show; nothing was cancelled.
      cancelledAt: null,
    })
    .where(and(eq(bookings.id, b.id), eq(bookings.tenantId, ctx.tenantId)))

  await tx.insert(auditLog).values({
    tenantId: ctx.tenantId,
    actorMembershipId: ctx.membershipId,
    action: 'reservation.seated',
    entityType: 'booking',
    entityId: b.id,
    before: {
      status: b.status,
      tableId: slot.resourceId,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt ? slot.endsAt.toISOString() : null,
      partySize: b.coverCount,
    },
    after: { status: 'checked_in', tableId: targetId, partySize: covers, lateByMinutes: Math.max(0, Math.round((now.getTime() - b.reservedFor.getTime()) / MIN)) },
  })

  return { bookingId: b.id, resourceId: targetId, coverCount: covers, tableName: table.name }
}

/**
 * Lapse confirmed, unseated reservations whose no-show grace has passed.
 * `confirmed → no_show` fires the 0003 trigger that deactivates the slot, which
 * releases the table for rebooking. Idempotent and safe to run from a page
 * load, an action, or a scheduler. Tenants that never enabled reservations have
 * no reserved_for rows, so this is a no-op for them.
 */
export async function lapseNoShowReservationsCore(
  tx: Db,
  tenantId: string,
  now: Date = new Date(),
): Promise<{ lapsed: number }> {
  const res = await tx.execute<{ id: string }>(sql`
    update bookings b
       set status = 'no_show'
     where b.tenant_id = ${tenantId}
       and b.status = 'confirmed'
       and b.reserved_for is not null
       and b.resource_id is null
       and b.reserved_for + make_interval(
             mins => coalesce(
               (select rs.no_show_grace_minutes from reservation_settings rs where rs.tenant_id = b.tenant_id),
               15
             )
           ) < ${now.toISOString()}::timestamptz
    returning b.id
  `)
  const ids = res.rows.map((r) => r.id)
  if (ids.length > 0) {
    await tx.insert(auditLog).values(
      ids.map((id) => ({
        tenantId,
        actorMembershipId: null,
        action: 'reservation.no_show_lapsed',
        entityType: 'booking',
        entityId: id,
        before: { status: 'confirmed' },
        after: { status: 'no_show' },
      })),
    )
  }
  return { lapsed: ids.length }
}

export type FreeTable = { id: string; name: string }

/**
 * Tables with no active reservation overlapping [start, end), best-first
 * (floor order). A table occupied right now is skipped for a start in the next
 * half hour — it can't plausibly be vacated for it. The DB exclusion
 * constraint remains the real guard; this only picks candidates.
 */
export async function freeTablesForWindow(
  tx: Db,
  tenantId: string,
  branchId: string,
  start: Date,
  end: Date,
  now: Date = new Date(),
): Promise<FreeTable[]> {
  const tables = await tx
    .select({ id: resources.id, name: resources.name })
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
    .orderBy(asc(resources.sortOrder), asc(resources.name))
  if (tables.length === 0) return []
  const ids = tables.map((t) => t.id)

  const taken = await tx
    .select({ resourceId: bookingSlots.resourceId })
    .from(bookingSlots)
    .where(
      and(
        eq(bookingSlots.tenantId, tenantId),
        inArray(bookingSlots.resourceId, ids),
        eq(bookingSlots.active, true),
        lt(bookingSlots.startsAt, end),
        gt(bookingSlots.endsAt, start),
      ),
    )
  const blocked = new Set(taken.map((r) => r.resourceId))

  if (start.getTime() < now.getTime() + 30 * MIN) {
    const occupied = await tx
      .select({ resourceId: bookings.resourceId })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, tenantId),
          inArray(bookings.resourceId, ids),
          inArray(bookings.status, ['confirmed', 'checked_in']),
        ),
      )
    for (const o of occupied) if (o.resourceId) blocked.add(o.resourceId)
  }
  return tables.filter((t) => !blocked.has(t.id))
}

export type StartOption = { startsAt: string; label: string; freeTables: number }

/**
 * Start times (every 30 min, in the venue's zone) at which at least one table
 * is free for a reservation of the venue's length. One batched read of the
 * day's slots, not a query per candidate.
 */
export async function getReservationStartOptionsCore(
  tx: Db,
  tenant: { id: string; timezone: string },
  input: { branchId: string; date: string },
  audience: 'staff' | 'public',
  now: Date = new Date(),
): Promise<{ durationMinutes: number; options: StartOption[] }> {
  const settings = await requireEnabled(tx, tenant.id, audience)
  const durationMinutes = settings.defaultDurationMinutes

  const hours = await loadDayHours(tx, tenant.id, input.branchId, input.date, tenant.timezone)
  if (hours.isClosed) return { durationMinutes, options: [] }
  const { open, close } = dayWindow(input.date, tenant.timezone, hours)

  const tables = await tx
    .select({ id: resources.id })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(
      and(
        eq(resources.tenantId, tenant.id),
        eq(resources.branchId, input.branchId),
        eq(resources.status, 'available'),
        eq(resourceTypes.hourlyRate, '0'),
      ),
    )
  if (tables.length === 0) return { durationMinutes, options: [] }
  const ids = tables.map((t) => t.id)

  const windowEnd = new Date(close.getTime() + durationMinutes * MIN)
  const slots = await tx
    .select({ resourceId: bookingSlots.resourceId, startsAt: bookingSlots.startsAt, endsAt: bookingSlots.endsAt })
    .from(bookingSlots)
    .where(
      and(
        eq(bookingSlots.tenantId, tenant.id),
        inArray(bookingSlots.resourceId, ids),
        eq(bookingSlots.active, true),
        lt(bookingSlots.startsAt, windowEnd),
        gt(bookingSlots.endsAt, open),
      ),
    )

  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tenant.timezone, hour: '2-digit', minute: '2-digit', hour12: false })
  const options: StartOption[] = []
  for (let t = open.getTime(); t < close.getTime(); t += RESERVATION_SLOT_MINUTES * MIN) {
    const start = new Date(t)
    if (start.getTime() < now.getTime()) continue
    const end = reservationEnd(start, durationMinutes)
    let free = 0
    for (const id of ids) {
      const clash = slots.some(
        (s) => s.resourceId === id && s.endsAt !== null && s.startsAt < end && s.endsAt > start,
      )
      if (!clash) free++
    }
    if (free > 0) options.push({ startsAt: start.toISOString(), label: fmt.format(start), freeTables: free })
  }
  return { durationMinutes, options }
}
