'use server'

import { and, eq, gte, lt } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { resources, resourceTypes, workingHours, bookingSlots } from '@/db/schema'
import { requireContext } from '@/lib/auth/guard'
import { availableStartTimes } from '@/lib/booking/availability'
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
