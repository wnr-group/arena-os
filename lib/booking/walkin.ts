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
import { resolveDayRate } from './rate'
import { resolveScopeDefaultTaxPercent } from '@/lib/tax-rates/resolve'
import { loadWeekendDays } from '@/lib/settings/business-profile'
import { billableEndTime, priceElapsedTime } from '@/lib/billing/elapsed-time'
import { loadActiveHappyHourRules } from '@/lib/happy-hours/rules'
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
  /** M22 bugfix: the type's weekend rate — null means no weekend pricing
   *  configured. `hourlyRate`/`typeHourlyRate` above are always the WEEKDAY
   *  rate (a per-station override never applies on a weekend, same as
   *  everywhere else in M22); on a weekend day the caller must use this
   *  instead, for EVERY station of the type, not just override-free ones.
   *  Combine with the tenant's weekend_days (returned alongside this list by
   *  the caller, e.g. lib/actions/bookings.ts's listWalkinResources) and
   *  lib/booking/rate.ts's isWeekendDay/resolveDayRate — the SAME pure
   *  resolver startWalkinCore itself uses — so the estimate the staff form
   *  shows can never drift from what startWalkinCore actually charges. */
  weekendRate: string | null
  capacity: number | null
  /** No active booking on it right now — see the module doc comment above. */
  isFree: boolean
  /** Free right now, but has a scheduled booking later today (or beyond). */
  hasUpcomingBooking: boolean
  /** M21 per-head #4: 'per_resource' (default) or 'per_head' — gates the
   *  start form's Players field. */
  pricingMode: string
  /** Floor on head_count for a per_head station; meaningless otherwise. */
  minPlayers: number
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
        weekendRate: resourceTypes.weekendRate,
        capacity: resourceTypes.capacity,
        pricingMode: resourceTypes.pricingMode,
        minPlayers: resourceTypes.minPlayers,
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
      weekendRate: r.weekendRate,
      capacity: r.capacity,
      isFree: !occupiedNow.has(r.id),
      hasUpcomingBooking: hasUpcoming.has(r.id),
      pricingMode: r.pricingMode,
      minPlayers: r.minPlayers,
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
  /** Null for an open tab still running; the committed end (extensions
   *  included) for a timed walk-in — that one drives the inline countdown. */
  endsAt: Date | null
  billingMode: WalkinMode
  rateApplied: string
  /** Minutes before committedEndAt the heads-up alarm fires — per-booking
   *  (bookings.warning_minutes), not a hardcoded constant. Meaningless for
   *  an open tab, which has no committed end to count down to. */
  warningMinutes: number
  /** '0.00' until checkout prices the session (M21 #4/#5) — the same
   *  "already checked out?" signal checkoutWalkinCore itself uses for a
   *  timed walk-in, reused here so the UI can swap "Close tab"/"Extend" for
   *  a plain "Pay" link once there's nothing left to check out. */
  slotTotal: string
  /** M21 per-head #4: snapshot of the resource type's pricing_mode/the
   *  session's captured player count, plus the type's LIVE min_players —
   *  the checkout/timed dialogs use these to show and edit a Players
   *  control. Null pricing_mode (every pre-#4 walk-in) reads as per_resource. */
  pricingMode: string | null
  headCount: number | null
  minPlayers: number
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
        slotTotal: bookingSlots.slotTotal,
        pricingMode: bookingSlots.pricingMode,
        headCount: bookingSlots.headCount,
        minPlayers: resourceTypes.minPlayers,
        warningMinutes: bookings.warningMinutes,
      })
      .from(bookings)
      .innerJoin(bookingSlots, eq(bookingSlots.bookingId, bookings.id))
      .innerJoin(resources, eq(resources.id, bookingSlots.resourceId))
      .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
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
  /** M21 per-head #4: player count — required (and validated against
   *  min_players) when the resource turns out to be per_head; ignored
   *  otherwise. Captured now so a checkout-time edit (see checkoutWalkinCore)
   *  has something to default from. */
  headCount?: number
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
      typeWeekendRate: resourceTypes.weekendRate,
      rateOverride: resources.hourlyRateOverride,
      taxPercent: taxRates.percent,
      pricingMode: resourceTypes.pricingMode,
      minPlayers: resourceTypes.minPlayers,
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

  const weekdayRate = Number(resource.rateOverride ?? resource.typeRate)
  // A zero EFFECTIVE rate (a per-resource override, not just the type rate
  // already rejected above) would price a timed session to ₹0 — indistinguishable
  // from the `slot_total > 0` "already checked out?" sentinel loadWalkinForCheckout
  // relies on, which would then misfire and lock the booking as uncheckoutable.
  if (weekdayRate <= 0) {
    throw new BookingError('This resource isn’t set up as an hourly station.')
  }
  // M22 #2: resolved by the session's START day and snapshotted onto
  // rate_applied below — checkout/extend read the snapshot back
  // (loadWalkinForCheckout), never re-resolve it, so a walk-in that runs
  // past midnight still bills the day it started on.
  const weekendRate = resource.typeWeekendRate === null ? null : Number(resource.typeWeekendRate)
  const weekendDays = await loadWeekendDays(tx, ctx.tenantId)
  const rate = resolveDayRate(weekdayRate, weekendRate, startAt, ctx.timezone, weekendDays)
  // Re-check the RESOLVED rate, not just weekdayRate above: a type can set
  // weekend_rate to exactly 0 (a free-on-weekends config) independently of
  // a positive weekday rate. That would slip past the weekdayRate guard yet
  // still produce the same zero-rate hazard it exists to prevent — a timed
  // walk-in's checkout ends up with slotTotal = '0.00', indistinguishable
  // from loadWalkinForCheckout's "not yet checked out" sentinel, so it can
  // be checked out again (or skipped from billing) instead of being blocked.
  if (rate <= 0) {
    throw new BookingError('This resource isn’t set up as an hourly station on weekends.')
  }
  const taxPercent =
    resource.taxPercent ?? (await resolveScopeDefaultTaxPercent(tx, ctx.tenantId, 'resources')) ?? '0'

  // M21 per-head #4: captured now (mirrors priceBookingSlots' own
  // validation for a reserved booking) even though a walk-in isn't PRICED
  // until checkout — checkoutWalkinCore defaults to whatever's stored here,
  // and the checkout dialog lets the operator edit it before confirming.
  let headCount: number | null = null
  if (resource.pricingMode === 'per_head') {
    const requested = input.headCount
    if (requested === undefined || !Number.isInteger(requested) || requested < 1) {
      throw new BookingError(`${resource.typeName} is priced per player — enter the number of players.`)
    }
    if (requested < resource.minPlayers) {
      throw new BookingError(
        `${resource.typeName} needs at least ${resource.minPlayers} player${resource.minPlayers === 1 ? '' : 's'}.`,
      )
    }
    headCount = requested
  }

  const resolvedCustomer = await resolveBookingCustomer(tx, ctx.tenantId, { phone: input.phone, name: input.name })

  const bookingNumber = await nextBookingNumber(tx, ctx)

  const [booking] = await tx
    .insert(bookings)
    .values({
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      bookingNumber,
      customerName: input.name?.trim() || resolvedCustomer?.name || null,
      customerPhone: input.phone,
      customerId: resolvedCustomer?.id ?? null,
      status: 'checked_in',
      source: 'walk_in',
      channel: 'walkin',
      billingMode: input.mode,
      committedEndAt,
      createdBy: ctx.membershipId,
      checkedInAt: now,
      headCount,
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
    pricingMode: resource.pricingMode,
    headCount,
  })

  return { id: booking.id, bookingNumber, confirmationToken: booking.confirmationToken }
}

