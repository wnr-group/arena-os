/**
 * Placing a booking — the transactional core shared by the staff action
 * (lib/actions/bookings.ts, via withUser) and the public booking action
 * (lib/actions/public-booking.ts, via withPublicTenant). Takes a `tx` and an
 * explicit ctx, exactly like lib/orders/service.ts:createOrderCore — the
 * caller decides how the tenant/identity was established.
 */
import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { resources, resourceTypes, bookings, bookingSlots, orders, auditLog, taxRates, tenants } from '@/db/schema'
import { durationHours } from './availability'
import { round2 } from '@/lib/billing/pricing'
import { priceTimeRangeSegments } from '@/lib/billing/elapsed-time'
import { todayInZone } from './time'
import { resolveDayRate } from './rate'
import { resolveBookingCustomer } from './customer'
import { findLiveBilling } from '@/lib/billing/invoice'
import { getInvoiceSettlement } from '@/lib/billing/payments'
import { resolveScopeDefaultTaxPercent } from '@/lib/tax-rates/resolve'
import { loadWeekendDays } from '@/lib/settings/business-profile'
import { loadActiveHappyHourRules } from '@/lib/happy-hours/rules'

type Db = NodePgDatabase<typeof schema>

/** Booking rule violations the caller is allowed to show verbatim. */
export class BookingError extends Error {}

/**
 * A booking's own `channel` ('walkin' | 'staff' | 'online'), read fresh
 * inside the caller's transaction. Exists so lib/actions/billing.ts's
 * billing actions can resolve canBillBooking's channel argument from a
 * trusted, server-side source — never from the client — before gating
 * whether this caller may raise the bill for it. Null when the booking
 * doesn't exist (or belongs to another tenant, indistinguishable under
 * RLS), same "quiet, not found" shape every other by-id lookup here uses.
 */
export async function loadBookingChannel(tx: Db, tenantId: string, bookingId: string): Promise<string | null> {
  const [row] = await tx
    .select({ channel: bookings.channel })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1)
  return row?.channel ?? null
}

export type CreateBookingSlotInput = { resourceId: string; startsAt: string; endsAt: string }

export type CreateBookingInput = {
  branchId: string
  customerName?: string
  customerPhone?: string
  customerEmail?: string
  notes?: string
  source: 'walk_in' | 'staff' | 'online'
  discount: number
  deposit: number
  slots: CreateBookingSlotInput[]
  /** Player count (M21 per-head #2) — required, and only meaningful, when a
   *  slot's resource type is pricing_mode='per_head'. Applies uniformly to
   *  every per_head slot in this booking (bookings.head_count is one value
   *  per booking, not per slot — see 0094_per_head_pricing.sql). */
  headCount?: number
}

export type CreatedBooking = { id: string; bookingNumber: string; confirmationToken: string }

export type PricedBookingSlot = {
  resourceId: string
  startsAt: Date
  endsAt: Date
  rateApplied: string
  slotTotal: string
  resourceName: string
  resourceTypeName: string
  taxRatePercent: string
  /** Snapshot of the booking's head_count (M21 per-head #2) — null for a
   *  per_resource slot, same discipline as rateApplied/taxRatePercent. */
  headCount: number | null
  /** Snapshot of the resource type's pricing_mode at booking time. */
  pricingMode: string
  /** M23 #1: true when at least one segment of this slot's window billed at
   *  a happy-hour-discounted rate — see db/schema.ts's column comment and
   *  loadBookingLines (lib/billing/invoice.ts) for how this is used. */
  happyHourApplied: boolean
}

/**
 * Price a set of slots against their resources' effective hourly rate —
 * split out of createBookingCore so a caller can learn a booking's total
 * BEFORE creating it (the public pay-now flow, lib/actions/public-booking.ts,
 * needs this to decide how much to charge online) without a second,
 * drifting copy of the rate lookup.
 *
 * M21 per-head #2: a per_head resource type bills head_count × rate × hours
 * instead of rate × hours — hourlyRate's meaning flips from "per resource"
 * to "per player" (see resourceTypes.hourlyRate's comment in db/schema.ts).
 * A per_resource slot (the default, and every pre-existing type) is priced
 * exactly as before; head_count plays no part in its total.
 *
 * M22 #2: each slot's base rate is resolved by ITS OWN startsAt day — a
 * weekday slot bills resourceTypes.weekendRate ?? weekdayRate; weekdayRate
 * is resources.hourlyRateOverride ?? resourceTypes.hourlyRate, unchanged.
 * weekendRate = null means no weekend pricing configured, so every day
 * prices identically to today. See lib/booking/rate.ts:resolveDayRate.
 *
 * M22 follow-up (adversarial review of PR #29, item 2): resolving by "the
 * slot's own startsAt day" is only correct because a single continuous
 * session is always ONE slot — a Fri 23:00 -> Sat 02:00 booking bills the
 * Friday (start-day) rate across the whole window, as the spec requires,
 * BECAUSE there is only one row to resolve. `input.slots` is an array
 * (today used solely for multiple RESOURCES in the same time window, e.g. two
 * PS5s booked together — every existing caller, FutureWizard.tsx and
 * public-booking.ts alike, emits exactly one slot per resource for a
 * continuous session). If a future caller ever split ONE session across
 * midnight into two time-contiguous slots on the SAME resource, each half
 * would silently resolve against its OWN day's rate instead of the whole
 * session's start-day rate — a real money bug, not just a display one. The
 * validation loop below refuses that shape outright (same-resource slots
 * that touch or overlap) rather than let it silently misprice, since
 * nothing legitimate ever needs two slots for one resource that touch: a
 * true continuous session is always exactly one slot with the full range.
 *
 * M23 #1: once the day rate is resolved, the slot's own [startsAt, endsAt)
 * is split at every active happy-hour rule boundary inside it and each
 * segment is discounted — priceTimeRangeSegments (lib/billing/elapsed-time.ts),
 * the same per-segment engine priceElapsedTime already uses for a walk-in's
 * elapsed time, just against the slot's own EXACT, already-known window
 * (no 30-min floor or 15-min round-up — a reserved slot's end is a firm
 * commitment, not an elapsed measurement). Composition order is fixed:
 * resolve the day rate -> happy-hour discount per segment -> × headCount —
 * never the other order, so a per-head happy-hour rule discounts the
 * PER-PLAYER rate, not some pre-multiplied total. When no rule ever fires
 * for a slot, this reproduces flat rate × hours exactly, so an untouched
 * booking is byte-identical to before this ticket.
 */
