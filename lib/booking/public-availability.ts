import 'server-only'
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { branches, resourceTypes, resources, workingHours, bookingSlots } from '@/db/schema'
import { availableStartTimes, type Interval } from './availability'
import { weekdayInZone, zonedTimeToUtc } from './time'
import { getActiveBookingForResource } from './attribution'

export type PublicBranch = { id: string; name: string; address: string | null; phone: string | null }

/** The branch a stranger books at — the tenant's primary active branch, same
 * convention app/(app)/kitchen/page.tsx uses for the staff dashboard. */
export async function getPublicBranch(tenantId: string): Promise<PublicBranch | null> {
  const [branch] = await withPublicTenant(tenantId, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name, address: branches.address, phone: branches.phone })
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
  imageUrl: string | null
  hourlyRate: string
  resources: { id: string; name: string }[]
}

/**
 * The bookable catalogue for one branch, grouped by type — names, seat
 * capacity, the display image and hourly rate (shown on the browse-grid
 * cards so a customer can gauge cost before picking a type).
 */
export async function getPublicResourceTypes(tenantId: string, branchId: string): Promise<PublicResourceType[]> {
  const rows = await withPublicTenant(tenantId, (tx) =>
    tx
      .select({
        resourceTypeId: resourceTypes.id,
        resourceTypeName: resourceTypes.name,
        description: resourceTypes.description,
        capacity: resourceTypes.capacity,
        imageUrl: resourceTypes.imageUrl,
        hourlyRate: resourceTypes.hourlyRate,
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
        imageUrl: row.imageUrl,
        hourlyRate: row.hourlyRate,
        resources: [],
      }
      byType.set(row.resourceTypeId, type)
    }
    type.resources.push({ id: row.resourceId, name: row.resourceName })
  }
  return [...byType.values()]
}

export type PublicResourceTypeDetail = {
  id: string
  name: string
  description: string | null
  imageUrl: string | null
  capacity: number | null
  hourlyRate: string
}

/**
 * One resource type by id, for the type-level booking page (/book-type/[id])
 * — a customer books "PS5 Station", not a specific unit; the actual unit is
 * assigned automatically at slot-selection time (see
 * getPublicAvailableStartsForType below). Unlike getPublicResourceTypes
 * (the browse-grid list), this exposes the hourly rate — the booking page
 * needs a price before the customer commits, same discipline getPublicResource
 * already follows for single-unit bookings.
 */
export async function getPublicResourceType(
  tenantId: string,
  resourceTypeId: string,
): Promise<PublicResourceTypeDetail | null> {
  const [row] = await withPublicTenant(tenantId, (tx) =>
    tx
      .select({
        id: resourceTypes.id,
        name: resourceTypes.name,
        description: resourceTypes.description,
        imageUrl: resourceTypes.imageUrl,
        capacity: resourceTypes.capacity,
        hourlyRate: resourceTypes.hourlyRate,
      })
      .from(resourceTypes)
      .where(and(eq(resourceTypes.id, resourceTypeId), eq(resourceTypes.tenantId, tenantId), eq(resourceTypes.isActive, true)))
      .limit(1),
  )
  return row ?? null
}

const DEFAULT_HOURS = { openTime: '10:00', closeTime: '22:00', isClosed: false }

export type PublicWorkingHours = { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean }

/**
 * The branch's full weekly schedule, Sun(0)..Sat(6) — for the "Opening
 * Hours" website section. Any day with no row (never configured) falls back
 * to DEFAULT_HOURS, same as the slot-math readers below rather than being
 * omitted, so the table always has exactly seven rows.
 */
export async function getPublicWorkingHours(tenantId: string, branchId: string): Promise<PublicWorkingHours[]> {
  const rows = await withPublicTenant(tenantId, (tx) =>
    tx
      .select({
        dayOfWeek: workingHours.dayOfWeek,
        openTime: workingHours.openTime,
        closeTime: workingHours.closeTime,
        isClosed: workingHours.isClosed,
      })
      .from(workingHours)
      .where(and(eq(workingHours.tenantId, tenantId), eq(workingHours.branchId, branchId)))
      .orderBy(asc(workingHours.dayOfWeek)),
  )
  const byDay = new Map(rows.map((r) => [r.dayOfWeek, r]))
  return Array.from({ length: 7 }, (_, dayOfWeek) => byDay.get(dayOfWeek) ?? { dayOfWeek, ...DEFAULT_HOURS })
}

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
 * (see the zod schema in lib/actions/public-booking.ts) — this trusts its
 * input exactly like the staff version trusts its own zod-parsed input.
 *
 * Returns both `starts` (bookable now) and `allStarts` (every candidate slot
 * the working hours allow, ignoring existing bookings) so a caller can render
 * a full day grid with unavailable times shown-but-disabled, not just omitted
 * — the resource-booking page (AROS) wants that distinction visible.
 */
export async function getPublicAvailableStarts(
  input: PublicAvailabilityInput,
): Promise<{ starts: Date[]; allStarts: Date[]; isClosed: boolean } | { error: string }> {
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

    const resolvedHours = hours ?? DEFAULT_HOURS
    const starts = availableStartTimes(date, timeZone, resolvedHours, existing, {
      durationMinutes,
      slotMinutes: 30,
      bufferMinutes: res.buffer,
    })
    const allStarts = availableStartTimes(date, timeZone, resolvedHours, [], {
      durationMinutes,
      slotMinutes: 30,
    })

    return { starts, allStarts, isClosed: resolvedHours.isClosed }
  })
}