/** How far from "now" an OPEN-TAB walk-in's confirmed checkout end may be
 *  nudged, either direction — same shape as WALKIN_START_WINDOW_MINUTES.
 *  Meaningless for a TIMED walk-in: its checkout is gated on the committed
 *  end instead (see resolveCheckoutWindow). */
export const WALKIN_CHECKOUT_WINDOW_MINUTES = 30

/** Ceiling on a single extend (M21 #5) — "any number of minutes" per the
 *  design doc, bounded only so a mistyped value can't silently commit a
 *  resource for days. */
export const WALKIN_EXTEND_MAX_MINUTES = 24 * 60

export type CheckoutWalkinInput = {
  bookingId: string
  endAt?: string
  /** M21 per-head #4: an edited player count for a per_head walk-in — absent
   *  means "keep whatever was captured at start." Only ever WRITTEN by
   *  checkoutWalkinCore itself, at the moment of checkout; a preview never
   *  persists it, same as endAt. */
  headCount?: number
}
export type ExtendWalkinInput = { bookingId: string; addMinutes: number }

type WalkinForCheckout = {
  bookingId: string
  slotId: string
  startsAt: Date
  rate: number
  billingMode: WalkinMode
  /** Open-tab: null until checkout finalizes it. Timed: the committed end
   *  (mirrors `bookings.committed_end_at`, kept in sync by extendWalkinCore),
   *  set from the moment the walk-in starts. */
  slotEndsAt: Date | null
  /** '0.00' until checkout prices the session — the "already checked out?"
   *  signal for a timed walk-in, whose slotEndsAt is non-null from the start
   *  and so can't serve that role the way it does for an open tab. Safe
   *  because a walk-in resource always has a nonzero rate (listWalkinResources
   *  excludes zero-rate types), so a real session can never price to 0. */
  slotTotal: string
  /** Timed only — null for an open tab. */
  committedEndAt: Date | null
  /** M21 per-head #4: 'per_resource' (every pre-#4 walk-in reads null as
   *  this) or 'per_head' — read straight off the slot, same as headCount. */
  pricingMode: string
  /** The player count captured at start (or last edited at a previous
   *  checkout attempt) — null for a per_resource slot. */
  headCount: number | null
  /** The resource type's CURRENT min_players — re-read live, not frozen,
   *  because unlike rate/tax a walk-in's head_count is meant to stay
   *  editable right up until checkout. Only meaningful when pricingMode is
   *  'per_head'; 1 otherwise. */
  minPlayers: number
}