export async function priceBookingSlots(
  tx: Db,
  ctx: { tenantId: string; timezone: string },
  input: { branchId: string; slots: CreateBookingSlotInput[]; headCount?: number },
): Promise<{ subtotal: number; slots: PricedBookingSlot[] }> {
  for (const s of input.slots) {
    if (new Date(s.endsAt) <= new Date(s.startsAt)) {
      throw new BookingError('Each slot must end after it starts.')
    }
  }

  // M22 follow-up: refuse two slots on the SAME resource whose windows touch
  // or overlap — see this function's own doc comment for why. A legitimate
  // multi-slot booking is always different RESOURCES in the same window,
  // never the same resource split across two time ranges, so this can never
  // reject a real booking; it only catches a caller that (accidentally)
  // split one continuous session in two, which each-slot-resolves-by-its-
  // own-day-rate would otherwise misprice across a midnight boundary without
  // any error at all.
  {
    const byResource = new Map<string, CreateBookingSlotInput[]>()
    for (const s of input.slots) {
      const list = byResource.get(s.resourceId) ?? []
      list.push(s)
      byResource.set(s.resourceId, list)
    }
    for (const list of byResource.values()) {
      if (list.length < 2) continue
      const sorted = [...list].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
      for (let i = 1; i < sorted.length; i++) {
        if (new Date(sorted[i].startsAt).getTime() <= new Date(sorted[i - 1].endsAt).getTime()) {
          throw new BookingError(
            'A resource cannot have two touching or overlapping slots in the same booking — book it as one continuous slot instead.',
          )
        }
      }
    }
  }

  // Load the referenced resources + their type (name + effective rate).
  const ids = [...new Set(input.slots.map((s) => s.resourceId))]
  const rows = await tx
    .select({
      id: resources.id,
      name: resources.name,
      branchId: resources.branchId,
      typeName: resourceTypes.name,
      typeRate: resourceTypes.hourlyRate,
      typeWeekendRate: resourceTypes.weekendRate,
      rateOverride: resources.hourlyRateOverride,
      pricingMode: resourceTypes.pricingMode,
      minPlayers: resourceTypes.minPlayers,
      // Only a rate with appliesTo 'resources' or 'both' can ever be set here
      // (enforced in lib/actions/resources.ts), so no re-check is needed at
      // read time — unlike menu items, which snapshot from a live join too
      // but read whatever's on the row unconditionally (loadFoodLines).
      taxPercent: taxRates.percent,
    })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .leftJoin(taxRates, eq(taxRates.id, resourceTypes.taxRateId))
    .where(and(eq(resources.tenantId, ctx.tenantId), inArray(resources.id, ids)))

  const byId = new Map(rows.map((r) => [r.id, r]))
  if (byId.size !== ids.length) throw new BookingError('One or more resources were not found.')
  for (const r of rows) {
    if (r.branchId !== input.branchId) throw new BookingError('A resource belongs to a different branch.')
  }

  // Resource types with no tax_rate_id of their own fall back to the
  // tenant's sole active 'resources'/'both' rate, if unambiguous — see
  // resolveScopeDefaultTaxPercent. Skipped when every resource already has
  // its own rate.
  const defaultResourcesTaxPercent = rows.some((r) => r.taxPercent === null)
    ? await resolveScopeDefaultTaxPercent(tx, ctx.tenantId, 'resources')
    : null

  // M22 #2: the tenant's weekend-day set, loaded once for the whole call —
  // every slot below resolves its own rate against this SAME set, so two
  // slots in one booking can never disagree on what counts as a weekend.
  const weekendDays = await loadWeekendDays(tx, ctx.tenantId)

  // M23 #1: the tenant's active happy-hour rules, loaded once for the whole
  // call — every slot below is matched against this SAME set, same "load
  // once, apply per slot" discipline as weekendDays above.
  const happyHourRules = await loadActiveHappyHourRules(tx, ctx.tenantId)

  // Price each slot from a snapshot of the effective rate.
  let subtotal = 0
  const slots = input.slots.map((s) => {
    const r = byId.get(s.resourceId)!
    const startsAt = new Date(s.startsAt)
    const endsAt = new Date(s.endsAt)
    const weekdayRate = Number(r.rateOverride ?? r.typeRate)
    const weekendRate = r.typeWeekendRate === null ? null : Number(r.typeWeekendRate)
    const rate = resolveDayRate(weekdayRate, weekendRate, startsAt, ctx.timezone, weekendDays)
    const hours = durationHours(startsAt, endsAt)

    // M23 #1: split the slot at every happy-hour rule boundary inside it and
    // discount each segment — see this function's doc comment for the
    // composition order. `rawTotal` is unrounded and, for a per_head slot,
    // is still the PER-PLAYER figure — headCount multiplies below.
    const { total: rawTotal, discounted } = priceTimeRangeSegments(
      startsAt,
      endsAt,
      rate,
      happyHourRules,
      ctx.timezone,
    )

    let headCount: number | null = null
    let total: number
    if (r.pricingMode === 'per_head') {
      const requested = input.headCount
      if (requested === undefined || !Number.isInteger(requested) || requested < 1) {
        throw new BookingError(`${r.typeName} is priced per player — enter the number of players.`)
      }
      if (requested < r.minPlayers) {
        throw new BookingError(
          `${r.typeName} needs at least ${r.minPlayers} player${r.minPlayers === 1 ? '' : 's'}.`,
        )
      }
      headCount = requested
      total = headCount * rawTotal
    } else {
      total = rawTotal
    }
    subtotal += total

    // The blended (happy-hour-net) rate this slot billed at, per hour (per
    // player, for per_head) — reconstructs to `rate` exactly when no rule
    // fired (discounted === false), so an untouched booking's rate_applied
    // is byte-identical to before this ticket. Display-only when discounted:
    // loadBookingLines (lib/billing/invoice.ts) bills a flagged slot off
    // slot_total directly, never by reconstructing hours × this rate.
    const blendedRate = rawTotal / hours

    return {
      resourceId: s.resourceId,
      startsAt,
      endsAt,
      rateApplied: blendedRate.toFixed(2),
      slotTotal: total.toFixed(2),
      resourceName: r.name,
      resourceTypeName: r.typeName,
      taxRatePercent: Number(r.taxPercent ?? defaultResourcesTaxPercent ?? 0).toFixed(2),
      headCount,
      pricingMode: r.pricingMode,
      happyHourApplied: discounted,
    }
  })

  return { subtotal, slots }
}