export type PublicResource = {
  id: string
  name: string
  description: string | null
  imageUrl: string | null
  hourlyRate: string
  capacity: number | null
  resourceTypeId: string
  resourceTypeName: string
}

/**
 * One specific bookable unit — the actual thing a customer reserves, not
 * just its type (contrast getPublicResourceTypes, which groups units under
 * their type and deliberately hides pricing). The resource-booking page
 * needs a price before the customer commits, so this surface exposes the
 * effective hourly rate (the resource's own override, else its type's rate)
 * — everything else stays the same "no cost/tax internals" discipline.
 */
export async function getPublicResource(tenantId: string, resourceId: string): Promise<PublicResource | null> {
  const [row] = await withPublicTenant(tenantId, (tx) =>
    tx
      .select({
        id: resources.id,
        name: resources.name,
        description: resources.description,
        imageUrl: resources.imageUrl,
        hourlyRateOverride: resources.hourlyRateOverride,
        resourceTypeId: resourceTypes.id,
        resourceTypeName: resourceTypes.name,
        typeHourlyRate: resourceTypes.hourlyRate,
        typeImageUrl: resourceTypes.imageUrl,
        capacity: resourceTypes.capacity,
      })
      .from(resources)
      .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
      .where(
        and(
          eq(resources.id, resourceId),
          eq(resources.tenantId, tenantId),
          eq(resources.status, 'available'),
          eq(resourceTypes.isActive, true),
        ),
      )
      .limit(1),
  )
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    imageUrl: row.imageUrl ?? row.typeImageUrl,
    hourlyRate: row.hourlyRateOverride ?? row.typeHourlyRate,
    capacity: row.capacity,
    resourceTypeId: row.resourceTypeId,
    resourceTypeName: row.resourceTypeName,
  }
}

export type PublicStation = { resource: PublicResource; branchId: string; bookingId: string | null }

/**
 * What a QR code resolves to — the station itself, plus the booking (if any)
 * currently occupying it, resolved in the same transaction via
 * getActiveBookingForResource. Tenant-safe by construction: scoped both by
 * the (tenant_id, qr_token) unique constraint and by resources_public_select's
 * own tenant_id = current_public_tenant_id() check, same discipline as the
 * booking confirmation token lookup on app/(public)/b/[token].
 */
export async function getPublicStation(tenantId: string, qrToken: string): Promise<PublicStation | null> {
  return withPublicTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: resources.id,
        branchId: resources.branchId,
        name: resources.name,
        description: resources.description,
        imageUrl: resources.imageUrl,
        hourlyRateOverride: resources.hourlyRateOverride,
        resourceTypeId: resourceTypes.id,
        resourceTypeName: resourceTypes.name,
        typeHourlyRate: resourceTypes.hourlyRate,
        typeImageUrl: resourceTypes.imageUrl,
        capacity: resourceTypes.capacity,
      })
      .from(resources)
      .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
      .where(
        and(
          eq(resources.qrToken, qrToken),
          eq(resources.tenantId, tenantId),
          eq(resources.status, 'available'),
          eq(resourceTypes.isActive, true),
        ),
      )
      .limit(1)
    if (!row) return null

    const bookingId = await getActiveBookingForResource(tx, tenantId, row.id)
    return {
      branchId: row.branchId,
      resource: {
        id: row.id,
        name: row.name,
        description: row.description,
        imageUrl: row.imageUrl ?? row.typeImageUrl,
        hourlyRate: row.hourlyRateOverride ?? row.typeHourlyRate,
        capacity: row.capacity,
        resourceTypeId: row.resourceTypeId,
        resourceTypeName: row.resourceTypeName,
      },
      bookingId,
    }
  })
}

export type PublicTypeAvailabilityInput = {
  tenantId: string
  branchId: string
  resourceTypeId: string
  timeZone: string
  date: string
  durationMinutes: number
}

export type PublicTypeSlot = { start: Date; resourceId: string }

/**
 * Same math as getPublicAvailableStarts, but for a whole resource TYPE — the
 * shape the booking wizard actually needs: a customer picks "PS5 Station",
 * not a specific unit. For each candidate start time, the first (lowest
 * sort_order) resource of the type still free at that time is the one
 * offered; createPublicBooking (lib/actions/public-booking.ts) re-validates
 * that exact resource+slot at submit time, so a stale read here can only
 * ever fail closed (the exclusion constraint), never double-book.
 */
export async function getPublicAvailableStartsForType(
  input: PublicTypeAvailabilityInput,
): Promise<{ starts: PublicTypeSlot[] } | { error: string }> {
  const { tenantId, branchId, resourceTypeId, timeZone, date, durationMinutes } = input

  return withPublicTenant(tenantId, async (tx) => {
    const resourceRows = await tx
      .select({ id: resources.id, buffer: resourceTypes.bufferMinutes })
      .from(resources)
      .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
      .where(
        and(
          eq(resources.resourceTypeId, resourceTypeId),
          eq(resources.tenantId, tenantId),
          eq(resources.branchId, branchId),
          eq(resources.status, 'available'),
        ),
      )
      .orderBy(resources.sortOrder)
    if (resourceRows.length === 0) return { error: 'This is not bookable right now.' }

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

    // First-free-unit-wins, keyed by start-time ISO, so each shown time maps
    // to exactly one resource under the hood.
    const byStart = new Map<string, string>()
    for (const r of resourceRows) {
      const starts = availableStartTimes(date, timeZone, hours ?? DEFAULT_HOURS, existingByResource.get(r.id) ?? [], {
        durationMinutes,
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
      .map(([start, resourceId]) => ({ start: new Date(start), resourceId }))

    return { starts }
  })
}