/**
 * Load + validate the walk-in a checkout or extend acts on. Shared by every
 * read (previewWalkinCheckout — no lock) and write (checkoutWalkinCore,
 * extendWalkinCore — locks both rows, same FOR UPDATE discipline
 * prepareBookingBill uses) so none of them can drift on what counts valid.
 */
async function loadWalkinForCheckout(
  tx: Db,
  ctx: { tenantId: string },
  bookingId: string,
  lock: boolean,
): Promise<WalkinForCheckout> {
  const bookingCols = {
    id: bookings.id,
    status: bookings.status,
    channel: bookings.channel,
    billingMode: bookings.billingMode,
    committedEndAt: bookings.committedEndAt,
  }
  const bookingRows = lock
    ? await tx
        .select(bookingCols)
        .from(bookings)
        .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenantId)))
        .for('update')
        .limit(1)
    : await tx
        .select(bookingCols)
        .from(bookings)
        .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenantId)))
        .limit(1)
  const [booking] = bookingRows
  if (!booking) throw new BookingError('Booking not found.')
  if (booking.channel !== 'walkin') {
    throw new BookingError('This booking is not a walk-in.')
  }
  if (booking.status !== 'checked_in') {
    throw new BookingError(`This walk-in is ${booking.status.replace('_', ' ')} — it can't be checked out.`)
  }

  const slotCols = {
    id: bookingSlots.id,
    resourceId: bookingSlots.resourceId,
    startsAt: bookingSlots.startsAt,
    endsAt: bookingSlots.endsAt,
    rateApplied: bookingSlots.rateApplied,
    slotTotal: bookingSlots.slotTotal,
    pricingMode: bookingSlots.pricingMode,
    headCount: bookingSlots.headCount,
  }
  const slotWhere = and(eq(bookingSlots.bookingId, booking.id), eq(bookingSlots.tenantId, ctx.tenantId), eq(bookingSlots.active, true))
  const slotRows = lock
    ? await tx.select(slotCols).from(bookingSlots).where(slotWhere).for('update').limit(1)
    : await tx.select(slotCols).from(bookingSlots).where(slotWhere).limit(1)
  const [slot] = slotRows
  if (!slot) throw new BookingError('This walk-in has no active session.')

  const pricingMode = slot.pricingMode ?? 'per_resource'
  // The resource type's CURRENT min_players, not a frozen snapshot — see the
  // WalkinForCheckout doc comment above. Unlocked: nothing here is written.
  let minPlayers = 1
  if (pricingMode === 'per_head') {
    const [typeRow] = await tx
      .select({ minPlayers: resourceTypes.minPlayers })
      .from(resources)
      .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
      .where(eq(resources.id, slot.resourceId))
      .limit(1)
    minPlayers = typeRow?.minPlayers ?? 1
  }

  return {
    bookingId: booking.id,
    slotId: slot.id,
    startsAt: slot.startsAt,
    rate: Number(slot.rateApplied),
    billingMode: (booking.billingMode as WalkinMode) ?? 'open_tab',
    slotEndsAt: slot.endsAt,
    slotTotal: slot.slotTotal,
    committedEndAt: booking.committedEndAt,
    pricingMode,
    headCount: slot.headCount,
    minPlayers,
  }
}