/**
 * Resolve the head_count a caller should price/create a booking with when it
 * has no player count from the customer (M21 per-head #5) — the public
 * booking flow, which deliberately never asks online: "keep the online flow
 * simple" (design doc), the real count is only taken later at check-in
 * (Per-head #4's BillScreen Players control).
 *
 * Returns undefined when none of the referenced resources are per_head — the
 * overwhelming majority of bookings — so priceBookingSlots/createBookingCore
 * behave exactly as before this ticket for every per_resource booking.
 *
 * When one or more resources ARE per_head, returns the largest min_players
 * among them (1 for the default, and typical, min_players=1 config — the
 * ticket's "books at 1 player by default") rather than a hardcoded 1: a
 * type configured with a higher floor (e.g. snooker = 2) would otherwise
 * make every public booking attempt fail outright, since priceBookingSlots
 * itself rejects a headCount below min_players.
 */
export async function resolvePublicHeadCount(
  tx: Db,
  tenantId: string,
  resourceIds: string[],
): Promise<number | undefined> {
  const rows = await tx
    .select({ pricingMode: resourceTypes.pricingMode, minPlayers: resourceTypes.minPlayers })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(and(eq(resources.tenantId, tenantId), inArray(resources.id, resourceIds)))
  const perHead = rows.filter((r) => r.pricingMode === 'per_head')
  if (perHead.length === 0) return undefined
  return perHead.reduce((max, r) => Math.max(max, r.minPlayers), 1)
}

/**
 * Booking number: BK-YYYYMMDD-NNN, sequential per tenant per creation day.
 * Shared by createBookingCore (timed bookings) and seatTableSessionCore
 * (table sessions) so the two numbering schemes can never drift apart.
 *
 * ONE statement: the upsert takes a row lock on the (tenant, kind, period)
 * key against `sequences` (0018/0056 already allow kind = 'booking'), same
 * mechanism as lib/billing/invoice.ts:nextInvoiceNumber and
 * lib/orders/service.ts:nextDailyNumber — a read-then-write `count(*)` here
 * would hand two concurrent callers the same number and let
 * bookings_tenant_number_key reject the loser, which a walk-in-heavy screen
 * like seatTableSessionCore hits often enough at rush to matter.
 *
 * Exported (M21) so lib/booking/walkin.ts's startWalkinCore can share this
 * exact same numbering scheme instead of a second, potentially-drifting copy.
 */
export async function nextBookingNumber(tx: Db, ctx: { tenantId: string; timezone: string }): Promise<string> {
  const compact = todayInZone(ctx.timezone).replace(/-/g, '')
  const bumped = await tx.execute<{ value: number }>(sql`
    insert into sequences (tenant_id, kind, period, value)
    values (${ctx.tenantId}, 'booking', ${compact}, 1)
    on conflict (tenant_id, kind, period)
      do update set value = sequences.value + 1
    returning value
  `)
  const value = Number(bumped.rows[0].value)
  return `BK-${compact}-${String(value).padStart(3, '0')}`
}

