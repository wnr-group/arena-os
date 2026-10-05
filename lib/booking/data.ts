import 'server-only'
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { advancePaidTotals } from './advance-ledger'
import {
  resourceTypes,
  resources,
  resourceSetups,
  holidayRates,
  workingHours,
  bookings,
  bookingSlots,
  taxRates,
} from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { addDays, zonedTimeToUtc } from './time'

// Re-exported so every existing `@/lib/booking/data` import site is unchanged.
export { addDays }

/** Resource types joined with their (optional) tax rate — same shape as listMenuItems. */
export function listResourceTypes(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: resourceTypes.id,
        tenantId: resourceTypes.tenantId,
        name: resourceTypes.name,
        description: resourceTypes.description,
        hourlyRate: resourceTypes.hourlyRate,
        weekendRate: resourceTypes.weekendRate,
        bufferMinutes: resourceTypes.bufferMinutes,
        capacity: resourceTypes.capacity,
        color: resourceTypes.color,
        imageUrl: resourceTypes.imageUrl,
        taxRateId: resourceTypes.taxRateId,
        taxRateName: taxRates.name,
        taxPercent: taxRates.percent,
        pricingMode: resourceTypes.pricingMode,
        minPlayers: resourceTypes.minPlayers,
        includedPlayers: resourceTypes.includedPlayers,
        extraPlayerRate: resourceTypes.extraPlayerRate,
        extraPlayerWeekendRate: resourceTypes.extraPlayerWeekendRate,
        isActive: resourceTypes.isActive,
        createdAt: resourceTypes.createdAt,
        updatedAt: resourceTypes.updatedAt,
      })
      .from(resourceTypes)
      .leftJoin(taxRates, eq(taxRates.id, resourceTypes.taxRateId))
      .where(eq(resourceTypes.tenantId, ctx.tenant.id))
      .orderBy(asc(resourceTypes.name)),
  )
}

/** Resources for a branch, joined with their type (name + effective rate). */
export function listResources(ctx: ActiveContext, branchId: string) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: resources.id,
        name: resources.name,
        status: resources.status,
        sortOrder: resources.sortOrder,
        resourceTypeId: resources.resourceTypeId,
        typeName: resourceTypes.name,
        color: resourceTypes.color,
        bufferMinutes: resourceTypes.bufferMinutes,
        typeCapacity: resourceTypes.capacity,
        typeRate: resourceTypes.hourlyRate,
        pricingMode: resourceTypes.pricingMode,
        minPlayers: resourceTypes.minPlayers,
        includedPlayers: resourceTypes.includedPlayers,
        extraPlayerRate: resourceTypes.extraPlayerRate,
        rateOverride: resources.hourlyRateOverride,
        imageUrl: resources.imageUrl,
        description: resources.description,
        typeImageUrl: resourceTypes.imageUrl,
        typeDescription: resourceTypes.description,
        qrToken: resources.qrToken,
      })
      .from(resources)
      .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
      .where(and(eq(resources.tenantId, ctx.tenant.id), eq(resources.branchId, branchId)))
      .orderBy(asc(resources.sortOrder), asc(resources.name)),
  )
}

/**
 * A branch's resource_setups (M24 #3) — every named setup on every resource
 * in this branch, active or not (the settings editor manages both), for the
 * units settings page's per-unit "Setups" editor. Grouped by resourceId on
 * the client; ordering here just needs to be stable within a resource.
 */
export function listResourceSetups(ctx: ActiveContext, branchId: string) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: resourceSetups.id,
        resourceId: resourceSetups.resourceId,
        name: resourceSetups.name,
        rate: resourceSetups.rate,
        rateUnit: resourceSetups.rateUnit,
        isActive: resourceSetups.isActive,
        sortOrder: resourceSetups.sortOrder,
      })
      .from(resourceSetups)
      .innerJoin(resources, eq(resources.id, resourceSetups.resourceId))
      .where(and(eq(resourceSetups.tenantId, ctx.tenant.id), eq(resources.branchId, branchId)))
      .orderBy(asc(resourceSetups.sortOrder), asc(resourceSetups.name)),
  )
}

