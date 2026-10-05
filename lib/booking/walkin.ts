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
 *     today is still selectable for a TIMED session (`hasUpcomingBooking:
 *     true`) — a timed session's end is known up front and might genuinely
 *     fit before that later booking, so this can't be resolved either way
 *     until the duration is picked. The UI warns and lets the operator
 *     decide; if they're wrong and it genuinely overlaps once the times are
 *     known, the SAME exclusion constraint (and lib/actions/bookings.ts's
 *     existing 23P01 handling) catches it then — no separate "conflict
 *     override" flag is threaded through the write path, on purpose.
 *   - An OPEN TAB has no such ambiguity: its ends_at is null until checkout,
 *     so it overlaps ANY future active booking on the resource regardless of
 *     duration. startWalkinCore rejects that combination itself, up front —
 *     there's nothing for the exclusion constraint to usefully decide there.
 */
import 'server-only'
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { resources, resourceTypes, resourceSetups, holidayRates, bookings, bookingSlots, taxRates, auditLog, tenants } from '@/db/schema'
import { industryHasStudioSetups } from './studio-setups'
import { advancePaidTotals } from './advance-ledger'
import { BookingError, nextBookingNumber, validateAdvanceTenders, recordAdvanceTenders, type AdvanceTenderInput } from './service'
import { paise } from '@/lib/billing/payments'
import { round2 } from '@/lib/billing/pricing'
import { resolveBookingCustomer } from './customer'
import { ACTIVE_BOOKING_STATUSES } from './attribution'
import { resolveDayRate } from './rate'
import { todayInZone } from './time'
import { resolveScopeDefaultTaxPercent } from '@/lib/tax-rates/resolve'
import { loadWeekendDays } from '@/lib/settings/business-profile'
import { billableEndTime, priceElapsedTime } from '@/lib/billing/elapsed-time'
import { loadActiveHappyHourRules } from '@/lib/happy-hours/rules'
import { findLiveBilling } from '@/lib/billing/invoice'
import type { ActiveContext } from '@/lib/tenant/context'
import { withUser } from '@/db'

type Db = NodePgDatabase<typeof schema>

/** Same shape as lib/booking/service.ts's own private writeAudit — no shared
 *  audit module exists; each domain keeps its own (see that file's comment). */