/** Transactional core of creating a booking: validates the slots, locks for conflicts, and inserts the booking + its slots. */
export async function createBookingCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string | null },
  input: CreateBookingInput,
): Promise<CreatedBooking> {
  const { subtotal, slots: slotRows } = await priceBookingSlots(tx, ctx, {
    branchId: input.branchId,
    slots: input.slots,
    headCount: input.headCount,
  })

  const total = Math.max(0, subtotal - input.discount)

  // Attach the booking to the customer directory so it shows on their
  // profile. Same transaction as the booking, so the two commit together.
  // Returns null when there's no usable phone — see resolveBookingCustomer.
  const resolvedCustomer = await resolveBookingCustomer(tx, ctx.tenantId, {
    phone: input.customerPhone,
    name: input.customerName,
    email: input.customerEmail,
  })
  const customerId = resolvedCustomer?.id ?? null

  const bookingNumber = await nextBookingNumber(tx, ctx)

  const [booking] = await tx
    .insert(bookings)
    .values({
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      bookingNumber,
      // Falls back to the directory's own name for a returning customer who
      // wasn't asked for one again (public booking form) — otherwise the
      // booking would carry no name at all and every dashboard would show it
      // as "Walk-in" despite the phone matching a known customer.
      customerName: input.customerName?.trim() || resolvedCustomer?.name || null,
      customerPhone: input.customerPhone || null,
      customerEmail: input.customerEmail || null,
      customerId,
      status: 'confirmed',
      source: input.source,
      subtotal: subtotal.toFixed(2),
      discount: input.discount.toFixed(2),
      total: total.toFixed(2),
      deposit: input.deposit.toFixed(2),
      notes: input.notes || null,
      createdBy: ctx.membershipId,
      headCount: input.headCount ?? null,
    })
    .returning({ id: bookings.id, confirmationToken: bookings.confirmationToken })

  // Insert slots — the exclusion constraint rejects any overlap atomically.
  await tx.insert(bookingSlots).values(
    slotRows.map((s) => ({
      tenantId: ctx.tenantId,
      bookingId: booking.id,
      ...s,
    })),
  )

  return { id: booking.id, bookingNumber, confirmationToken: booking.confirmationToken }
}

export type UpdateBookingHeadCountInput = { bookingId: string; headCount: number }

/**
 * Change a per_head (reserved) booking's player count before it's billed
 * (M21 per-head #4) — the POS bill screen's Players control.
 *
 * Unlike rate/tax (frozen at booking time, see priceBookingSlots, so a later
 * config change can't reprice an old booking), head_count is meant to stay
 * EDITABLE right up until the bill is raised: min_players is re-checked
 * against the resource type's CURRENT setting here, not whatever was true
 * when the booking was made.
 *
 * Writes straight onto bookings.head_count and every active per_head
 * booking_slots row for this booking. Nothing else needs to change:
 * loadBookingLines (lib/billing/invoice.ts) already recomputes each line's
 * qty (hours × head_count) from booking_slots on every read, so the very
 * next bill-screen load re-prices the whole session with no extra step.
 *
 * Blocked once a bill already exists — findLiveBilling is the same check
 * requireNoLiveInvoice uses elsewhere in this file, just with wording that
 * fits an arbitrary resource rather than always "this table."
 */
export async function updateBookingHeadCountCore(
  tx: Db,
  ctx: { tenantId: string },
  input: UpdateBookingHeadCountInput,
): Promise<{ bookingId: string; headCount: number }> {
  if (!Number.isInteger(input.headCount) || input.headCount < 1) {
    throw new BookingError('Enter a whole number of players, at least 1.')
  }

  const [booking] = await tx
    .select({ id: bookings.id, discount: bookings.discount })
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.tenantId, ctx.tenantId)))
    .for('update')
    .limit(1)
  if (!booking) throw new BookingError('Booking not found.')

  const existing = await findLiveBilling(tx, ctx.tenantId, booking.id)
  if (existing) {
    throw new BookingError('This booking has already been billed — the player count is frozen with the bill.')
  }

  const slots = await tx
    .select({
      id: bookingSlots.id,
      resourceId: bookingSlots.resourceId,
      pricingMode: bookingSlots.pricingMode,
      rateApplied: bookingSlots.rateApplied,
      startsAt: bookingSlots.startsAt,
      endsAt: bookingSlots.endsAt,
      slotTotal: bookingSlots.slotTotal,
      headCount: bookingSlots.headCount,
      // M23 follow-up — see the re-price loop below.
      happyHourApplied: bookingSlots.happyHourApplied,
    })
    .from(bookingSlots)
    .where(
      and(eq(bookingSlots.bookingId, booking.id), eq(bookingSlots.tenantId, ctx.tenantId), eq(bookingSlots.active, true)),
    )
    .for('update')
  const perHeadSlots = slots.filter((s) => s.pricingMode === 'per_head')
  if (perHeadSlots.length === 0) {
    throw new BookingError('This booking has no per-head resource to adjust.')
  }

  // min_players is checked against the resource type's CURRENT setting, not
  // a snapshot — see the doc comment above.
  const resourceIds = [...new Set(perHeadSlots.map((s) => s.resourceId))]
  const typeRows = await tx
    .select({ minPlayers: resourceTypes.minPlayers, typeName: resourceTypes.name })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(and(eq(resources.tenantId, ctx.tenantId), inArray(resources.id, resourceIds)))
  const minPlayers = typeRows.reduce((max, r) => Math.max(max, r.minPlayers), 1)
  if (input.headCount < minPlayers) {
    const name = typeRows[0]?.typeName ?? 'This resource'
    throw new BookingError(`${name} needs at least ${minPlayers} player${minPlayers === 1 ? '' : 's'}.`)
  }

  // Re-price every per_head slot AND refresh the booking's stored subtotal/
  // total, so the customer-facing figures (online confirmation, the account
  // pages, the bookings list) match the new count. The invoice recomputes the
  // line independently from head_count (loadBookingLines), but these
  // denormalized columns are read straight out and would otherwise go stale.
  // A per_head slot with no ends_at yet (an open-tab walk-in) is priced at
  // checkout, not here, so its slot_total is left to checkoutWalkinCore.
  let newSubtotal = 0
  for (const s of slots) {
    if (s.pricingMode === 'per_head' && s.endsAt !== null) {
      // M23 follow-up: rate_applied is a per-hour BLEND rounded to cents
      // (priceBookingSlots) — for a happy-hour slot, flat headCount × rate ×
      // hours can't reproduce the exact per-segment total
      // priceTimeRangeSegments actually billed (same reason loadBookingLines
      // bills a flagged slot off slot_total directly rather than
      // reconstructing it — see happyHourApplied's doc comment in
      // db/schema.ts). headCount is a plain multiplier applied AFTER
      // segmenting (priceBookingSlots' own composition order), so scaling
      // the already-segment-accurate stored total by the headCount ratio
      // reproduces exactly what re-running priceTimeRangeSegments at the new
      // headCount would, without needing the original (frozen, no-longer-
      // reconstructible) pre-discount rate. An unflagged slot's flat
      // reconstruction is exact either way, since rate_applied IS the plain
      // rate there.
      const oldHeadCount = s.headCount ?? 1
      const slotTotal = s.happyHourApplied
        ? round2((Number(s.slotTotal) / oldHeadCount) * input.headCount)
        : round2(input.headCount * Number(s.rateApplied) * durationHours(new Date(s.startsAt), new Date(s.endsAt)))
      newSubtotal += slotTotal
      await tx
        .update(bookingSlots)
        .set({ headCount: input.headCount, slotTotal: slotTotal.toFixed(2) })
        .where(and(eq(bookingSlots.id, s.id), eq(bookingSlots.tenantId, ctx.tenantId)))
    } else {
      newSubtotal += Number(s.slotTotal)
      if (s.pricingMode === 'per_head') {
        await tx
          .update(bookingSlots)
          .set({ headCount: input.headCount })
          .where(and(eq(bookingSlots.id, s.id), eq(bookingSlots.tenantId, ctx.tenantId)))
      }
    }
  }
  newSubtotal = round2(newSubtotal)
  const newTotal = Math.max(0, round2(newSubtotal - Number(booking.discount)))
  await tx
    .update(bookings)
    .set({ headCount: input.headCount, subtotal: newSubtotal.toFixed(2), total: newTotal.toFixed(2) })
    .where(eq(bookings.id, booking.id))

  return { bookingId: booking.id, headCount: input.headCount }
}

