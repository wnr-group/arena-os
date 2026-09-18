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
import { resources, resourceTypes, bookings, bookingSlots, taxRates, happyHours } from '@/db/schema'
import { BookingError, nextBookingNumber } from './service'
import { resolveBookingCustomer } from './customer'
import { ACTIVE_BOOKING_STATUSES } from './attribution'
import { resolveScopeDefaultTaxPercent } from '@/lib/tax-rates/resolve'
import { billableEndTime, priceElapsedTime } from '@/lib/billing/elapsed-time'
import type { HappyHourRule } from '@/lib/happy-hours/apply'
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

export type ActiveWalkin = {
  bookingId: string
  bookingNumber: string
  customerName: string | null
  customerPhone: string | null
  resourceId: string
  resourceName: string
  resourceTypeName: string
  startsAt: Date
  /** Null for an open tab (M21 #4 finalizes it at checkout); the committed
   *  end already known for a timed walk-in — that one bills normally
   *  through the existing /pos flow, no checkout step needed. */
  endsAt: Date | null
  billingMode: WalkinMode
  rateApplied: string
}

/**
 * Every currently-checked-in walk-in on this branch (M21 #4) — the "what's
 * live right now" list a checkout dialog is launched from. Nothing before
 * this ticket ever surfaced an open tab after it started: listDayBookings
 * (the Bookings page's own data) explicitly filters to `ends_at is not null`,
 * so an open tab — the exact booking this feature exists to close — was
 * otherwise invisible anywhere in the app once started.
 */
export async function listActiveWalkins(ctx: ActiveContext, branchId: string): Promise<ActiveWalkin[]> {
  const rows = await withUser(ctx.user.id, (tx) =>
    tx
      .select({
        bookingId: bookings.id,
        bookingNumber: bookings.bookingNumber,
        customerName: bookings.customerName,
        customerPhone: bookings.customerPhone,
        billingMode: bookings.billingMode,
        resourceId: bookingSlots.resourceId,
        resourceName: bookingSlots.resourceName,
        resourceTypeName: bookingSlots.resourceTypeName,
        startsAt: bookingSlots.startsAt,
        endsAt: bookingSlots.endsAt,
        rateApplied: bookingSlots.rateApplied,
      })
      .from(bookings)
      .innerJoin(bookingSlots, eq(bookingSlots.bookingId, bookings.id))
      .where(
        and(
          eq(bookings.tenantId, ctx.tenant.id),
          eq(bookings.branchId, branchId),
          eq(bookings.channel, 'walkin'),
          eq(bookings.status, 'checked_in'),
          eq(bookingSlots.active, true),
        ),
      )
      .orderBy(asc(bookingSlots.startsAt)),
  )
  return rows.map((r) => ({ ...r, billingMode: (r.billingMode as WalkinMode) ?? 'open_tab' }))
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

/** How far from "now" a walk-in's confirmed checkout end may be nudged,
 *  either direction — same shape as WALKIN_START_WINDOW_MINUTES, kept as its
 *  own constant since start and checkout windows are conceptually separate
 *  knobs even though they share a value today. */
export const WALKIN_CHECKOUT_WINDOW_MINUTES = 30

export type CheckoutWalkinInput = { bookingId: string; endAt?: string }

type OpenTabForCheckout = { bookingId: string; slotId: string; startsAt: Date; rate: number }

/**
 * Validate `bookingId` is an open tab still awaiting checkout, and resolve +
 * bounds-check the requested end time. Shared by previewWalkinCheckout (no
 * lock — nothing is written) and checkoutWalkinCore (locks both rows, same
 * discipline prepareBookingBill's own FOR UPDATE uses) so the two can never
 * drift on what counts as valid.
 */
async function loadOpenTabForCheckout(
  tx: Db,
  ctx: { tenantId: string },
  bookingId: string,
  endAtInput: string | undefined,
  lock: boolean,
): Promise<{ open: OpenTabForCheckout; endAt: Date }> {
  const bookingRows = lock
    ? await tx
        .select({ id: bookings.id, status: bookings.status, channel: bookings.channel, billingMode: bookings.billingMode })
        .from(bookings)
        .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenantId)))
        .for('update')
        .limit(1)
    : await tx
        .select({ id: bookings.id, status: bookings.status, channel: bookings.channel, billingMode: bookings.billingMode })
        .from(bookings)
        .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenantId)))
        .limit(1)
  const [booking] = bookingRows
  if (!booking) throw new BookingError('Booking not found.')
  if (booking.channel !== 'walkin' || booking.billingMode !== 'open_tab') {
    throw new BookingError('This booking is not an open-tab walk-in.')
  }
  if (booking.status !== 'checked_in') {
    throw new BookingError(`This walk-in is ${booking.status.replace('_', ' ')} — it can't be checked out.`)
  }

  const slotRows = lock
    ? await tx
        .select({ id: bookingSlots.id, startsAt: bookingSlots.startsAt, endsAt: bookingSlots.endsAt, rateApplied: bookingSlots.rateApplied })
        .from(bookingSlots)
        .where(and(eq(bookingSlots.bookingId, booking.id), eq(bookingSlots.tenantId, ctx.tenantId), eq(bookingSlots.active, true)))
        .for('update')
        .limit(1)
    : await tx
        .select({ id: bookingSlots.id, startsAt: bookingSlots.startsAt, endsAt: bookingSlots.endsAt, rateApplied: bookingSlots.rateApplied })
        .from(bookingSlots)
        .where(and(eq(bookingSlots.bookingId, booking.id), eq(bookingSlots.tenantId, ctx.tenantId), eq(bookingSlots.active, true)))
        .limit(1)
  const [slot] = slotRows
  if (!slot) throw new BookingError('This walk-in has no active session to check out.')
  if (slot.endsAt !== null) throw new BookingError('This session has already been checked out.')

  const now = new Date()
  const endAt = endAtInput ? new Date(endAtInput) : now
  if (Number.isNaN(endAt.getTime())) throw new BookingError('Invalid end time.')
  const windowMs = WALKIN_CHECKOUT_WINDOW_MINUTES * 60_000
  if (Math.abs(endAt.getTime() - now.getTime()) > windowMs) {
    throw new BookingError(`End time must be within ${WALKIN_CHECKOUT_WINDOW_MINUTES} minutes of now.`)
  }
  if (endAt.getTime() <= slot.startsAt.getTime()) {
    throw new BookingError('End time must be after the session started.')
  }

  const open: OpenTabForCheckout = {
    bookingId: booking.id,
    slotId: slot.id,
    startsAt: slot.startsAt,
    rate: Number(slot.rateApplied),
  }
  return { open, endAt }
}