type AuditActor = { tenantId: string; membershipId: string | null }
async function writeAudit(
  tx: Db,
  actor: AuditActor,
  entry: { action: string; entityType: string; entityId: string; before: Record<string, unknown>; after: Record<string, unknown> },
): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: actor.tenantId,
    actorMembershipId: actor.membershipId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before,
    after: entry.after,
  })
}

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
  /** The type's own photo, or null — what the walk-in device-type card and
   *  its per-device rows show in place of a generic icon (M23 follow-up).
   *  Always the TYPE's image, never a per-unit override: every device of a
   *  type is the same physical thing (a PS5 station, a snooker table), so
   *  one photo per type is enough, same as the future-booking wizard's
   *  device-type step would if it showed photos. */
  typeImageUrl: string | null
  /** No active booking on it right now — see the module doc comment above. */
  isFree: boolean
  /** Free right now, but has a scheduled booking later today (or beyond).
   *  Derived from `nextBooking` below — kept as its own field because it
   *  predates it and the confirm-before-picking prompt only needs the
   *  boolean. */
  hasUpcomingBooking: boolean
  /** The resource's own next active (confirmed/checked_in) booking, if any —
   *  what the "check availability" calendar (M23) uses to compute how long a
   *  walk-in could run before it, and what pickResource's confirm prompt
   *  names. Null exactly when hasUpcomingBooking is false. */
  nextBooking: {
    startsAt: string
    endsAt: string | null
    bookingNumber: string
    customerName: string | null
  } | null
  /** M21 per-head #4: 'per_resource' (default) or 'per_head' — gates the
   *  start form's Players field. */
  pricingMode: string
  /** Floor on head_count for a per_head station; meaningless otherwise. */
  minPlayers: number
  /** M24 #7: this station's ACTIVE per-hour setups (a per-day setup can't
   *  start "now" as an open tab, so it's never offered here). Always empty
   *  outside the studio industries (lib/booking/studio-setups.ts). */
  setups: { id: string; name: string; rate: string }[]
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
        typeImageUrl: resourceTypes.imageUrl,
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

    // M24 #7: studio industries only — every other industry can never have a
    // setup, so skip the query rather than fetch rows no resource could have.
    const setupsByResource = new Map<string, { id: string; name: string; rate: string }[]>()
    if (industryHasStudioSetups(ctx.tenant.industry)) {
      const setupRows = await tx
        .select({ id: resourceSetups.id, resourceId: resourceSetups.resourceId, name: resourceSetups.name, rate: resourceSetups.rate })
        .from(resourceSetups)
        .where(
          and(
            eq(resourceSetups.tenantId, ctx.tenant.id),
            inArray(resourceSetups.resourceId, ids),
            eq(resourceSetups.isActive, true),
            eq(resourceSetups.rateUnit, 'hour'),
          ),
        )
        .orderBy(asc(resourceSetups.sortOrder), asc(resourceSetups.name))
      for (const s of setupRows) {
        const list = setupsByResource.get(s.resourceId) ?? []
        list.push({ id: s.id, name: s.name, rate: s.rate })
        setupsByResource.set(s.resourceId, list)
      }
    }

    // Every upcoming active slot for these resources, earliest first — then
    // reduced to "first seen per resourceId" in JS below rather than a SQL
    // DISTINCT ON, matching this codebase's own preference for a small
    // in-memory reduction over a per-group SQL trick (see lib/payroll/run.ts)
    // for a result set this size (one branch's resources).
    const upcomingRows = await tx
      .select({
        resourceId: bookingSlots.resourceId,
        startsAt: bookingSlots.startsAt,
        endsAt: bookingSlots.endsAt,
        bookingNumber: bookings.bookingNumber,
        customerName: bookings.customerName,
      })
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
      .orderBy(asc(bookingSlots.startsAt))

    const nextBookingByResource = new Map<string, (typeof upcomingRows)[number]>()
    for (const row of upcomingRows) {
      if (!nextBookingByResource.has(row.resourceId)) nextBookingByResource.set(row.resourceId, row)
    }

    return rows.map((r) => {
      const next = nextBookingByResource.get(r.id)
      return {
        id: r.id,
        name: r.name,
        resourceTypeId: r.resourceTypeId,
        typeName: r.typeName,
        hourlyRate: r.rateOverride ?? r.typeRate,
        typeHourlyRate: r.typeRate,
        weekendRate: r.weekendRate,
        capacity: r.capacity,
        typeImageUrl: r.typeImageUrl,
        isFree: !occupiedNow.has(r.id),
        hasUpcomingBooking: Boolean(next),
        nextBooking: next
          ? {
              startsAt: next.startsAt.toISOString(),
              endsAt: next.endsAt ? next.endsAt.toISOString() : null,
              bookingNumber: next.bookingNumber,
              customerName: next.customerName,
            }
          : null,
        pricingMode: r.pricingMode,
        minPlayers: r.minPlayers,
        setups: setupsByResource.get(r.id) ?? [],
      }
    })
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
  /** M29 #6: board surcharge — the per-extra-player rate frozen at start (null
   *  = no surcharge, every pre-M29 walk-in) and the type's LIVE included
   *  players. The checkout/timed dialogs show a Players control when set. */
  extraPlayerRateApplied: string | null
  includedPlayers: number
  /** M26 #5: cash collected before this walk-in started (M26 #1/#4) — '0.00'
   *  for every walk-in with nothing collected upfront, and for every
   *  non-gaming_cafe tenant (server-refused at creation, see
   *  startWalkinCore). Lets the Sessions board show a live "Partially paid"
   *  indicator once the running total outgrows it, before any bill exists. */
  advancePaid: string
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
        extraPlayerRateApplied: bookingSlots.extraPlayerRateApplied,
        // M29 #8: the start-time snapshot wins; legacy rows fall back to live.
        includedPlayers: sql<number>`coalesce(${bookingSlots.includedPlayersApplied}, ${resourceTypes.includedPlayers})`,
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
  // M30 #4: collected-upfront figure summed live from the ledger, one grouped query.
  const advance = await withUser(ctx.user.id, (tx) =>
    advancePaidTotals(tx, ctx.tenant.id, [...new Set(rows.map((r) => r.bookingId))]),
  )
  return rows.map((r) => ({
    ...r,
    billingMode: (r.billingMode as WalkinMode) ?? 'open_tab',
    advancePaid: advance.get(r.bookingId) ?? '0.00',
  }))
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
  /** M24 #7: start on a named per-hour setup (studio industries only) — bills
   *  at the setup's flat hourly rate instead of the base rate, with no
   *  weekend / holiday / happy-hour / per-head composition, exactly as a
   *  reserved setup slot does (priceBookingSlots). Re-validated here against
   *  this resource + tenant + active + per-hour, never trusted at face value. */
  setupId?: string
  /** M30 #2: advance tenders collected before this walk-in started —
   *  gaming_cafe only (re-validated by validateAdvanceTenders, never trusted
   *  from the caller). Absent or empty is a no-op. */
  advanceTenders?: AdvanceTenderInput[]
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
  const advance = await validateAdvanceTenders(tx, ctx.tenantId, input.advanceTenders)

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
      resourceTypeId: resources.resourceTypeId,
      typeName: resourceTypes.name,
      typeRate: resourceTypes.hourlyRate,
      typeWeekendRate: resourceTypes.weekendRate,
      rateOverride: resources.hourlyRateOverride,
      taxPercent: taxRates.percent,
      pricingMode: resourceTypes.pricingMode,
      minPlayers: resourceTypes.minPlayers,
      // M29 #6: board extra-player surcharge (0105).
      includedPlayers: resourceTypes.includedPlayers,
      extraPlayerRate: resourceTypes.extraPlayerRate,
      extraPlayerWeekendRate: resourceTypes.extraPlayerWeekendRate,
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

  // An open tab has no end time until checkout (module doc comment above) —
  // unlike a timed session, which might legitimately fit before a later
  // booking, an open tab's unbounded ends_at overlaps ANY future active slot
  // on this resource, no matter how far off. That makes it the one case
  // where the module's own "warn but let the exclusion constraint decide"
  // policy doesn't apply — there's no ambiguity to defer, so it's rejected
  // here with a clear reason instead of surfacing as a raw 23P01 later.
  if (input.mode === 'open_tab') {
    const [futureSlot] = await tx
      .select({ startsAt: bookingSlots.startsAt })
      .from(bookingSlots)
      .innerJoin(bookings, eq(bookings.id, bookingSlots.bookingId))
      .where(
        and(
          eq(bookingSlots.resourceId, resource.id),
          eq(bookingSlots.active, true),
          gt(bookingSlots.startsAt, startAt),
          inArray(bookings.status, ACTIVE_BOOKING_STATUSES),
        ),
      )
      .orderBy(asc(bookingSlots.startsAt))
      .limit(1)
    if (futureSlot) {
      throw new BookingError(
        'This station has a booking scheduled later — an open tab has no end time, so it would overlap. Start a timed session instead, or pick a different station.',
      )
    }
  }

  // M24 #7: a setup prices INSTEAD OF the base-rate path below (no weekend,
  // holiday, happy hour, per-head or surcharge) — same precedence
  // priceBookingSlots gives a reserved setup slot. Gated to studio industries
  // server-side (the picker is only a convenience) and re-resolved against
  // THIS resource + tenant, fail-closed like priceBookingSlots.
  let setup: { id: string; name: string; rate: number } | null = null
  if (input.setupId) {
    const [t] = await tx.select({ industry: tenants.industry }).from(tenants).where(eq(tenants.id, ctx.tenantId)).limit(1)
    if (!t || !industryHasStudioSetups(t.industry)) {
      throw new BookingError('Setups are only available for studio businesses.')
    }
    const [row] = await tx
      .select({
        id: resourceSetups.id,
        resourceId: resourceSetups.resourceId,
        name: resourceSetups.name,
        rate: resourceSetups.rate,
        rateUnit: resourceSetups.rateUnit,
        isActive: resourceSetups.isActive,
      })
      .from(resourceSetups)
      .where(and(eq(resourceSetups.tenantId, ctx.tenantId), eq(resourceSetups.id, input.setupId)))
      .limit(1)
    if (!row || row.resourceId !== resource.id || !row.isActive) {
      throw new BookingError('This setup is no longer available for the selected resource.')
    }
    if (row.rateUnit !== 'hour') {
      throw new BookingError('A per-day setup can’t be used for a walk-in — book it as a future booking instead.')
    }
    setup = { id: row.id, name: row.name, rate: Number(row.rate) }
    if (setup.rate <= 0) {
      throw new BookingError('This setup has no hourly rate set — a walk-in can’t bill at zero.')
    }
  }

  const weekdayRate = Number(resource.rateOverride ?? resource.typeRate)
  // A zero EFFECTIVE rate (a per-resource override, not just the type rate
  // already rejected above) would price a timed session to ₹0 — indistinguishable
  // from the `slot_total > 0` "already checked out?" sentinel loadWalkinForCheckout
  // relies on, which would then misfire and lock the booking as uncheckoutable.
  if (weekdayRate <= 0) {
    throw new BookingError('This resource isn’t set up as an hourly station.')
  }
  // M27 #2: a holiday rate wins over weekend config entirely — looked up
  // BEFORE resolveDayRate, same precedence priceBookingSlots gives it.
  // Snapshotted onto holiday_rate_applied below so checkout (which only ever
  // reads this snapshot back, never re-resolves it) knows to skip
  // happy-hour splitting too — see loadWalkinForCheckout/checkoutWalkinCore.
  // A setup walk-in never consults a holiday rate (priced instead of it).
  const [holiday] = setup
    ? []
    : await tx
        .select({ rate: holidayRates.rate })
        .from(holidayRates)
        .where(
          and(
            eq(holidayRates.tenantId, ctx.tenantId),
            eq(holidayRates.resourceTypeId, resource.resourceTypeId),
            eq(holidayRates.date, todayInZone(ctx.timezone, startAt)),
          ),
        )
        .limit(1)
  const holidayRateApplied = holiday !== undefined

  // M22 #2: resolved by the session's START day and snapshotted onto
  // rate_applied below — checkout/extend read the snapshot back
  // (loadWalkinForCheckout), never re-resolve it, so a walk-in that runs
  // past midnight still bills the day it started on.
  const weekendRate = resource.typeWeekendRate === null ? null : Number(resource.typeWeekendRate)
  const weekendDays = await loadWeekendDays(tx, ctx.tenantId)
  const rate = setup
    ? setup.rate
    : holidayRateApplied
      ? Number(holiday.rate)
      : resolveDayRate(weekdayRate, weekendRate, startAt, ctx.timezone, weekendDays)
  // Re-check the RESOLVED rate, not just weekdayRate above: a type can set
  // weekend_rate to exactly 0 (a free-on-weekends config) independently of
  // a positive weekday rate, or a holiday rate itself to 0. That would slip
  // past the weekdayRate guard yet still produce the same zero-rate hazard
  // it exists to prevent — a timed walk-in's checkout ends up with
  // slotTotal = '0.00', indistinguishable from loadWalkinForCheckout's "not
  // yet checked out" sentinel, so it can be checked out again (or skipped
  // from billing) instead of being blocked.
  //
  // CodeRabbit review: the weekend-configuration message is wrong for a
  // holiday-rate cause — staff would go check the weekend settings and find
  // nothing wrong there, since the actual zero came from a holiday_rates
  // row. Branch the message on holidayRateApplied so it points at the
  // right place.
  if (rate <= 0) {
    throw new BookingError(
      holidayRateApplied
        ? 'This resource has a zero holiday rate for today — set a positive holiday rate.'
        : 'This resource isn’t set up as an hourly station on weekends.',
    )
  }
  const taxPercent =
    resource.taxPercent ?? (await resolveScopeDefaultTaxPercent(tx, ctx.tenantId, 'resources')) ?? '0'

  // M21 per-head #4: captured now (mirrors priceBookingSlots' own
  // validation for a reserved booking) even though a walk-in isn't PRICED
  // until checkout — checkoutWalkinCore defaults to whatever's stored here,
  // and the checkout dialog lets the operator edit it before confirming.
  let headCount: number | null = null
  if (resource.pricingMode === 'per_head' && !setup) {
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
  // M29 #6: a per_resource board with an extra-player rate also carries a
  // player count — defaulting to the included players (no surcharge) when the
  // caller doesn't send one, since a walk-in is priced at checkout where the
  // real count is confirmed (same idea as the public flow's default). Mode is
  // re-checked here so a per_head type never reads as a board. The extra rate
  // is day-resolved by the session's START day and snapshotted, exactly like
  // the base rate — checkout reads it back, never re-resolves.
  let extraPlayerRateApplied: string | null = null
  let includedPlayersApplied: number | null = null
  if (!setup && resource.pricingMode === 'per_resource' && resource.extraPlayerRate !== null) {
    const requested = input.headCount
    if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
      throw new BookingError(`${resource.typeName} is priced per player — enter the number of players.`)
    }
    headCount = requested ?? resource.includedPlayers
    // M29 #8: freeze the included count alongside the extra rate.
    includedPlayersApplied = resource.includedPlayers
    extraPlayerRateApplied = resolveDayRate(
      Number(resource.extraPlayerRate),
      resource.extraPlayerWeekendRate === null ? null : Number(resource.extraPlayerWeekendRate),
      startAt,
      ctx.timezone,
      weekendDays,
    ).toFixed(2)
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
    // A setup walk-in is flat: stored as per_resource so nothing downstream
    // (the checkout/timed dialogs' Players control, resolveHeadCount) treats
    // it as a per-head or surcharge session.
    pricingMode: setup ? 'per_resource' : resource.pricingMode,
    headCount,
    holidayRateApplied,
    extraPlayerRateApplied,
    includedPlayersApplied,
    // M24 #7: snapshot, same discipline as a reserved setup slot.
    setupId: setup?.id ?? null,
    setupName: setup?.name ?? null,
  })

  await recordAdvanceTenders(tx, ctx, { bookingId: booking.id, branchId: input.branchId }, advance.tenders)

  return { id: booking.id, bookingNumber, confirmationToken: booking.confirmationToken }
}