export type SeatTableSessionInput = {
  branchId: string
  resourceId: string
  coverCount: number
  customerName?: string
  customerPhone?: string
  customerEmail?: string
  notes?: string
}

/**
 * Seat a walk-in party at a table — M17 #1. Unlike createBookingCore, this
 * skips priceBookingSlots and booking_slots entirely: a table session has no
 * time window to price or exclude on, so `bookings.resource_id` (0071) links
 * it to its table directly, and the booking starts life already
 * `checked_in` — a party is, definitionally, present the moment they're
 * seated. Concurrent double-seating of the same table is rejected by the DB
 * (idx_bookings_open_table_session, a partial unique index — see 0071), not
 * by a check-then-insert race here.
 */
export async function seatTableSessionCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string | null },
  input: SeatTableSessionInput,
): Promise<CreatedBooking> {
  if (!Number.isInteger(input.coverCount) || input.coverCount <= 0) {
    throw new BookingError('Cover count must be a whole number greater than zero.')
  }

  const [resource] = await tx
    .select({ id: resources.id, branchId: resources.branchId, status: resources.status, hourlyRate: resourceTypes.hourlyRate })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(and(eq(resources.tenantId, ctx.tenantId), eq(resources.id, input.resourceId)))
    .limit(1)
  if (!resource) throw new BookingError('Table not found.')
  if (resource.branchId !== input.branchId) {
    throw new BookingError('Table belongs to a different branch.')
  }
  // The 0071 convention lib/booking/data.ts:listTables also follows: a
  // "table" is a resource whose type carries no hourly rate. Without this, a
  // resourceId belonging to a paid/timed resource type could open a table
  // session that bypasses its hourly billing model entirely and — since
  // listTables filters on this same condition — sits locked but invisible on
  // both /floor and the normal booking calendar.
  if (Number(resource.hourlyRate) !== 0) {
    throw new BookingError('This resource isn’t set up as a table — use a resource type with no hourly rate.')
  }
  if (resource.status !== 'available') throw new BookingError('This table is not available.')

  const resolvedCustomer = await resolveBookingCustomer(tx, ctx.tenantId, {
    phone: input.customerPhone,
    name: input.customerName,
    email: input.customerEmail,
  })
  const customerId = resolvedCustomer?.id ?? null

  const bookingNumber = await nextBookingNumber(tx, ctx)
  const now = new Date()

  // idx_bookings_open_table_session rejects this with a unique-violation
  // (23505) if the table was seated by someone else a moment ago — the
  // caller (lib/actions/bookings.ts) turns that into a friendly message,
  // the same way it already does for booking_slots' overlap violation.
  const [booking] = await tx
    .insert(bookings)
    .values({
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      resourceId: input.resourceId,
      coverCount: input.coverCount,
      bookingNumber,
      customerName: input.customerName?.trim() || resolvedCustomer?.name || null,
      customerPhone: input.customerPhone || null,
      customerEmail: input.customerEmail || null,
      customerId,
      status: 'checked_in',
      source: 'walk_in',
      notes: input.notes || null,
      createdBy: ctx.membershipId,
      checkedInAt: now,
    })
    .returning({ id: bookings.id, confirmationToken: bookings.confirmationToken })

  return { id: booking.id, bookingNumber, confirmationToken: booking.confirmationToken }
}

// ── Table transfer / merge / split (M17 #5) ────────────────────────────────
//
// All three below move `bookings.resource_id` and/or `orders.booking_id`
// around, so each locks the row(s) it touches FOR UPDATE and re-validates
// against the locked state, then leans on idx_bookings_open_table_session
// (0071) to catch a destination that got occupied a moment ago — the same
// "let the constraint reject it" discipline seatTableSessionCore above uses,
// not a check-then-write race.

