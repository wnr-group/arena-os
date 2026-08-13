/**
 * Placing a booking — the transactional core shared by the staff action
 * (lib/actions/bookings.ts, via withUser) and the public booking action
 * (lib/actions/public-booking.ts, via withPublicTenant). Takes a `tx` and an
 * explicit ctx, exactly like lib/orders/service.ts:createOrderCore — the
 * caller decides how the tenant/identity was established.
 */
import 'server-only'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { resources, resourceTypes, bookings, bookingSlots } from '@/db/schema'
import { durationHours } from './availability'
import { todayInZone } from './time'
import { resolveBookingCustomer } from './customer'

type Db = NodePgDatabase<typeof schema>

/** Booking rule violations the caller is allowed to show verbatim. */
export class BookingError extends Error {}

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
}

export type CreatedBooking = { id: string; bookingNumber: string }

export async function createBookingCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string | null },
  input: CreateBookingInput,
): Promise<CreatedBooking> {
  for (const s of input.slots) {
    if (new Date(s.endsAt) <= new Date(s.startsAt)) {
      throw new BookingError('Each slot must end after it starts.')
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
      rateOverride: resources.hourlyRateOverride,
    })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(and(eq(resources.tenantId, ctx.tenantId), inArray(resources.id, ids)))

  const byId = new Map(rows.map((r) => [r.id, r]))
  if (byId.size !== ids.length) throw new BookingError('One or more resources were not found.')
  for (const r of rows) {
    if (r.branchId !== input.branchId) throw new BookingError('A resource belongs to a different branch.')
  }

  // Price each slot from a snapshot of the effective rate.
  let subtotal = 0
  const slotRows = input.slots.map((s) => {
    const r = byId.get(s.resourceId)!
    const rate = Number(r.rateOverride ?? r.typeRate)
    const hours = durationHours(new Date(s.startsAt), new Date(s.endsAt))
    const total = rate * hours
    subtotal += total
    return {
      resourceId: s.resourceId,
      startsAt: new Date(s.startsAt),
      endsAt: new Date(s.endsAt),
      rateApplied: rate.toFixed(2),
      slotTotal: total.toFixed(2),
      resourceName: r.name,
      resourceTypeName: r.typeName,
    }
  })

  const total = Math.max(0, subtotal - input.discount)

  // Attach the booking to the customer directory so it shows on their
  // profile. Same transaction as the booking, so the two commit together.
  // Returns null when there's no usable phone — see resolveBookingCustomer.
  const customerId = await resolveBookingCustomer(tx, ctx.tenantId, {
    phone: input.customerPhone,
    name: input.customerName,
    email: input.customerEmail,
  })

  // Booking number: BK-YYYYMMDD-NNN, sequential per tenant per creation day.
  const compact = todayInZone(ctx.timezone).replace(/-/g, '')
  const prefix = `BK-${compact}`
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(bookings)
    .where(and(eq(bookings.tenantId, ctx.tenantId), like(bookings.bookingNumber, `${prefix}-%`)))
  const bookingNumber = `${prefix}-${String(Number(n) + 1).padStart(3, '0')}`

  const [booking] = await tx
    .insert(bookings)
    .values({
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      bookingNumber,
      customerName: input.customerName || null,
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
    })
    .returning({ id: bookings.id })

  // Insert slots — the exclusion constraint rejects any overlap atomically.
  await tx.insert(bookingSlots).values(
    slotRows.map((s) => ({
      tenantId: ctx.tenantId,
      bookingId: booking.id,
      ...s,
    })),
  )

  return { id: booking.id, bookingNumber }
}