/**
 * A tenant's holiday_rates (M27 #1/#3) — every configured (resourceTypeId,
 * date, rate) entry, tenant-wide (resource types aren't branch-scoped, same
 * as listResourceTypes above). For the resource-types settings page's
 * per-type "Holiday rates" editor, grouped by resourceTypeId on the client.
 */
export function listHolidayRates(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: holidayRates.id,
        resourceTypeId: holidayRates.resourceTypeId,
        date: holidayRates.date,
        rate: holidayRates.rate,
      })
      .from(holidayRates)
      .where(eq(holidayRates.tenantId, ctx.tenant.id))
      .orderBy(asc(holidayRates.date)),
  )
}

export function getWorkingHours(ctx: ActiveContext, branchId: string) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select()
      .from(workingHours)
      .where(and(eq(workingHours.tenantId, ctx.tenant.id), eq(workingHours.branchId, branchId)))
      .orderBy(asc(workingHours.dayOfWeek)),
  )
}

/**
 * Tables for a branch (M17 #1) — resources whose type carries no hourly rate,
 * the 0003 convention a "Table" resource type follows (see 0071_table_sessions.sql)
 * — left-joined to whichever open (confirmed/checked_in) table session, if any,
 * currently occupies each one. A resource with no matching row here is free.
 */
export function listTables(ctx: ActiveContext, branchId: string) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: resources.id,
        name: resources.name,
        status: resources.status,
        sortOrder: resources.sortOrder,
        typeName: resourceTypes.name,
        color: resourceTypes.color,
        bookingId: bookings.id,
        bookingNumber: bookings.bookingNumber,
        bookingStatus: bookings.status,
        coverCount: bookings.coverCount,
        customerName: bookings.customerName,
        customerPhone: bookings.customerPhone,
        checkedInAt: bookings.checkedInAt,
        billRequestedAt: bookings.billRequestedAt,
      })
      .from(resources)
      .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
      .leftJoin(
        bookings,
        and(
          eq(bookings.resourceId, resources.id),
          eq(bookings.tenantId, ctx.tenant.id),
          inArray(bookings.status, ['confirmed', 'checked_in']),
        ),
      )
      .where(
        and(
          eq(resources.tenantId, ctx.tenant.id),
          eq(resources.branchId, branchId),
          eq(resourceTypes.hourlyRate, '0'),
        ),
      )
      .orderBy(asc(resources.sortOrder), asc(resources.name)),
  )
}

/**
 * Booking slots for a branch on a given local date, with booking info.
 *
 * OVERLAP, not "starts on this day". A booking running 22:00→02:00 occupies its
 * resource on BOTH days, so it belongs on both timelines; filtering on
 * startsAt alone hid it from the second one and left the page showing a table
 * as free while the availability picker — which does test overlap — refused to
 * book it. Same predicate, same reason, as lib/actions/availability.ts.
 *
 * A slot that carries over therefore appears on each day it touches. The
 * timeline positions it by its portion WITHIN the displayed day (see
 * BookingsView), so it renders flush to the left edge rather than at the hour
 * it originally started.
 *
 * M21: an open-tab walk-in's slot has no ends_at until checkout — it used to
 * be excluded here entirely, which meant a walk-in vanished from both the
 * timeline and the Bookings table the instant it was checked in, with
 * nothing anywhere on this page to show it existed. `endsAt` is returned as
 * `null` for exactly that case (still active, no committed end yet) —
 * BookingsView renders it as an open-ended "Ongoing" bar instead of
 * inheriting the fixed-interval layout every other slot gets. Every other
 * slot (a normal reserved booking, or a timed walk-in, both of which always
 * have a real endsAt) is completely unaffected.
 *
 * NOT filtered to `active` slots. trg_bookings_sync_slots (0003) flips a slot's
 * `active` to false the moment its booking is cancelled or marked no-show — the
 * flag exists so a freed resource can be rebooked (the exclusion constraint only
 * blocks overlap among active slots), not to hide the booking's history. This
 * used to filter on `active = true`, which meant the instant staff cancelled a
 * booking it vanished from this query entirely — including from the Bookings
 * page's own "Cancelled" status filter, the one screen whose whole job is to
 * show it. `active` is returned instead so BookingsView's Timeline (which
 * really does mean "what is occupying this resource right now") can filter
 * cancelled/no-show slots out of the resource bars, while the Bookings table
 * keeps every status.
 */