export type AuditActor = { tenantId: string; membershipId: string | null }

/** Append one audit row. Same shape as lib/billing/refunds.ts's private
 *  writeAudit — no shared audit module exists; each domain keeps its own. */
async function writeAudit(
  tx: Db,
  actor: AuditActor,
  entry: {
    action: string
    entityType: string
    entityId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
  },
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

async function lockTableSession(
  tx: Db,
  tenantId: string,
  bookingId: string,
  /** The past-tense verb for the "can't be X" message — 'moved' fits
   *  transfer/merge/split; requestBillCore passes 'billed' instead. */
  verb: string = 'moved',
): Promise<{
  id: string
  branchId: string
  resourceId: string | null
  coverCount: number | null
  status: string
}> {
  const [row] = await tx
    .select({
      id: bookings.id,
      branchId: bookings.branchId,
      resourceId: bookings.resourceId,
      coverCount: bookings.coverCount,
      status: bookings.status,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .for('update')
    .limit(1)
  if (!row) throw new BookingError('Table session not found.')
  if (!row.resourceId) throw new BookingError('That booking is not a table session.')
  if (row.status !== 'checked_in') {
    throw new BookingError(`This table session is ${row.status.replace('_', ' ')} — it can't be ${verb}.`)
  }
  return row
}

/**
 * Flag a table session's bill as requested (M17 #2) — validated the same way
 * transferTableCore/mergeTablesCore/splitTableCore are: lockTableSession
 * confirms this is actually an active (checked_in) table session before the
 * write, instead of stamping bill_requested_at on a booking that isn't a
 * table session at all, or one that's already completed/cancelled and has no
 * floor-map meaning left for the flag.
 */
export async function requestBillCore(tx: Db, ctx: { tenantId: string }, bookingId: string): Promise<void> {
  await lockTableSession(tx, ctx.tenantId, bookingId, 'billed')
  await tx
    .update(bookings)
    .set({ billRequestedAt: new Date() })
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenantId)))
}

async function requireNoLiveInvoice(tx: Db, tenantId: string, bookingId: string): Promise<void> {
  const existing = await findLiveBilling(tx, tenantId, bookingId)
  if (existing?.kind === 'single') {
    throw new BookingError(`This table has already been billed as invoice ${existing.invoice.invoiceNumber} — nothing to move.`)
  }
  if (existing?.kind === 'split') {
    throw new BookingError(
      `This table's bill has already been split into ${existing.checks.length} checks — nothing to move.`,
    )
  }
}

/**
 * Refuse to complete a booking with money still owing (M18 #2). Covers both
 * a normal single invoice and every check of a split bill — findLiveBilling
 * already generalises the two, same as requireNoLiveInvoice above. A booking
 * with no invoice at all (nothing was ever billed) is unaffected: this only
 * blocks completion against a KNOWN, outstanding balance, never a booking
 * that was simply never billed (e.g. a no-charge walk-through).
 */
export async function assertBookingFullyPaid(tx: Db, tenantId: string, bookingId: string): Promise<void> {
  const billing = await findLiveBilling(tx, tenantId, bookingId)
  if (!billing) return

  const invoiceIds = billing.kind === 'single' ? [billing.invoice.id] : billing.checks.map((c) => c.id)
  for (const invoiceId of invoiceIds) {
    const settlement = await getInvoiceSettlement(tx, tenantId, invoiceId)
    // findLiveBilling just proved this exact invoice exists in the SAME
    // transaction — it cannot have vanished a moment later (same reasoning
    // as lib/billing/data.ts's identical check). A null result is therefore
    // an unexpected state, not a paid invoice, so this must fail closed
    // rather than let `settlement?.payable` silently evaluate to undefined
    // (falsy) and wave the booking through as if it were settled.
    if (!settlement) throw new Error(`Settlement missing for invoice ${invoiceId}.`)
    if (settlement.payable) {
      throw new BookingError(
        billing.kind === 'split'
          ? "This table's bill has been split — settle every check before completing."
          : 'This booking still has an outstanding balance — settle it before completing.',
      )
    }
  }
}

/**
 * Complete a booking IFF its bill is now fully settled across every live check
 * — the payment-driven replacement for the manual "Complete" button, which
 * could strand an unbilled booking (setBookingStatus's completed gate passes
 * vacuously when no invoice exists, after which prepareBookingBill refuses the
 * now-'completed' booking). Called from every payment settle seam
 * (lib/actions/payments.ts) and right after a zero-balance bill is raised
 * (lib/actions/billing.ts), always inside that same transaction, so clearing
 * the last balance and closing the booking commit together or not at all.
 *
 * Returns false and writes nothing when: the tenant is a restaurant (see
 * below), the booking was never billed, ANY live check still owes (so a
 * partial payment leaves it open and a split bill completes only on the LAST
 * check paid), or the booking is not in an active confirmed/checked_in status
 * (so an already-completed/cancelled/no-show booking is never touched). Returns
 * true when it actually flipped the row.
 *
 * RESTAURANTS are deliberately excluded: a restaurant table goes
 * booking→paid→'needs cleaning'→free, and that middle state is derived from the
 * booking still being active with a live invoice (lib/booking/table-status.ts).
 * Auto-completing on payment would free the table the instant the guest pays,
 * skipping the cleaning step and killing the FloorView "Table cleaned" button.
 * So a restaurant keeps its existing manual close-out (that button, which is
 * itself gated on a settled bill); auto-complete is for verticals with no such
 * post-payment step.
 */
