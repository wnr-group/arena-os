/**
 * Starting a walk-in session (M21 #3) — the non-restaurant sibling of
 * seatTableSessionCore. A walk-in books a normal hourly resource (a PS5
 * station, a snooker table) the moment a customer shows up, rather than for
 * a pre-picked future window: it's born already `checked_in`, its price is
 * unknown until checkout (see lib/billing/elapsed-time.ts's priceElapsedTime,
 * landed in M21 #2), and — unlike a table session — it still gets a real
 * `booking_slots` row, because an hourly resource needs the GiST exclusion
 * constraint (0003) to stay double-booking-proof the same way a reserved
 * booking does (see 0093_walkin_bookings.sql's header for why `ends_at` had
 * to become nullable to allow this for an open tab).
 *
 * ── "only free stations are selectable" vs "conflicts warn-but-allow" ─────
 * These are two different situations, not one:
 *   - A resource with an ACTIVE booking RIGHT NOW is excluded from
 *     listWalkinResources entirely (`isFree: false`) — starting a second
 *     walk-in on it this instant would overlap in time and the exclusion
 *     constraint would reject it outright anyway, so there is nothing to
 *     "allow" there.
 *   - A resource that's free right now but has a booking scheduled LATER
 *     today is still fully selectable (`hasUpcomingBooking: true`) — an open
 *     tab's eventual end isn't known yet, so this can't be resolved either
 *     way up front. The UI warns and lets the operator decide; if they're
 *     wrong and it genuinely overlaps once the times are known, the SAME
 *     exclusion constraint (and lib/actions/bookings.ts's existing 23P01
 *     handling) catches it then — no separate "conflict override" flag is
 *     threaded through the write path, on purpose.
 */
import 'server-only'
import { and, asc, eq, gt, inArray, isNull, lte, ne, or } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { resources, resourceTypes, bookings, bookingSlots, taxRates } from '@/db/schema'
import { BookingError, nextBookingNumber } from './service'
import { resolveBookingCustomer } from './customer'
import { ACTIVE_BOOKING_STATUSES } from './attribution'
import { resolveScopeDefaultTaxPercent } from '@/lib/tax-rates/resolve'
import type { ActiveContext } from '@/lib/tenant/context'
import { withUser } from '@/db'

type Db = NodePgDatabase<typeof schema>

export type WalkinMode = 'open_tab' | 'timed'

/** How far from "now" a walk-in's start may be nudged, either direction. */
export const WALKIN_START_WINDOW_MINUTES = 30
/** Timed session bounds — 30 min to 5 hr, in 30-min steps (design doc). */
export const WALKIN_MIN_DURATION_MINUTES = 30
export const WALKIN_MAX_DURATION_MINUTES = 5 * 60
export const WALKIN_DURATION_STEP_MINUTES = 30

export type WalkinResourceOption = {
  id: string
  name: string
  resourceTypeId: string
  typeName: string
  /** The resource's own rate override, else its type's rate — same
   *  precedence listResources/getPublicResource use. This is what the unit
   *  actually bills at, so it's what the final review step's rate/estimate
   *  should use. */
  hourlyRate: string
  /** The type's own rate, override ignored — what the future-booking wizard's
   *  device card shows (it groups by type, before any specific unit is
   *  assigned), so the walk-in device card uses the same figure rather than
   *  whichever unit happens to be first in the group (which could carry its
   *  own override and show a misleadingly different price). */
  typeHourlyRate: string
  capacity: number | null
  /** No active booking on it right now — see the module doc comment above. */
  isFree: boolean
  /** Free right now, but has a scheduled booking later today (or beyond). */
  hasUpcomingBooking: boolean
}

/**
 * Hourly resources (walk-ins don't apply to zero-rate "table" types — see
 * seatTableSessionCore) for a branch, each flagged for the start form's
 * free-station picker.
 */
export async function listWalkinResources(
  ctx: ActiveContext,
  branchId: string,
  now: Date = new Date(),
): Promise<WalkinResourceOption[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        id: resources.id,
        name: resources.name,
        resourceTypeId: resources.resourceTypeId,
        typeName: resourceTypes.name,
        rateOverride: resources.hourlyRateOverride,
        typeRate: resourceTypes.hourlyRate,
        capacity: resourceTypes.capacity,
      })
      .from(resources)
      .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
      .where(
        and(
          eq(resources.tenantId, ctx.tenant.id),
          eq(resources.branchId, branchId),
          eq(resources.status, 'available'),
          // Same "is this a table" convention as seatTableSessionCore/listTables
          // — a walk-in only ever applies to a paid, timed resource type.
          ne(resourceTypes.hourlyRate, '0'),
        ),
      )
      .orderBy(asc(resources.sortOrder), asc(resources.name))
    if (rows.length === 0) return []

    const ids = rows.map((r) => r.id)
    const occupiedRows = await tx
      .select({ resourceId: bookingSlots.resourceId })
      .from(bookingSlots)
      .innerJoin(bookings, eq(bookings.id, bookingSlots.bookingId))
      .where(
        and(
          inArray(bookingSlots.resourceId, ids),
          eq(bookingSlots.active, true),
          lte(bookingSlots.startsAt, now),
          // An open tab's null ends_at means "still going" — occupied now,
          // same reading the GiST exclusion constraint itself gives it.
          or(isNull(bookingSlots.endsAt), gt(bookingSlots.endsAt, now)),
          inArray(bookings.status, ACTIVE_BOOKING_STATUSES),
        ),
      )
    const occupiedNow = new Set(occupiedRows.map((r) => r.resourceId))

    const upcomingRows = await tx
      .select({ resourceId: bookingSlots.resourceId })
      .from(bookingSlots)
      .innerJoin(bookings, eq(bookings.id, bookingSlots.bookingId))
      .where(
        and(
          inArray(bookingSlots.resourceId, ids),
          eq(bookingSlots.active, true),
          gt(bookingSlots.startsAt, now),
          inArray(bookings.status, ACTIVE_BOOKING_STATUSES),
        ),
      )
    const hasUpcoming = new Set(upcomingRows.map((r) => r.resourceId))

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      resourceTypeId: r.resourceTypeId,
      typeName: r.typeName,
      hourlyRate: r.rateOverride ?? r.typeRate,
      typeHourlyRate: r.typeRate,
      capacity: r.capacity,
      isFree: !occupiedNow.has(r.id),
      hasUpcomingBooking: hasUpcoming.has(r.id),
    }))
  })
}