/**
 * Resolve + validate the head count a preview/checkout should price at (M21
 * per-head #4) — `requested` (an in-progress edit, not yet persisted) if
 * given, else whatever was captured at start. Always 1 for a per_resource
 * slot: head_count plays no part in its price, so there is nothing to
 * validate. Pure (no DB) — safe after either a locking or a read-only load.
 */
function resolveHeadCount(walkin: WalkinForCheckout, requested: number | undefined): number {
  if (walkin.pricingMode !== 'per_head') return 1
  const headCount = requested ?? walkin.headCount ?? walkin.minPlayers
  if (!Number.isInteger(headCount) || headCount < 1) {
    throw new BookingError('Enter a whole number of players, at least 1.')
  }
  // Only enforce the CURRENT min_players when the operator is setting a NEW
  // count (`requested`). A session already running at its captured count must
  // stay closeable even if an admin raised min_players after it started —
  // otherwise checkout is blocked and the operator can't close the table
  // without over-counting (finding 3, PR #24 per-head review).
  if (requested !== undefined && headCount < walkin.minPlayers) {
    throw new BookingError(
      `This station needs at least ${walkin.minPlayers} player${walkin.minPlayers === 1 ? '' : 's'}.`,
    )
  }
  return headCount
}

/**
 * Validate `endAt` and resolve the [start, end) window checkout actually
 * prices — mode-specific (M21 #5):
 *
 *   - Open tab: `endAt` (defaulting to now) must be within
 *     WALKIN_CHECKOUT_WINDOW_MINUTES of now and after the session started —
 *     it IS the priced window's own end.
 *   - Timed: `endAt` (defaulting to now) must not be past the committed end
 *     (extensions included) — "Extend the session before checking out"
 *     rather than a silent overstay charge. The priced window's end is
 *     always the committed end itself, never `endAt`: a timed session is a
 *     slot the customer bought, so leaving early doesn't discount it and
 *     checking out exactly on time doesn't charge a moment more. Billed
 *     time is therefore always committed + extensions, full stop.
 *
 * Pure (no DB) — safe to call after either a locking or a read-only load.
 */