export async function completeBookingIfFullySettled(
  tx: Db,
  tenantId: string,
  bookingId: string,
): Promise<boolean> {
  const [t] = await tx
    .select({ industry: tenants.industry })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  if (t?.industry === 'restaurant') return false

  const billing = await findLiveBilling(tx, tenantId, bookingId)
  if (!billing) return false
  const invoiceIds = billing.kind === 'single' ? [billing.invoice.id] : billing.checks.map((c) => c.id)
  for (const invoiceId of invoiceIds) {
    const settlement = await getInvoiceSettlement(tx, tenantId, invoiceId)
    // Same fail-closed reasoning as assertBookingFullyPaid above: findLiveBilling
    // just proved this invoice exists in this transaction, so a null settlement
    // is an unexpected state, not a settled one.
    if (!settlement) throw new Error(`Settlement missing for invoice ${invoiceId}.`)
    if (settlement.payable) return false
  }
  const done = await tx
    .update(bookings)
    .set({ status: 'completed', completedAt: new Date() })
    .where(
      and(
        eq(bookings.id, bookingId),
        eq(bookings.tenantId, tenantId),
        // Only from an active status — never re-complete or resurrect a
        // cancelled/no-show booking that somehow shares a settled invoice.
        inArray(bookings.status, ['confirmed', 'checked_in']),
      ),
    )
    .returning({ id: bookings.id })
  return done.length > 0
}

export type TransferTableInput = { bookingId: string; targetResourceId: string }

/** Move a table session to a different table. Its orders "come with it" for
 *  free — they key off bookings.id, which never changes here, only its
 *  resource_id does. */
export async function transferTableCore(
  tx: Db,
  ctx: { tenantId: string; membershipId: string | null },
  input: TransferTableInput,
): Promise<{ resourceName: string }> {
  const session = await lockTableSession(tx, ctx.tenantId, input.bookingId)
  if (session.resourceId === input.targetResourceId) {
    throw new BookingError('Already seated at that table.')
  }
  await requireNoLiveInvoice(tx, ctx.tenantId, input.bookingId)

  const [fromResource] = await tx
    .select({ name: resources.name })
    .from(resources)
    .where(and(eq(resources.tenantId, ctx.tenantId), eq(resources.id, session.resourceId!)))
    .limit(1)

  const [target] = await tx
    .select({
      id: resources.id,
      branchId: resources.branchId,
      status: resources.status,
      name: resources.name,
      hourlyRate: resourceTypes.hourlyRate,
    })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(and(eq(resources.tenantId, ctx.tenantId), eq(resources.id, input.targetResourceId)))
    .limit(1)
  if (!target) throw new BookingError('Target table not found.')
  if (target.branchId !== session.branchId) throw new BookingError('Target table belongs to a different branch.')
  // Same table-type convention as seatTableSessionCore — see its comment.
  if (Number(target.hourlyRate) !== 0) {
    throw new BookingError('Target isn’t set up as a table — use a resource type with no hourly rate.')
  }
  if (target.status !== 'available') throw new BookingError('Target table is not available.')

  // idx_bookings_open_table_session rejects this (23505) if the target was
  // seated by someone else a moment ago — translated to a friendly message
  // by lib/actions/bookings.ts:fail(), same as seatTable's race.
  await tx
    .update(bookings)
    .set({ resourceId: target.id })
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.tenantId, ctx.tenantId)))

  await writeAudit(tx, ctx, {
    action: 'transfer_table',
    entityType: 'booking',
    entityId: input.bookingId,
    before: { resourceId: session.resourceId, resourceName: fromResource?.name ?? null },
    after: { resourceId: target.id, resourceName: target.name },
  })

  return { resourceName: target.name }
}

export type MergeTablesInput = { intoBookingId: string; fromBookingId: string }

/** Fold one table session into another: all of "from"'s open orders move to
 *  "into", cover counts sum, and "from" closes (completed) — freeing its
 *  table via idx_bookings_open_table_session the same way "Mark table free"
 *  already does. */
export async function mergeTablesCore(
  tx: Db,
  ctx: { tenantId: string; membershipId: string | null },
  input: MergeTablesInput,
): Promise<{ movedOrderCount: number }> {
  if (input.intoBookingId === input.fromBookingId) {
    throw new BookingError('Pick two different tables to merge.')
  }

  // Lock both rows in a fixed order (by id) so a concurrent reverse merge
  // can't deadlock against this one.
  const [firstId, secondId] =
    input.intoBookingId < input.fromBookingId
      ? [input.intoBookingId, input.fromBookingId]
      : [input.fromBookingId, input.intoBookingId]
  const first = await lockTableSession(tx, ctx.tenantId, firstId)
  const second = await lockTableSession(tx, ctx.tenantId, secondId)
  const into = first.id === input.intoBookingId ? first : second
  const from = first.id === input.fromBookingId ? first : second

  if (into.branchId !== from.branchId) {
    throw new BookingError('Both tables must be in the same branch to merge.')
  }
  await requireNoLiveInvoice(tx, ctx.tenantId, into.id)
  await requireNoLiveInvoice(tx, ctx.tenantId, from.id)

  const moved = await tx
    .update(orders)
    .set({ bookingId: into.id })
    .where(and(eq(orders.bookingId, from.id), eq(orders.tenantId, ctx.tenantId), eq(orders.status, 'open')))
    .returning({ id: orders.id })

  const combinedCovers = (into.coverCount ?? 0) + (from.coverCount ?? 0)
  await tx
    .update(bookings)
    .set({ coverCount: combinedCovers })
    .where(and(eq(bookings.id, into.id), eq(bookings.tenantId, ctx.tenantId)))

  const now = new Date()
  await tx
    .update(bookings)
    .set({ status: 'completed', completedAt: now })
    .where(and(eq(bookings.id, from.id), eq(bookings.tenantId, ctx.tenantId)))

  await writeAudit(tx, ctx, {
    action: 'merge_tables_into',
    entityType: 'booking',
    entityId: into.id,
    before: { coverCount: into.coverCount },
    after: { coverCount: combinedCovers, mergedFromBookingId: from.id, movedOrderIds: moved.map((o) => o.id) },
  })
  await writeAudit(tx, ctx, {
    action: 'merge_tables_from',
    entityType: 'booking',
    entityId: from.id,
    before: { status: 'checked_in', coverCount: from.coverCount },
    after: { status: 'completed', mergedIntoBookingId: into.id },
  })

  return { movedOrderCount: moved.length }
}