/** The NORMAL checkout window for an OPEN-TAB walk-in: how far from "now" the
 *  confirmed end is expected to sit, either direction — same shape as
 *  WALKIN_START_WINDOW_MINUTES. A checkout inside it is routine and
 *  unaudited; one in the PAST beyond it is a late checkout (M32) and audited.
 *  Also still the bound on how far in the FUTURE an end may be nudged.
 *  Meaningless for a TIMED walk-in: its checkout is gated on the committed
 *  end instead (see resolveCheckoutWindow). */
export const WALKIN_CHECKOUT_WINDOW_MINUTES = 30

/** M32: how far back an open-tab walk-in's checkout end may be entered when
 *  staff forgot to close it out. Mirrors M28's 7-day precedent for entering
 *  something money-affecting after the fact — named as this feature's own. */
export const WALKIN_LATE_CHECKOUT_MAX_DAYS = 7

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
  resourceId: string
  startsAt: Date
  rate: number
  /** M27 #2: true when `rate` above was snapshotted from a holiday_rates row
   *  at start — checkout skips happy-hour splitting entirely when true (see
   *  previewWalkinCheckout/checkoutWalkinCore), same "instead of" precedence
   *  priceBookingSlots gives a holiday rate. */
  holidayRateApplied: boolean
  /** M24 #7: true when this session started on a named setup — priced flat,
   *  so checkout skips happy-hour splitting just like a holiday rate. Read off
   *  the slot's snapshotted setup_name as well as setup_id: the id is nulled
   *  (ON DELETE SET NULL) if the setup is later deleted, the name is not. */
  isSetup: boolean
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
  /** M29 #6: the per-extra-player hourly rate frozen at start — null for every
   *  walk-in without a board surcharge. Never re-resolved at checkout. */
  extraPlayerRate: number | null
  /** Included players frozen at start (M29 #8) so a mid-session type edit can't
   *  re-price the surcharge; falls back to the type's live value only for a
   *  walk-in started before 0106. 1 when there's no surcharge. */
  includedPlayers: number
}

