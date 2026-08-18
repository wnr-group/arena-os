'use server'

import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { resources, resourceTypes, workingHours, bookingSlots } from '@/db/schema'
import { requireContext } from '@/lib/auth/guard'
import { availableStartTimes, type Interval } from '@/lib/booking/availability'
import { weekdayInZone, zonedTimeToUtc } from '@/lib/booking/time'

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
}

const DEFAULT_HOURS = { openTime: '10:00', closeTime: '22:00', isClosed: false }

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
        .select({ buffer: resourceTypes.bufferMinutes })
        .from(resources)
        .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
        .where(and(eq(resources.id, v.resourceId), eq(resources.tenantId, ctx.tenant.id)))
      if (!res) return { error: 'Resource not found.' }

      const [hours] = await tx
        .select({
          openTime: workingHours.openTime,
          closeTime: workingHours.closeTime,
          isClosed: workingHours.isClosed,
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
            gte(bookingSlots.startsAt, dayStart),
            lt(bookingSlots.startsAt, dayEnd),
          ),
        )

      const starts = availableStartTimes(v.date, tz, hours ?? DEFAULT_HOURS, existing, {
        durationMinutes: v.durationMinutes,
        slotMinutes: 30,
        bufferMinutes: res.buffer,
      })

      return { timeZone: tz, starts: starts.map((d) => d.toISOString()) }
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
        .select({ id: resources.id, buffer: resourceTypes.bufferMinutes })
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

      const [hours] = await tx
        .select({
          openTime: workingHours.openTime,
          closeTime: workingHours.closeTime,
          isClosed: workingHours.isClosed,
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
            gte(bookingSlots.startsAt, dayStart),
            lt(bookingSlots.startsAt, dayEnd),
          ),
        )

      const existingByResource = new Map<string, Interval[]>()
      for (const row of existingRows) {
        const list = existingByResource.get(row.resourceId) ?? []
        list.push({ startsAt: row.startsAt, endsAt: row.endsAt })
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

      return { timeZone: tz, starts }
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}
