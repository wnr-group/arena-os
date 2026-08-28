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

export type CreatedBooking = { id: string; bookingNumber: string; confirmationToken: string }

export type PricedBookingSlot = {
  resourceId: string
  startsAt: Date
  endsAt: Date
  rateApplied: string
  slotTotal: string
  resourceName: string
  resourceTypeName: string
}

/**
 * Price a set of slots against their resources' effective hourly rate —
 * split out of createBookingCore so a caller can learn a booking's total
 * BEFORE creating it (the public pay-now flow, lib/actions/public-booking.ts,
 * needs this to decide how much to charge online) without a second,
 * drifting copy of the rate lookup.
 */
export async function priceBookingSlots(
  tx: Db,
  ctx: { tenantId: string },
  input: { branchId: string; slots: CreateBookingSlotInput[] },
): Promise<{ subtotal: number; slots: PricedBookingSlot[] }> {
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
  const slots = input.slots.map((s) => {
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

  return { subtotal, slots }
}

/**
 * Booking number: BK-YYYYMMDD-NNN, sequential per tenant per creation day.
 * Shared by createBookingCore (timed bookings) and seatTableSessionCore
 * (table sessions) so the two numbering schemes can never drift apart.
 */
async function nextBookingNumber(tx: Db, ctx: { tenantId: string; timezone: string }): Promise<string> {
  const compact = todayInZone(ctx.timezone).replace(/-/g, '')
  const prefix = `BK-${compact}`
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(bookings)
    .where(and(eq(bookings.tenantId, ctx.tenantId), like(bookings.bookingNumber, `${prefix}-%`)))
  return `${prefix}-${String(Number(n) + 1).padStart(3, '0')}`
}

export async function createBookingCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string | null },
  input: CreateBookingInput,
): Promise<CreatedBooking> {
  const { subtotal, slots: slotRows } = await priceBookingSlots(tx, ctx, {
    branchId: input.branchId,
    slots: input.slots,
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

  const bookingNumber = await nextBookingNumber(tx, ctx)

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
 * time window to price or exclude on, so `bookings.resource_id` (0064) links
 * it to its table directly, and the booking starts life already
 * `checked_in` — a party is, definitionally, present the moment they're
 * seated. Concurrent double-seating of the same table is rejected by the DB
 * (idx_bookings_open_table_session, a partial unique index — see 0064), not
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
    .select({ id: resources.id, branchId: resources.branchId, status: resources.status })
    .from(resources)
    .where(and(eq(resources.tenantId, ctx.tenantId), eq(resources.id, input.resourceId)))
    .limit(1)
  if (!resource) throw new BookingError('Table not found.')
  if (resource.branchId !== input.branchId) {
    throw new BookingError('Table belongs to a different branch.')
  }
  if (resource.status !== 'available') throw new BookingError('This table is not available.')

  const customerId = await resolveBookingCustomer(tx, ctx.tenantId, {
    phone: input.customerPhone,
    name: input.customerName,
    email: input.customerEmail,
  })

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
      customerName: input.customerName || null,
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
