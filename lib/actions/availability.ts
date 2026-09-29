'use server'

import { and, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { resources, resourceTypes, holidayRates, workingHours, bookingSlots } from '@/db/schema'
import { requireContext } from '@/lib/auth/guard'
import { availableStartTimes, dayWindow, type Interval } from '@/lib/booking/availability'
import { weekdayInZone, zonedTimeToUtc } from '@/lib/booking/time'
import { resolveDayRate } from '@/lib/booking/rate'
import { loadWeekendDays } from '@/lib/settings/business-profile'

const input = z.object({
  branchId: z.string().uuid(),
  resourceId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: z.coerce.number().int().min(15).max(24 * 60),
})

export type AvailabilityResponse = {
  error?: string
  timeZone?: string
  /** ISO start times that fit. */
  starts?: string[]
  /** Every candidate slot the working hours allow for this duration, ignoring
   * existing bookings/buffers — lets a caller show taken times shown-but-
   * disabled rather than silently dropping them, same as
   * getAvailableStartsForType below and the public booking pages. */
  allStarts?: string[]
  isClosed?: boolean
  /** M27 #4: the effective hourly rate for the SELECTED date — a holiday
   *  rate if one is configured for this resource's type on this date,
   *  otherwise the weekday/weekend rate (lib/booking/rate.ts:resolveDayRate)
   *  — same field, same precedence, same reasoning as
   *  getPublicAvailableStarts' own `rate` (lib/booking/public-availability.ts,
   *  M22 #4): the staff wizard's live estimate (FutureWizard.tsx) prices off
   *  this instead of a static, date-blind rate, so it can never drift from
   *  what createBooking/quoteBooking actually charge once a date is picked. */
  rate?: string
}

const DEFAULT_HOURS = { openTime: '10:00', closeTime: '22:00', isClosed: false, open24h: false }

export async function getAvailableStarts(
  raw: z.input<typeof input>,
): Promise<AvailabilityResponse> {
  try {
    const ctx = await requireContext()
    const v = input.parse(raw)
    const tz = ctx.tenant.timezone
    const dow = weekdayInZone(v.date, tz)

    return await withUser(ctx.user.id, async (tx) => {
      // buffer for this resource comes from its type
      const [res] = await tx
        .select({
          buffer: resourceTypes.bufferMinutes,
          resourceTypeId: resources.resourceTypeId,
          weekdayRate: resources.hourlyRateOverride,
          typeRate: resourceTypes.hourlyRate,
          typeWeekendRate: resourceTypes.weekendRate,
        })
        .from(resources)
        .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
        .where(and(eq(resources.id, v.resourceId), eq(resources.tenantId, ctx.tenant.id)))
      if (!res) return { error: 'Resource not found.' }

      // M27 #4: same precedence/reasoning as getPublicAvailableStarts' own
      // holiday lookup (lib/booking/public-availability.ts) — a holiday rate
      // wins over this whole weekend/weekday estimate, looked up directly
      // against v.date (already the plain calendar date this estimate is
      // FOR, no anchor-instant needed here).
      const [holiday] = await tx
        .select({ rate: holidayRates.rate })
        .from(holidayRates)
        .where(
          and(
            eq(holidayRates.tenantId, ctx.tenant.id),
            eq(holidayRates.resourceTypeId, res.resourceTypeId),
            eq(holidayRates.date, v.date),
          ),
        )
        .limit(1)
      const weekendDays = await loadWeekendDays(tx, ctx.tenant.id)
      const anchor = zonedTimeToUtc(v.date, '12:00', tz)
      const weekdayRate = Number(res.weekdayRate ?? res.typeRate)
      const weekendRate = res.typeWeekendRate === null ? null : Number(res.typeWeekendRate)
      const rate = holiday ? Number(holiday.rate) : resolveDayRate(weekdayRate, weekendRate, anchor, tz, weekendDays)

      const [hours] = await tx
        .select({
          openTime: workingHours.openTime,
          closeTime: workingHours.closeTime,
          isClosed: workingHours.isClosed,
          open24h: workingHours.open24h,
        })
        .from(workingHours)
        .where(and(eq(workingHours.branchId, v.branchId), eq(workingHours.dayOfWeek, dow)))

      const dayStart = zonedTimeToUtc(v.date, '00:00', tz)
      const dayEnd = zonedTimeToUtc(v.date, '00:00', tz)
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)

      const existing = await tx
        .select({ startsAt: bookingSlots.startsAt, endsAt: bookingSlots.endsAt })
        .from(bookingSlots)
        .where(
          and(
            eq(bookingSlots.resourceId, v.resourceId),
            eq(bookingSlots.active, true),
            // OVERLAP, not "starts on this day".
            //
            // Filtering on startsAt alone made every slot that begins BEFORE the
            // day and runs into it invisible here — an overnight booking, or a
            // multi-day hold on a resource. Availability then offered a unit the
            // booking_slots_no_overlap exclusion constraint promptly refused, so
            // the till was told a table was free and the booking failed with
            // "that time was just taken". A second unit of the same type could
            // never be allocated while such a slot sat on it.
            lt(bookingSlots.startsAt, dayEnd),
            // An open-tab walk-in (M21) has no ends_at until checkout but is
            // still genuinely occupying the resource — kept in this set (its
            // synthetic end is clamped to dayEnd below) rather than filtered
            // out as if it had already ended.
            or(isNull(bookingSlots.endsAt), gt(bookingSlots.endsAt, dayStart)),
          ),
        )
        .then((rows) => rows.map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt ?? dayEnd })))

      const resolvedHours = hours ?? DEFAULT_HOURS
      const starts = availableStartTimes(v.date, tz, resolvedHours, existing, {
        durationMinutes: v.durationMinutes,
        slotMinutes: 30,
        bufferMinutes: res.buffer,
      })

      // No buffer here on purpose: a buffer belongs to a booking, and this
      // grid has none to sit beside — same as getAvailableStartsForType.
      const allStarts = availableStartTimes(v.date, tz, resolvedHours, [], {
        durationMinutes: v.durationMinutes,
        slotMinutes: 30,
      })

      return {
        timeZone: tz,
        starts: starts.map((d) => d.toISOString()),
        allStarts: allStarts.map((d) => d.toISOString()),
        isClosed: resolvedHours.isClosed,
        rate: rate.toFixed(2),
      }
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}