export async function listDayBookings(ctx: ActiveContext, branchId: string, dateStr: string, tz: string) {
  const dayStart = zonedTimeToUtc(dateStr, '00:00', tz)
  const dayEnd = zonedTimeToUtc(addDays(dateStr, 1), '00:00', tz)

  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        slotId: bookingSlots.id,
        resourceId: bookingSlots.resourceId,
        startsAt: bookingSlots.startsAt,
        endsAt: bookingSlots.endsAt,
        slotTotal: bookingSlots.slotTotal,
        active: bookingSlots.active,
        bookingId: bookings.id,
        bookingNumber: bookings.bookingNumber,
        customerName: bookings.customerName,
        customerPhone: bookings.customerPhone,
        status: bookings.status,
        source: bookings.source,
        total: bookings.total,
        deposit: bookings.deposit,
        cancellationReason: bookings.cancellationReason,
        // M26 #5: cash collected before this booking existed (M26 #1/#4) —
        // '0.00' for every non-gaming_cafe tenant (server-refused at
        // creation) and every booking with nothing collected upfront. Lets
        // BookingsView show a live "Part paid" indicator, before any bill
        // exists, once sum(active slot_total) outgrows it.
        // M28 #4: entered after the fact (backdated entry) + when it was entered.
        backdated: bookings.backdated,
        bookingCreatedAt: bookings.createdAt,
      })
      .from(bookingSlots)
      .innerJoin(bookings, eq(bookings.id, bookingSlots.bookingId))
      .where(
        and(
          eq(bookingSlots.tenantId, ctx.tenant.id),
          eq(bookings.branchId, branchId),
          lt(bookingSlots.startsAt, dayEnd),
          // An open-tab walk-in (null ends_at) is still genuinely occupying
          // its resource — kept in this set rather than filtered out as if
          // it had already ended (same reasoning as the availability
          // queries' isNull(...) branch, see lib/actions/availability.ts).
          or(isNull(bookingSlots.endsAt), gt(bookingSlots.endsAt, dayStart)),
        ),
      )
      .orderBy(asc(bookingSlots.startsAt))

    // M26 #5 follow-up (CodeRabbit review): a booking's slots aren't
    // necessarily confined to one calendar day — createBookingCore only
    // rejects overlaps on the SAME resource, so a multi-resource booking can
    // legitimately have active slots on different days. Summing slotTotal
    // off the day-scoped rows above (what BookingsView used to do) would
    // then under-count a booking's true known total for any day that isn't
    // the "biggest" one, disagreeing with unbilledAdvanceCheck's own
    // booking-wide sum (lib/booking/service.ts) and showing a live "Part
    // paid" gap that's wrong. Batch-loaded here — one extra query for the
    // whole call, not one per booking, same transaction — and merged onto
    // every row of that booking, same "true total repeated on every row"
    // shape advancePaid/total/deposit above already use.
    const bookingIds = [...new Set(rows.map((r) => r.bookingId))]
    const totalRows =
      bookingIds.length > 0
        ? await tx
            .select({
              bookingId: bookingSlots.bookingId,
              total: sql<string>`coalesce(sum(${bookingSlots.slotTotal}) filter (where ${bookingSlots.active}), 0)::text`,
            })
            .from(bookingSlots)
            .where(and(eq(bookingSlots.tenantId, ctx.tenant.id), inArray(bookingSlots.bookingId, bookingIds)))
            .groupBy(bookingSlots.bookingId)
        : []
    const totalByBooking = new Map(totalRows.map((t) => [t.bookingId, t.total]))
    // M30 #4: the advance collected, summed live from the ledger (one grouped query).
    const advanceByBooking = await advancePaidTotals(tx, ctx.tenant.id, bookingIds)

    return rows.map((r) => ({
      ...r,
      // M26 #5: the booking's TRUE known total — sum of slot_total across
      // EVERY active slot of this booking, tenant-wide, not just the ones
      // overlapping the viewed day. This is what BookingsView's advance-gap
      // check must use instead of summing slotTotal itself.
      bookingActiveSlotTotal: totalByBooking.get(r.bookingId) ?? '0.00',
      advancePaid: advanceByBooking.get(r.bookingId) ?? '0.00',
    }))
  })
}
