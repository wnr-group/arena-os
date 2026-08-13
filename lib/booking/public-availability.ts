import 'server-only'
import { and, eq, gte, lt } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { branches, resourceTypes, resources, workingHours, bookingSlots } from '@/db/schema'
import { availableStartTimes } from './availability'
import { weekdayInZone, zonedTimeToUtc } from './time'

export type PublicBranch = { id: string; name: string }

/** The branch a stranger books at — the tenant's primary active branch, same
 * convention app/(app)/kitchen/page.tsx uses for the staff dashboard. */
export async function getPublicBranch(tenantId: string): Promise<PublicBranch | null> {
  const [branch] = await withPublicTenant(tenantId, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, tenantId), eq(branches.isPrimary, true), eq(branches.status, 'active')))
      .limit(1),
  )
  return branch ?? null
}

export type PublicResourceType = {
  id: string
  name: string
  description: string | null
  capacity: number | null
  resources: { id: string; name: string }[]
}

/**
 * The bookable catalogue for one branch, grouped by type — names and seat
 * capacity only. No hourly_rate, no buffer_minutes: nothing a stranger picking
 * a slot needs to know, and per the brief, no financial data on this surface.
 */
export async function getPublicResourceTypes(tenantId: string, branchId: string): Promise<PublicResourceType[]> {
  const rows = await withPublicTenant(tenantId, (tx) =>
    tx
      .select({
        resourceTypeId: resourceTypes.id,
        resourceTypeName: resourceTypes.name,
        description: resourceTypes.description,
        capacity: resourceTypes.capacity,
        resourceId: resources.id,
        resourceName: resources.name,
      })
      .from(resourceTypes)
      .innerJoin(
        resources,
        and(
          eq(resources.resourceTypeId, resourceTypes.id),
          eq(resources.branchId, branchId),
          eq(resources.status, 'available'),
        ),
      )
      .where(and(eq(resourceTypes.tenantId, tenantId), eq(resourceTypes.isActive, true)))
      .orderBy(resourceTypes.name, resources.sortOrder),
  )

  const byType = new Map<string, PublicResourceType>()
  for (const row of rows) {
    let type = byType.get(row.resourceTypeId)
    if (!type) {
      type = {
        id: row.resourceTypeId,
        name: row.resourceTypeName,
        description: row.description,
        capacity: row.capacity,
        resources: [],
      }
      byType.set(row.resourceTypeId, type)
    }
    type.resources.push({ id: row.resourceId, name: row.resourceName })
  }
  return [...byType.values()]
}

const DEFAULT_HOURS = { openTime: '10:00', closeTime: '22:00', isClosed: false }

export type PublicAvailabilityInput = {
  tenantId: string
  branchId: string
  resourceId: string
  timeZone: string
  date: string
  durationMinutes: number
}

/**
 * Thin public wrapper over availableStartTimes()/isRangeAvailable() (the pure
 * slot math in ./availability.ts) — same query shape as the staff-only
 * lib/actions/availability.ts:getAvailableStarts, but scoped by an explicit
 * tenantId resolved from the subdomain instead of a logged-in ctx.user.id.
 * Callers are expected to have already validated `date`/`durationMinutes`
 * (see the zod schema in app/(public)/book/page.tsx) — this trusts its input
 * exactly like the staff version trusts its own zod-parsed input.
 */
export async function getPublicAvailableStarts(
  input: PublicAvailabilityInput,
): Promise<{ starts: Date[] } | { error: string }> {
  const { tenantId, branchId, resourceId, timeZone, date, durationMinutes } = input

  return withPublicTenant(tenantId, async (tx) => {
    const [res] = await tx
      .select({ buffer: resourceTypes.bufferMinutes })
      .from(resources)
      .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
      .where(
        and(
          eq(resources.id, resourceId),
          eq(resources.tenantId, tenantId),
          eq(resources.branchId, branchId),
          eq(resources.status, 'available'),
        ),
      )
    if (!res) return { error: 'Resource not found.' }

    const dow = weekdayInZone(date, timeZone)
    const [hours] = await tx
      .select({
        openTime: workingHours.openTime,
        closeTime: workingHours.closeTime,
        isClosed: workingHours.isClosed,
      })
      .from(workingHours)
      .where(and(eq(workingHours.branchId, branchId), eq(workingHours.dayOfWeek, dow)))

    const dayStart = zonedTimeToUtc(date, '00:00', timeZone)
    const dayEnd = zonedTimeToUtc(date, '00:00', timeZone)
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)

    const existing = await tx
      .select({ startsAt: bookingSlots.startsAt, endsAt: bookingSlots.endsAt })
      .from(bookingSlots)
      .where(
        and(
          eq(bookingSlots.resourceId, resourceId),
          eq(bookingSlots.active, true),
          gte(bookingSlots.startsAt, dayStart),
          lt(bookingSlots.startsAt, dayEnd),
        ),
      )

    const starts = availableStartTimes(date, timeZone, hours ?? DEFAULT_HOURS, existing, {
      durationMinutes,
      slotMinutes: 30,
      bufferMinutes: res.buffer,
    })

    return { starts }
  })
}