export type StartWalkinInput = {
  branchId: string
  resourceId: string
  phone: string
  name?: string
  /** ISO instant — validated against `now` ± WALKIN_START_WINDOW_MINUTES. */
  startAt: string
  mode: WalkinMode
  /** Required (and only meaningful) when mode is 'timed'. */
  durationMin?: number
}

/**
 * Transactional core of starting a walk-in: validates the start window and
 * (for a timed session) its duration, resolves the customer and the
 * resource's rate, and inserts the booking (already `checked_in`) + its one
 * booking_slots row. Pricing happens at checkout (priceElapsedTime), not
 * here — `booking_slots.slot_total` and every `bookings` money column start
 * at 0.
 */
export async function startWalkinCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string | null },
  input: StartWalkinInput,
): Promise<{ id: string; bookingNumber: string; confirmationToken: string }> {
  const startAt = new Date(input.startAt)
  if (Number.isNaN(startAt.getTime())) throw new BookingError('Invalid start time.')

  const now = new Date()
  const windowMs = WALKIN_START_WINDOW_MINUTES * 60_000
  if (Math.abs(startAt.getTime() - now.getTime()) > windowMs) {
    throw new BookingError(`Start time must be within ${WALKIN_START_WINDOW_MINUTES} minutes of now.`)
  }

  let committedEndAt: Date | null = null
  let endsAt: Date | null = null
  if (input.mode === 'timed') {
    const duration = input.durationMin
    if (
      duration === undefined ||
      !Number.isInteger(duration) ||
      duration < WALKIN_MIN_DURATION_MINUTES ||
      duration > WALKIN_MAX_DURATION_MINUTES ||
      duration % WALKIN_DURATION_STEP_MINUTES !== 0
    ) {
      throw new BookingError(
        `A timed session must be between ${WALKIN_MIN_DURATION_MINUTES} minutes and ${WALKIN_MAX_DURATION_MINUTES / 60} hours, in ${WALKIN_DURATION_STEP_MINUTES}-minute steps.`,
      )
    }
    committedEndAt = new Date(startAt.getTime() + duration * 60_000)
    endsAt = committedEndAt
  }

  const [resource] = await tx
    .select({
      id: resources.id,
      name: resources.name,
      branchId: resources.branchId,
      status: resources.status,
      typeName: resourceTypes.name,
      typeRate: resourceTypes.hourlyRate,
      rateOverride: resources.hourlyRateOverride,
      taxPercent: taxRates.percent,
    })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .leftJoin(taxRates, eq(taxRates.id, resourceTypes.taxRateId))
    .where(and(eq(resources.tenantId, ctx.tenantId), eq(resources.id, input.resourceId)))
    .limit(1)
  if (!resource) throw new BookingError('Station not found.')
  if (resource.branchId !== input.branchId) throw new BookingError('Station belongs to a different branch.')
  // Same "is this a table" convention as seatTableSessionCore/listTables —
  // see their comments: a walk-in only ever applies to a paid, timed
  // resource type (matches the ne(hourlyRate, '0') filter listWalkinResources
  // already applies, re-checked here in case the resourceId was hand-crafted).
  if (Number(resource.typeRate) === 0) {
    throw new BookingError('This resource isn’t set up as an hourly station.')
  }
  if (resource.status !== 'available') throw new BookingError('This station is not available.')

  const rate = Number(resource.rateOverride ?? resource.typeRate)
  const taxPercent =
    resource.taxPercent ?? (await resolveScopeDefaultTaxPercent(tx, ctx.tenantId, 'resources')) ?? '0'

  const customerId = await resolveBookingCustomer(tx, ctx.tenantId, { phone: input.phone, name: input.name })

  const bookingNumber = await nextBookingNumber(tx, ctx)

  const [booking] = await tx
    .insert(bookings)
    .values({
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      bookingNumber,
      customerName: input.name?.trim() || null,
      customerPhone: input.phone,
      customerId,
      status: 'checked_in',
      source: 'walk_in',
      channel: 'walkin',
      billingMode: input.mode,
      committedEndAt,
      createdBy: ctx.membershipId,
      checkedInAt: now,
    })
    .returning({ id: bookings.id, confirmationToken: bookings.confirmationToken })

  // The GiST exclusion constraint (0003) rejects this atomically (23P01) if
  // the station turns out to genuinely overlap an existing active slot —
  // lib/actions/bookings.ts's fail() already translates that into a friendly
  // message, same as every other booking-creation path.
  await tx.insert(bookingSlots).values({
    tenantId: ctx.tenantId,
    bookingId: booking.id,
    resourceId: resource.id,
    startsAt: startAt,
    endsAt,
    rateApplied: rate.toFixed(2),
    slotTotal: '0.00',
    resourceName: resource.name,
    resourceTypeName: resource.typeName,
    taxRatePercent: Number(taxPercent).toFixed(2),
  })

  return { id: booking.id, bookingNumber, confirmationToken: booking.confirmationToken }
}