function resolveCheckoutWindow(walkin: WalkinForCheckout, endAtInput: string | undefined): { endAt: Date; priceEnd: Date } {
  const now = new Date()
  const endAt = endAtInput ? new Date(endAtInput) : now
  if (Number.isNaN(endAt.getTime())) throw new BookingError('Invalid end time.')

  if (walkin.billingMode === 'open_tab') {
    if (walkin.slotEndsAt !== null) throw new BookingError('This session has already been checked out.')
    const windowMs = WALKIN_CHECKOUT_WINDOW_MINUTES * 60_000
    if (Math.abs(endAt.getTime() - now.getTime()) > windowMs) {
      throw new BookingError(`End time must be within ${WALKIN_CHECKOUT_WINDOW_MINUTES} minutes of now.`)
    }
    if (endAt.getTime() <= walkin.startsAt.getTime()) {
      throw new BookingError('End time must be after the session started.')
    }
    return { endAt, priceEnd: endAt }
  }

  // Timed.
  if (Number(walkin.slotTotal) > 0) throw new BookingError('This session has already been checked out.')
  if (!walkin.committedEndAt) throw new BookingError('This walk-in has no committed end time.')
  // Gate on the SERVER's now, not the client-supplied endAt — endAt plays no
  // part in what gets priced here (priceEnd is always committedEndAt), so
  // checking it instead of now would let a crafted endAt (e.g. exactly
  // committedEndAt) walk straight past an actual overstay unbilled.
  if (now.getTime() > walkin.committedEndAt.getTime()) {
    throw new BookingError('Extend the session before checking out.')
  }
  return { endAt, priceEnd: walkin.committedEndAt }
}

/**
 * Read-only preview of what checkoutWalkinCore would charge — for a
 * checkout dialog's live-updating amount. No lock: nothing is written, and
 * the real checkout re-validates and re-prices from scratch regardless, so a
 * stale preview can only ever show a number about to be superseded, never
 * one that gets charged.
 */
export async function previewWalkinCheckout(
  tx: Db,
  ctx: { tenantId: string; timezone: string },
  input: CheckoutWalkinInput,
): Promise<{ total: number; billableEnd: string; headCount: number; minPlayers: number; pricingMode: string }> {
  const walkin = await loadWalkinForCheckout(tx, ctx, input.bookingId, false)
  const { priceEnd } = resolveCheckoutWindow(walkin, input.endAt)
  const headCount = resolveHeadCount(walkin, input.headCount)
  const rules = await loadActiveHappyHourRules(tx, ctx.tenantId)
  const priced = priceElapsedTime(walkin.startsAt, priceEnd, walkin.rate, rules, ctx.timezone, headCount)
  return {
    total: priced.unitPrice,
    billableEnd: billableEndTime(walkin.startsAt, priceEnd).toISOString(),
    headCount,
    minPlayers: walkin.minPlayers,
    pricingMode: walkin.pricingMode,
  }
}