/** Tenant's active happy-hour rules, in the shape priceElapsedTime expects —
 *  same select shape lib/orders/service.ts's food pricing already uses. */
async function loadActiveHappyHourRules(tx: Db, tenantId: string): Promise<HappyHourRule[]> {
  return tx
    .select({
      id: happyHours.id,
      name: happyHours.name,
      daysOfWeek: happyHours.daysOfWeek,
      startTime: happyHours.startTime,
      endTime: happyHours.endTime,
      discountType: happyHours.discountType,
      discountValue: happyHours.discountValue,
      isActive: happyHours.isActive,
    })
    .from(happyHours)
    .where(and(eq(happyHours.tenantId, tenantId), eq(happyHours.isActive, true)))
}

/**
 * Read-only preview of what checkoutWalkinCore would charge for `endAt` —
 * for a checkout dialog's live-updating amount as the operator nudges the
 * end time. No lock: nothing is written, and the real checkout re-validates
 * and re-prices from scratch regardless, so a stale preview can only ever
 * show a number that's about to be superseded, never one that gets charged.
 */
export async function previewWalkinCheckout(
  tx: Db,
  ctx: { tenantId: string; timezone: string },
  input: CheckoutWalkinInput,
): Promise<{ total: number; billableEnd: string }> {
  const { open, endAt } = await loadOpenTabForCheckout(tx, ctx, input.bookingId, input.endAt, false)
  const rules = await loadActiveHappyHourRules(tx, ctx.tenantId)
  const priced = priceElapsedTime(open.startsAt, endAt, open.rate, rules, ctx.timezone)
  return { total: priced.unitPrice, billableEnd: billableEndTime(open.startsAt, endAt).toISOString() }
}

/**
 * Transactional core of closing an open-tab walk-in (M21 #4): confirms the
 * end time, prices the elapsed session (per-segment happy hour, 15-min
 * round, 30-min minimum — lib/billing/elapsed-time.ts), and writes it onto
 * the slot. `ends_at` is stamped with the BILLABLE end (rounded), not the
 * operator's raw input, so the slot's own duration always matches what was
 * priced — and so the row finally satisfies "bounded", freeing the resource
 * from the GiST exclusion constraint's "still going" reading the moment this
 * commits.
 *
 * Deliberately does NOT flip `bookings.status` to 'completed' — that still
 * goes through the existing setBookingStatus, gated on assertBookingFullyPaid,
 * once the invoice this feeds (see lib/actions/bookings.ts's checkoutWalkin)
 * is actually paid off.
 */
export async function checkoutWalkinCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string },
  input: CheckoutWalkinInput,
): Promise<{ bookingId: string; total: number }> {
  const { open, endAt } = await loadOpenTabForCheckout(tx, ctx, input.bookingId, input.endAt, true)
  const rules = await loadActiveHappyHourRules(tx, ctx.tenantId)
  const priced = priceElapsedTime(open.startsAt, endAt, open.rate, rules, ctx.timezone)
  const billableEnd = billableEndTime(open.startsAt, endAt)

  await tx
    .update(bookingSlots)
    .set({ endsAt: billableEnd, slotTotal: priced.unitPrice.toFixed(2) })
    .where(eq(bookingSlots.id, open.slotId))

  return { bookingId: open.bookingId, total: priced.unitPrice }
}