/**
 * Load + validate the walk-in a checkout or extend acts on. Shared by every
 * read (previewWalkinCheckout — no lock) and write (checkoutWalkinCore,
 * extendWalkinCore — locks both rows, same FOR UPDATE discipline
 * prepareBookingBill uses) so none of them can drift on what counts valid.
 */
export async function loadWalkinForCheckout(
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
    holidayRateApplied: bookingSlots.holidayRateApplied,
    extraPlayerRateApplied: bookingSlots.extraPlayerRateApplied,
    includedPlayersApplied: bookingSlots.includedPlayersApplied,
    setupId: bookingSlots.setupId,
    setupName: bookingSlots.setupName,
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
  // M29 #6: eligibility is the slot's own extra_player_rate_applied snapshot;
  // included players is the start-time snapshot (M29 #8), live only as a
  // fallback for a walk-in started before the snapshot existed.
  const extraPlayerRate =
    pricingMode !== 'per_head' && slot.extraPlayerRateApplied !== null ? Number(slot.extraPlayerRateApplied) : null
  let includedPlayers = 1
  if (extraPlayerRate !== null && slot.includedPlayersApplied !== null) {
    includedPlayers = slot.includedPlayersApplied
  } else if (extraPlayerRate !== null) {
    const [typeRow] = await tx
      .select({ includedPlayers: resourceTypes.includedPlayers })
      .from(resources)
      .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
      .where(eq(resources.id, slot.resourceId))
      .limit(1)
    includedPlayers = typeRow?.includedPlayers ?? 1
  }

  return {
    bookingId: booking.id,
    slotId: slot.id,
    resourceId: slot.resourceId,
    startsAt: slot.startsAt,
    rate: Number(slot.rateApplied),
    holidayRateApplied: slot.holidayRateApplied,
    isSetup: slot.setupId !== null || slot.setupName !== null,
    billingMode: (booking.billingMode as WalkinMode) ?? 'open_tab',
    slotEndsAt: slot.endsAt,
    slotTotal: slot.slotTotal,
    committedEndAt: booking.committedEndAt,
    pricingMode,
    headCount: slot.headCount,
    minPlayers,
    extraPlayerRate,
    includedPlayers,
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
  // M29 #6: a board-with-surcharge walk-in has an editable player count too,
  // but no floor — fewer players than included just means no surcharge — so
  // it only needs to be a positive whole number.
  if (walkin.extraPlayerRate !== null) {
    const players = requested ?? walkin.headCount ?? walkin.includedPlayers
    if (!Number.isInteger(players) || players < 1) {
      throw new BookingError('Enter a whole number of players, at least 1.')
    }
    return players
  }
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
 * The hourly rate and multiplier priceElapsedTime should price at. A plain or
 * per_head walk-in is unchanged: the snapshotted rate, with headCount as the
 * per-player multiplier (1 for per_resource). A board-with-surcharge walk-in
 * prices the COMBINED rate — base + max(0, players − included) × extra rate —
 * with no further multiplication, the same composition order as
 * priceBookingSlots (M29 #3): happy hour (skipped on a holiday date) then
 * segments that one figure.
 */
function walkinRateAndMultiplier(walkin: WalkinForCheckout, headCount: number): { rate: number; multiplier: number } {
  if (walkin.extraPlayerRate === null) return { rate: walkin.rate, multiplier: headCount }
  const extraPlayers = Math.max(0, headCount - walkin.includedPlayers)
  return { rate: walkin.rate + extraPlayers * walkin.extraPlayerRate, multiplier: 1 }
}

/**
 * Validate `endAt` and resolve the [start, end) window checkout actually
 * prices — mode-specific (M21 #5):
 *
 *   - Open tab: `endAt` (defaulting to now) must be no more than
 *     WALKIN_CHECKOUT_WINDOW_MINUTES ahead of now, no more than
 *     WALKIN_LATE_CHECKOUT_MAX_DAYS behind it (M32 — a forgotten tab), and
 *     after the session started — it IS the priced window's own end.
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
    // M32: the past side is widened to WALKIN_LATE_CHECKOUT_MAX_DAYS so a
    // forgotten tab can be closed out at the time it really ended. The future
    // side is deliberately unchanged — still at most the normal window ahead
    // (also absorbs a few seconds of client/server clock skew on a routine
    // "end = now" checkout).
    if (endAt.getTime() - now.getTime() > WALKIN_CHECKOUT_WINDOW_MINUTES * 60_000) {
      throw new BookingError(`End time cannot be more than ${WALKIN_CHECKOUT_WINDOW_MINUTES} minutes in the future.`)
    }
    if (now.getTime() - endAt.getTime() > WALKIN_LATE_CHECKOUT_MAX_DAYS * 24 * 60 * 60_000) {
      throw new BookingError(`Enter a time within the last ${WALKIN_LATE_CHECKOUT_MAX_DAYS} days.`)
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
  // M27 #2: a holiday-priced session bills flat — no happy-hour rules to
  // even load, same "instead of" precedence priceBookingSlots gives it.
  const rules = walkin.holidayRateApplied || walkin.isSetup ? [] : await loadActiveHappyHourRules(tx, ctx.tenantId)
  const { rate, multiplier } = walkinRateAndMultiplier(walkin, headCount)
  const priced = priceElapsedTime(walkin.startsAt, priceEnd, rate, rules, ctx.timezone, multiplier)
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
  ctx: { tenantId: string; timezone: string; membershipId?: string | null },
  input: CheckoutWalkinInput,
): Promise<{ bookingId: string; total: number }> {
  const walkin = await loadWalkinForCheckout(tx, ctx, input.bookingId, true)
  const { priceEnd } = resolveCheckoutWindow(walkin, input.endAt)
  const headCount = resolveHeadCount(walkin, input.headCount)
  // M27 #2: a holiday-priced session bills flat — no happy-hour rules to
  // even load, same "instead of" precedence priceBookingSlots gives it.
  const rules = walkin.holidayRateApplied || walkin.isSetup ? [] : await loadActiveHappyHourRules(tx, ctx.tenantId)
  const { rate, multiplier } = walkinRateAndMultiplier(walkin, headCount)
  const priced = priceElapsedTime(walkin.startsAt, priceEnd, rate, rules, ctx.timezone, multiplier)

  // M21 per-head #4: the (possibly just-edited) head count is written here,
  // at the moment checkout actually commits — same "preview travels loose,
  // only checkout persists" discipline endAt already has. A per_resource
  // slot's head_count stays null; nothing to write.
  // M29 #6: a surcharge walk-in persists its (possibly edited) count too.
  const persistsHeadCount = walkin.pricingMode === 'per_head' || walkin.extraPlayerRate !== null
  // A surcharge walk-in also freezes the included-player count it was priced
  // with (walkin.includedPlayers = the start snapshot, or the live value for a
  // walk-in started before 0106). Without this a legacy walk-in keeps reading
  // the live value after checkout, so raising included_players later would hide
  // the extra-player breakdown on a bill that did charge for them.
  const headCountUpdate = persistsHeadCount
    ? { headCount, ...(walkin.extraPlayerRate !== null ? { includedPlayersApplied: walkin.includedPlayers } : {}) }
    : {}

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
  // The booking's own subtotal/total are stamped here too — a walk-in is born
  // with both at 0 (nothing is priced until now), and every screen that reads
  // bookings.total (the booking detail, reports) would keep showing 0.00 for
  // a session that was billed in full. A walk-in carries no discount.
  await tx
    .update(bookings)
    .set({
      subtotal: priced.unitPrice.toFixed(2),
      total: priced.unitPrice.toFixed(2),
      ...(persistsHeadCount ? { headCount } : {}),
    })
    .where(and(eq(bookings.id, walkin.bookingId), eq(bookings.tenantId, ctx.tenantId)))

  // M32: an open-tab checkout whose entered end sits outside the NORMAL window
  // is a late checkout — a correction, not routine ops — so it is audited
  // (entered end vs when it actually happened). A routine checkout inside the
  // window writes nothing, exactly as before; a timed walk-in never does.
  if (walkin.billingMode === 'open_tab') {
    const checkedOutAt = new Date()
    if (Math.abs(priceEnd.getTime() - checkedOutAt.getTime()) > WALKIN_CHECKOUT_WINDOW_MINUTES * 60_000) {
      await writeAudit(tx, { tenantId: ctx.tenantId, membershipId: ctx.membershipId ?? null }, {
        action: 'walkin.late_checkout',
        entityType: 'booking',
        entityId: walkin.bookingId,
        before: { endsAt: null },
        after: {
          enteredEndAt: priceEnd.toISOString(),
          checkedOutAt: checkedOutAt.toISOString(),
          total: priced.unitPrice.toFixed(2),
        },
      })
    }
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

export type CorrectWalkinEndTimeInput = { bookingId: string; newEndAt: string }

/**
 * M31 #1 — set a timed walk-in's committed end to a staff-supplied ABSOLUTE
 * time, earlier or later than the current one. The sibling of
 * extendWalkinCore (which stays additive-only and untouched): that one can
 * only push the end forward, so an accidental +60 had no way back.
 *
 * Reuses the same load/lock and the same timed / not-yet-checked-out guards.
 * Re-pricing needs no new wiring: checkout and previewWalkinCheckout always
 * price fresh from whatever committed_end_at currently is.
 *
 * Overlap: bookings.committed_end_at and booking_slots.ends_at move together
 * exactly as extend does, so the GiST exclusion constraint (0003)
 * re-validates the slot write whichever way it moved — a LATER time that now
 * collides is rejected (23P01) like any extend; an EARLIER time shrinks the
 * range to a strict subset of one already accepted and can never conflict.
 *
 * Extra guards beyond extend: the new end must be after the session started
 * (a friendly error ahead of the ends_at > starts_at CHECK), must still be in
 * the future (a running session can't be corrected to a time already past —
 * that is what checkout is for), and within WALKIN_EXTEND_MAX_MINUTES of now.
 *
 * Unlike extend, this is a correction tool, so it is audited (same
 * discipline as undo-check-in / reopen-walkin).
 */
export async function correctWalkinEndTimeCore(
  tx: Db,
  ctx: { tenantId: string; membershipId: string | null },
  input: CorrectWalkinEndTimeInput,
): Promise<{ bookingId: string; committedEndAt: string }> {
  const newEnd = new Date(input.newEndAt)
  if (Number.isNaN(newEnd.getTime())) throw new BookingError('Enter a valid end time.')

  const walkin = await loadWalkinForCheckout(tx, ctx, input.bookingId, true)
  if (walkin.billingMode !== 'timed') {
    throw new BookingError('Only a timed walk-in has an end time to correct.')
  }
  if (Number(walkin.slotTotal) > 0) {
    throw new BookingError('This session has already been checked out — nothing left to correct.')
  }
  if (!walkin.committedEndAt) throw new BookingError('This walk-in has no committed end time.')

  const now = new Date()
  if (newEnd <= walkin.startsAt) throw new BookingError('The end time must be after the session started.')
  if (newEnd <= now) {
    throw new BookingError('The end time must be in the future — the session is still running.')
  }
  if (newEnd.getTime() - now.getTime() > WALKIN_EXTEND_MAX_MINUTES * 60_000) {
    throw new BookingError(`Enter a time within the next ${WALKIN_EXTEND_MAX_MINUTES / 60} hours.`)
  }

  await tx
    .update(bookings)
    .set({ committedEndAt: newEnd })
    .where(and(eq(bookings.id, walkin.bookingId), eq(bookings.tenantId, ctx.tenantId)))
  await tx.update(bookingSlots).set({ endsAt: newEnd }).where(eq(bookingSlots.id, walkin.slotId))

  await writeAudit(tx, { tenantId: ctx.tenantId, membershipId: ctx.membershipId }, {
    action: 'walkin.end_time_corrected',
    entityType: 'booking',
    entityId: walkin.bookingId,
    before: { committedEndAt: walkin.committedEndAt.toISOString() },
    after: { committedEndAt: newEnd.toISOString() },
  })

  return { bookingId: walkin.bookingId, committedEndAt: newEnd.toISOString() }
}

/**
 * M25 #2 — undo an accidental walk-in checkout: reverses what
 * checkoutWalkinCore froze, so the session resumes as though it were never
 * closed. Locks booking + slot the same way loadWalkinForCheckout always has
 * (status 'checked_in', channel 'walkin' — a checked-out-but-unbilled
 * walk-in never leaves 'checked_in'; see checkoutWalkinCore's own doc
 * comment for why).
 *
 * Refuses if the session was never actually checked out (nothing to
 * reopen), if a live (non-void) invoice already exists (findLiveBilling —
 * void it first, same "money movement is its own decision" discipline
 * undoCheckInCore applies to check-in), and — open-tab only — if a later
 * active booking now exists on this resource: an open tab's ends_at is
 * about to go back to null (unbounded), which would overlap ANY such
 * booking, the exact hazard startWalkinCore's own open-tab guard exists to
 * prevent at start time. A timed session doesn't need this check: its
 * ends_at (the committed end) never moves, so reopening it changes nothing
 * the exclusion constraint would recheck.
 *
 * per_head: head_count is left exactly as it was — still editable through
 * the ordinary checkout flow once the session is unbilled again.
 */
export async function reopenWalkinCore(
  tx: Db,
  ctx: { tenantId: string; membershipId: string | null },
  bookingId: string,
): Promise<{ bookingId: string }> {
  const walkin = await loadWalkinForCheckout(tx, ctx, bookingId, true)

  const isCheckedOut = walkin.billingMode === 'open_tab' ? walkin.slotEndsAt !== null : Number(walkin.slotTotal) > 0
  if (!isCheckedOut) {
    throw new BookingError('This walk-in has not been checked out yet.')
  }

  const live = await findLiveBilling(tx, ctx.tenantId, bookingId)
  if (live) {
    throw new BookingError('This walk-in has already been billed — void the bill before reopening.')
  }

  if (walkin.billingMode === 'open_tab') {
    const [futureSlot] = await tx
      .select({ startsAt: bookingSlots.startsAt })
      .from(bookingSlots)
      .innerJoin(bookings, eq(bookings.id, bookingSlots.bookingId))
      .where(
        and(
          eq(bookingSlots.resourceId, walkin.resourceId),
          eq(bookingSlots.active, true),
          gt(bookingSlots.startsAt, walkin.startsAt),
          inArray(bookings.status, ACTIVE_BOOKING_STATUSES),
        ),
      )
      .orderBy(asc(bookingSlots.startsAt))
      .limit(1)
    if (futureSlot) {
      throw new BookingError(
        'This station has a booking scheduled later — reopening would leave the tab with no end time and overlap it. Check it out for real instead.',
      )
    }
  }

  const before = { billingMode: walkin.billingMode, endsAt: walkin.slotEndsAt?.toISOString() ?? null, slotTotal: walkin.slotTotal }

  if (walkin.billingMode === 'open_tab') {
    await tx.update(bookingSlots).set({ endsAt: null, slotTotal: '0.00' }).where(eq(bookingSlots.id, walkin.slotId))
  } else {
    await tx.update(bookingSlots).set({ slotTotal: '0.00' }).where(eq(bookingSlots.id, walkin.slotId))
  }
  await tx
    .update(bookings)
    .set({ subtotal: '0.00', total: '0.00' })
    .where(and(eq(bookings.id, walkin.bookingId), eq(bookings.tenantId, ctx.tenantId)))

  await writeAudit(tx, { tenantId: ctx.tenantId, membershipId: ctx.membershipId }, {
    action: 'walkin.reopen',
    entityType: 'booking',
    entityId: walkin.bookingId,
    before,
    after: { billingMode: walkin.billingMode, endsAt: walkin.billingMode === 'open_tab' ? null : before.endsAt, slotTotal: '0.00' },
  })

  return { bookingId: walkin.bookingId }
}