/**
 * Transactional core of closing a walk-in's session (M21 #4 open tab, M21 #5
 * timed): prices it (per-segment happy hour, 15-min round, 30-min minimum —
 * lib/billing/elapsed-time.ts) and writes the total onto the slot.
 *
 * Open tab: `ends_at` is stamped with `priceEnd` — the operator's actual
 * chosen end (defaulting to "now"), NOT the rounded/padded billable end.
 * `priced.unitPrice` already bills the 30-min-minimum/15-min-round-up
 * window internally (priceElapsedTime → billableEndTime), so the padding is
 * fully reflected in `slot_total` without needing `ends_at` to carry it too.
 * Storing the rounded end here instead would stretch the slot's occupancy
 * PAST what the session actually used — a real risk once the padding pushes
 * past a booking scheduled right after (which was legitimately allowed
 * against the walk-in's true, un-padded occupancy when it started). That
 * later insert would satisfy the GiST exclusion constraint right up until
 * this checkout artificially claimed extra time it never actually held,
 * then reject checkout itself with a misleading "That time was just taken"
 * (23P01) while the genuine overlap persists. `priceEnd` keeps the row
 * bounded (freeing the resource from the exclusion constraint's "still
 * going" reading) without ever claiming more time than was truly occupied.
 *
 * Timed: `ends_at` is already the committed end (extendWalkinCore keeps it in
 * sync) and is left untouched here — only `slot_total` is new.
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
  const walkin = await loadWalkinForCheckout(tx, ctx, input.bookingId, true)
  const { priceEnd } = resolveCheckoutWindow(walkin, input.endAt)
  const headCount = resolveHeadCount(walkin, input.headCount)
  const rules = await loadActiveHappyHourRules(tx, ctx.tenantId)
  const priced = priceElapsedTime(walkin.startsAt, priceEnd, walkin.rate, rules, ctx.timezone, headCount)

  // M21 per-head #4: the (possibly just-edited) head count is written here,
  // at the moment checkout actually commits — same "preview travels loose,
  // only checkout persists" discipline endAt already has. A per_resource
  // slot's head_count stays null; nothing to write.
  const headCountUpdate = walkin.pricingMode === 'per_head' ? { headCount } : {}

  if (walkin.billingMode === 'open_tab') {
    await tx
      .update(bookingSlots)
      .set({ endsAt: priceEnd, slotTotal: priced.unitPrice.toFixed(2), ...headCountUpdate })
      .where(eq(bookingSlots.id, walkin.slotId))
  } else {
    await tx
      .update(bookingSlots)
      .set({ slotTotal: priced.unitPrice.toFixed(2), ...headCountUpdate })
      .where(eq(bookingSlots.id, walkin.slotId))
  }
  if (walkin.pricingMode === 'per_head') {
    await tx.update(bookings).set({ headCount }).where(eq(bookings.id, walkin.bookingId))
  }

  return { bookingId: walkin.bookingId, total: priced.unitPrice }
}

/**
 * Push a timed walk-in's committed end forward by `addMinutes` (M21 #5) — an
 * arbitrary number of minutes, not constrained to the 30-min steps the
 * INITIAL duration picker uses, since an extend is a real-time "keep it a
 * bit longer" decision, not a fresh booking. Re-arms the countdown; no money
 * changes hands here — the extra time only ever gets priced at checkout,
 * same as the rest of the committed window.
 *
 * `bookings.committed_end_at` and `booking_slots.ends_at` move together in
 * the same statement-pair so they can never drift: the slot's own bound is
 * what the GiST exclusion constraint (0003) re-validates, so an extend that
 * would now overlap something else booked on this resource right after the
 * OLD committed end is rejected here (23P01) exactly like any other
 * conflicting write, not silently allowed.
 */
export async function extendWalkinCore(
  tx: Db,
  ctx: { tenantId: string },
  input: ExtendWalkinInput,
): Promise<{ bookingId: string; committedEndAt: string }> {
  if (!Number.isInteger(input.addMinutes) || input.addMinutes <= 0 || input.addMinutes > WALKIN_EXTEND_MAX_MINUTES) {
    throw new BookingError(`Enter a whole number of minutes between 1 and ${WALKIN_EXTEND_MAX_MINUTES}.`)
  }

  const walkin = await loadWalkinForCheckout(tx, ctx, input.bookingId, true)
  if (walkin.billingMode !== 'timed') {
    throw new BookingError('Only a timed walk-in can be extended.')
  }
  if (Number(walkin.slotTotal) > 0) {
    throw new BookingError('This session has already been checked out — nothing left to extend.')
  }
  if (!walkin.committedEndAt) throw new BookingError('This walk-in has no committed end time.')

  const newEnd = new Date(walkin.committedEndAt.getTime() + input.addMinutes * 60_000)

  await tx
    .update(bookings)
    .set({ committedEndAt: newEnd })
    .where(and(eq(bookings.id, walkin.bookingId), eq(bookings.tenantId, ctx.tenantId)))
  await tx.update(bookingSlots).set({ endsAt: newEnd }).where(eq(bookingSlots.id, walkin.slotId))

  return { bookingId: walkin.bookingId, committedEndAt: newEnd.toISOString() }
}
