import 'server-only'
import { and, asc, eq, gte, lt } from 'drizzle-orm'
import { withUser } from '@/db'
import {
  resourceTypes,
  resources,
  workingHours,
  bookings,
  bookingSlots,
} from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { addDays, zonedTimeToUtc } from './time'

// Re-exported so every existing `@/lib/booking/data` import site is unchanged.
export { addDays }

export function listResourceTypes(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx.select().from(resourceTypes).where(eq(resourceTypes.tenantId, ctx.tenant.id)).orderBy(asc(resourceTypes.name)),
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
        typeRate: resourceTypes.hourlyRate,
        rateOverride: resources.hourlyRateOverride,
        imageUrl: resources.imageUrl,
        description: resources.description,
        typeImageUrl: resourceTypes.imageUrl,
        typeDescription: resourceTypes.description,
      })
      .from(resources)
      .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
      .where(and(eq(resources.tenantId, ctx.tenant.id), eq(resources.branchId, branchId)))
      .orderBy(asc(resources.sortOrder), asc(resources.name)),
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

/** Active booking slots for a branch on a given local date, with booking info. */
export function listDayBookings(ctx: ActiveContext, branchId: string, dateStr: string, tz: string) {
  const dayStart = zonedTimeToUtc(dateStr, '00:00', tz)
  const dayEnd = zonedTimeToUtc(addDays(dateStr, 1), '00:00', tz)

  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        slotId: bookingSlots.id,
        resourceId: bookingSlots.resourceId,
        startsAt: bookingSlots.startsAt,
        endsAt: bookingSlots.endsAt,
        slotTotal: bookingSlots.slotTotal,
        bookingId: bookings.id,
        bookingNumber: bookings.bookingNumber,
        customerName: bookings.customerName,
        customerPhone: bookings.customerPhone,
        status: bookings.status,
        source: bookings.source,
        total: bookings.total,
        deposit: bookings.deposit,
      })
      .from(bookingSlots)
      .innerJoin(bookings, eq(bookings.id, bookingSlots.bookingId))
      .where(
        and(
          eq(bookingSlots.tenantId, ctx.tenant.id),
          eq(bookings.branchId, branchId),
          eq(bookingSlots.active, true),
          gte(bookingSlots.startsAt, dayStart),
          lt(bookingSlots.startsAt, dayEnd),
        ),
      )
      .orderBy(asc(bookingSlots.startsAt)),
  )
}