export type SplitTableInput = {
  sourceBookingId: string
  targetResourceId: string
  orderIds: string[]
  coverCount: number
}

/** Split a subset of a table session's open orders onto a brand-new session
 *  on a different (currently free) table — a second, separate tab for the
 *  same visit. Bill-level splitting of one tab's payment is a later
 *  milestone (M18); this only ever moves whole orders. */
export async function splitTableCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string | null },
  input: SplitTableInput,
): Promise<CreatedBooking & { movedOrderCount: number }> {
  const source = await lockTableSession(tx, ctx.tenantId, input.sourceBookingId)
  await requireNoLiveInvoice(tx, ctx.tenantId, input.sourceBookingId)

  // Checked against the LOCKED cover count, not whatever the dialog last
  // rendered: a merge/edit landing between the dialog opening and this
  // running could have changed it. A split needs someone to move AND
  // someone to stay, so anything under 2 has no valid split at all — this
  // is the authoritative gate; SplitTableDialog/FloorView only pre-empt it
  // in the UI so a waiter isn't let all the way to a rejected submit.
  const sourceCovers = source.coverCount ?? 0
  if (sourceCovers < 2) {
    throw new BookingError('This table needs at least 2 guests to split.')
  }

  if (!Number.isInteger(input.coverCount) || input.coverCount < 1) {
    throw new BookingError('Cover count must be a whole number of at least 1.')
  }
  if (input.coverCount >= sourceCovers) {
    throw new BookingError('At least one guest must stay at the original table — that would move everyone.')
  }

  const [customer] = await tx
    .select({
      customerId: bookings.customerId,
      customerName: bookings.customerName,
      customerPhone: bookings.customerPhone,
      customerEmail: bookings.customerEmail,
    })
    .from(bookings)
    .where(and(eq(bookings.id, input.sourceBookingId), eq(bookings.tenantId, ctx.tenantId)))
    .limit(1)

  const [target] = await tx
    .select({ id: resources.id, branchId: resources.branchId, status: resources.status, hourlyRate: resourceTypes.hourlyRate })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(and(eq(resources.tenantId, ctx.tenantId), eq(resources.id, input.targetResourceId)))
    .limit(1)
  if (!target) throw new BookingError('Target table not found.')
  if (target.branchId !== source.branchId) throw new BookingError('Target table belongs to a different branch.')
  // Same table-type convention as seatTableSessionCore — see its comment.
  if (Number(target.hourlyRate) !== 0) {
    throw new BookingError('Target isn’t set up as a table — use a resource type with no hourly rate.')
  }
  if (target.status !== 'available') throw new BookingError('Target table is not available.')

  const bookingNumber = await nextBookingNumber(tx, ctx)
  const now = new Date()

  // idx_bookings_open_table_session rejects this (23505) if the target was
  // seated by someone else a moment ago, same as seatTableSessionCore.
  const [newBooking] = await tx
    .insert(bookings)
    .values({
      tenantId: ctx.tenantId,
      branchId: source.branchId,
      resourceId: target.id,
      coverCount: input.coverCount,
      bookingNumber,
      customerName: customer?.customerName ?? null,
      customerPhone: customer?.customerPhone ?? null,
      customerEmail: customer?.customerEmail ?? null,
      customerId: customer?.customerId ?? null,
      status: 'checked_in',
      source: 'walk_in',
      createdBy: ctx.membershipId,
      checkedInAt: now,
    })
    .returning({ id: bookings.id, confirmationToken: bookings.confirmationToken })

  let movedOrderCount = 0
  if (input.orderIds.length > 0) {
    const moved = await tx
      .update(orders)
      .set({ bookingId: newBooking.id })
      .where(
        and(
          inArray(orders.id, input.orderIds),
          eq(orders.bookingId, input.sourceBookingId),
          eq(orders.tenantId, ctx.tenantId),
          eq(orders.status, 'open'),
        ),
      )
      .returning({ id: orders.id })
    if (moved.length !== input.orderIds.length) {
      throw new BookingError('One of the selected orders is no longer open — reload and try again.')
    }
    movedOrderCount = moved.length
  }

  await tx
    .update(bookings)
    .set({ coverCount: sourceCovers - input.coverCount })
    .where(and(eq(bookings.id, input.sourceBookingId), eq(bookings.tenantId, ctx.tenantId)))

  await writeAudit(tx, ctx, {
    action: 'split_table_from',
    entityType: 'booking',
    entityId: input.sourceBookingId,
    before: { coverCount: sourceCovers },
    after: { coverCount: sourceCovers - input.coverCount, splitToBookingId: newBooking.id, movedOrderIds: input.orderIds },
  })
  await writeAudit(tx, ctx, {
    action: 'split_table_into',
    entityType: 'booking',
    entityId: newBooking.id,
    before: {},
    after: { coverCount: input.coverCount, splitFromBookingId: input.sourceBookingId, resourceId: target.id },
  })

  return { id: newBooking.id, bookingNumber, confirmationToken: newBooking.confirmationToken, movedOrderCount }
}