const typeInput = z.object({
  branchId: z.string().uuid(),
  resourceTypeId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: z.coerce.number().int().min(15).max(24 * 60),
})

export type TypeAvailabilityResponse = {
  error?: string
  timeZone?: string
  /** Each bookable start time, paired with the specific available unit it
   * would be assigned to — first-free-unit-wins, same rule the public
   * booking flow uses (getPublicAvailableStartsForType). */
  starts?: { startsAt: string; resourceId: string }[]
  /** Every candidate slot the working hours allow for this duration, ignoring
   * existing bookings/buffers — same "full day grid" getPublicAvailableStartsForType
   * returns, so the caller can render taken times shown-but-disabled rather
   * than silently dropping them (matches the public resource booking page). */
  allStarts?: string[]
  isClosed?: boolean
  /** M27 #4: same field, same precedence, as AvailabilityResponse.rate above
   *  — see its own doc comment. */
  rate?: string
}

/**
 * Availability across every unit of a resource type, so staff can pick a
 * type ("PS5 Station") instead of a specific unit — the matching unit is
 * assigned automatically for whichever start time gets picked. createBooking
 * re-validates that exact resource+slot at submit time, so a stale read here
 * can only ever fail closed, never double-book.
 */
export async function getAvailableStartsForType(
  raw: z.input<typeof typeInput>,
): Promise<TypeAvailabilityResponse> {
  try {
    const ctx = await requireContext()
    const v = typeInput.parse(raw)
    const tz = ctx.tenant.timezone
    const dow = weekdayInZone(v.date, tz)

    return await withUser(ctx.user.id, async (tx) => {
      const resourceRows = await tx
        .select({
          id: resources.id,
          buffer: resourceTypes.bufferMinutes,
          typeRate: resourceTypes.hourlyRate,
          typeWeekendRate: resourceTypes.weekendRate,
        })
        .from(resources)
        .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
        .where(
          and(
            eq(resources.resourceTypeId, v.resourceTypeId),
            eq(resources.tenantId, ctx.tenant.id),
            eq(resources.branchId, v.branchId),
            eq(resources.status, 'available'),
          ),
        )
        .orderBy(resources.sortOrder)
      if (resourceRows.length === 0) return { error: 'No available resources of this type.' }

      // M27 #4: type-level booking auto-assigns the first free UNIT of the
      // type, but the price it quotes has always been the TYPE's own rate
      // (same reasoning getPublicAvailableStartsForType's own doc comment
      // gives) — resolving weekday/weekend/holiday the same way, at the type
      // level, keeps that unchanged.
      const [holiday] = await tx
        .select({ rate: holidayRates.rate })
        .from(holidayRates)
        .where(
          and(
            eq(holidayRates.tenantId, ctx.tenant.id),
            eq(holidayRates.resourceTypeId, v.resourceTypeId),
            eq(holidayRates.date, v.date),
          ),
        )
        .limit(1)
      const weekendDays = await loadWeekendDays(tx, ctx.tenant.id)
      const anchor = zonedTimeToUtc(v.date, '12:00', tz)
      const weekdayRate = Number(resourceRows[0].typeRate)
      const weekendRate = resourceRows[0].typeWeekendRate === null ? null : Number(resourceRows[0].typeWeekendRate)
      const rate = holiday ? Number(holiday.rate) : resolveDayRate(weekdayRate, weekendRate, anchor, tz, weekendDays)

      const [hours] = await tx
        .select({
          openTime: workingHours.openTime,
          closeTime: workingHours.closeTime,
          isClosed: workingHours.isClosed,
          open24h: workingHours.open24h,
        })
        .from(workingHours)
        .where(and(eq(workingHours.branchId, v.branchId), eq(workingHours.dayOfWeek, dow)))

      const dayStart = zonedTimeToUtc(v.date, '00:00', tz)
      const dayEnd = zonedTimeToUtc(v.date, '00:00', tz)
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)

      const resourceIds = resourceRows.map((r) => r.id)
      const existingRows = await tx
        .select({ resourceId: bookingSlots.resourceId, startsAt: bookingSlots.startsAt, endsAt: bookingSlots.endsAt })
        .from(bookingSlots)
        .where(
          and(
            inArray(bookingSlots.resourceId, resourceIds),
            eq(bookingSlots.active, true),
            // OVERLAP, not "starts on this day".
            //
            // Filtering on startsAt alone made every slot that begins BEFORE the
            // day and runs into it invisible here — an overnight booking, or a
            // multi-day hold on a resource. Availability then offered a unit the
            // booking_slots_no_overlap exclusion constraint promptly refused, so
            // the till was told a table was free and the booking failed with
            // "that time was just taken". A second unit of the same type could
            // never be allocated while such a slot sat on it.
            lt(bookingSlots.startsAt, dayEnd),
            // An open-tab walk-in (M21) has no ends_at until checkout but is
            // still genuinely occupying the resource — kept in this set (its
            // synthetic end is clamped to dayEnd below) rather than filtered
            // out as if it had already ended.
            or(isNull(bookingSlots.endsAt), gt(bookingSlots.endsAt, dayStart)),
          ),
        )

      const existingByResource = new Map<string, Interval[]>()
      for (const row of existingRows) {
        const list = existingByResource.get(row.resourceId) ?? []
        list.push({ startsAt: row.startsAt, endsAt: row.endsAt ?? dayEnd })
        existingByResource.set(row.resourceId, list)
      }

      const resolvedHours = hours ?? DEFAULT_HOURS
      const byStart = new Map<string, string>()
      for (const r of resourceRows) {
        const starts = availableStartTimes(v.date, tz, resolvedHours, existingByResource.get(r.id) ?? [], {
          durationMinutes: v.durationMinutes,
          slotMinutes: 30,
          bufferMinutes: r.buffer,
        })
        for (const s of starts) {
          const key = s.toISOString()
          if (!byStart.has(key)) byStart.set(key, r.id)
        }
      }

      const starts = [...byStart.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([startsAt, resourceId]) => ({ startsAt, resourceId }))

      // No buffer here on purpose: a buffer belongs to a booking, and this
      // grid has none to sit beside — same as getPublicAvailableStartsForType.
      const allStarts = availableStartTimes(v.date, tz, resolvedHours, [], {
        durationMinutes: v.durationMinutes,
        slotMinutes: 30,
      })

      return {
        timeZone: tz,
        starts,
        allStarts: allStarts.map((d) => d.toISOString()),
        isClosed: resolvedHours.isClosed,
        rate: rate.toFixed(2),
      }
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}

const dayRangeInput = z.object({
  branchId: z.string().uuid(),
  resourceId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

export type DayRangeWindowResponse = {
  error?: string
  /** D1's open instant — the exact "D1 open" boundary daysInRange/priceBookingSlots expect for a per-day setup. */
  startsAt?: string
  /** Dn's close instant — the "Dn close" boundary. */
  endsAt?: string
  /** True if this resource already has an active booking overlapping the window — purely advisory (see below). */
  conflict?: boolean
}

/**
 * Resolves a per-day setup's staff-picked date range (M24 #4) into the exact
 * "D1 open -> Dn close" instants priceBookingSlots/daysInRange already price
 * against (see scripts/test-studio-setups-pricing.ts) — the wizard only ever
 * picks two calendar dates, all open/close-hour math (including open24h)
 * stays server-side, same discipline getAvailableStarts/
 * getAvailableStartsForType already keep for the hourly picker.
 *
 * Also runs a read-only pre-check against this resource's existing active
 * bookings so the wizard can warn before the customer even tries to submit —
 * purely advisory: the DB's exclusion constraint (booking_slots_no_overlap,
 * migration 0003) is still the real guard createBooking relies on, so a race
 * here can only ever fail closed at submit time, never double-book.
 */
export async function getDayRangeWindow(raw: z.input<typeof dayRangeInput>): Promise<DayRangeWindowResponse> {
  try {
    const ctx = await requireContext()
    const v = dayRangeInput.parse(raw)
    if (v.endDate < v.startDate) return { error: 'End date must be on or after the start date.' }
    const tz = ctx.tenant.timezone

    return await withUser(ctx.user.id, async (tx) => {
      const [res] = await tx
        .select({ id: resources.id })
        .from(resources)
        .where(and(eq(resources.id, v.resourceId), eq(resources.tenantId, ctx.tenant.id)))
      if (!res) return { error: 'Resource not found.' }

      const startDow = weekdayInZone(v.startDate, tz)
      const endDow = weekdayInZone(v.endDate, tz)
      const hoursRows = await tx
        .select({
          dayOfWeek: workingHours.dayOfWeek,
          openTime: workingHours.openTime,
          closeTime: workingHours.closeTime,
          isClosed: workingHours.isClosed,
          open24h: workingHours.open24h,
        })
        .from(workingHours)
        .where(and(eq(workingHours.branchId, v.branchId), inArray(workingHours.dayOfWeek, [...new Set([startDow, endDow])])))
      const hoursByDow = new Map(hoursRows.map((h) => [h.dayOfWeek, h]))
      const startHours = hoursByDow.get(startDow) ?? DEFAULT_HOURS
      const endHours = hoursByDow.get(endDow) ?? DEFAULT_HOURS
      if (startHours.isClosed) return { error: `The business is closed on ${v.startDate}. Choose a different start date.` }
      if (endHours.isClosed) return { error: `The business is closed on ${v.endDate}. Choose a different end date.` }

      const startsAt = dayWindow(v.startDate, tz, startHours).open
      const endsAt = dayWindow(v.endDate, tz, endHours).close

      const conflictRows = await tx
        .select({ id: bookingSlots.id })
        .from(bookingSlots)
        .where(
          and(
            eq(bookingSlots.resourceId, v.resourceId),
            eq(bookingSlots.active, true),
            lt(bookingSlots.startsAt, endsAt),
            or(isNull(bookingSlots.endsAt), gt(bookingSlots.endsAt, startsAt)),
          ),
        )
        .limit(1)

      return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), conflict: conflictRows.length > 0 }
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}
