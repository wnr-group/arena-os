'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { resources, resourceTypes, bookings, bookingSlots } from '@/db/schema'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { durationHours } from '@/lib/booking/availability'
import { todayInZone } from '@/lib/booking/time'
import { resolveBookingCustomer } from '@/lib/booking/customer'
import { cancelOpenOrdersForBooking } from '@/lib/orders/service'

type CreateResult = { error?: string; bookingId?: string; bookingNumber?: string }
type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  // 23P01 = exclusion_violation: the exclusion constraint caught an overlap.
  if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23P01') {
    return { error: 'That time was just taken for one of the selected resources. Please pick another slot.' }
  }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

const createInput = z.object({
  branchId: z.string().uuid(),
  customerName: z.string().trim().optional(),
  customerPhone: z.string().trim().optional(),
  customerEmail: z.string().trim().email().optional().or(z.literal('')),
  notes: z.string().trim().optional(),
  source: z.enum(['walk_in', 'staff', 'online']).default('staff'),
  discount: z.coerce.number().min(0).default(0),
  deposit: z.coerce.number().min(0).default(0),
  slots: z
    .array(
      z.object({
        resourceId: z.string().uuid(),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
      }),
    )
    .min(1, 'Add at least one resource slot'),
})

export async function createBooking(input: z.input<typeof createInput>): Promise<CreateResult> {
  try {
    const ctx = await requireContext()
    const v = createInput.parse(input)

    for (const s of v.slots) {
      if (new Date(s.endsAt) <= new Date(s.startsAt)) {
        return { error: 'Each slot must end after it starts.' }
      }
    }

    const result = await withUser(ctx.user.id, async (tx) => {
      // Load the referenced resources + their type (name + effective rate).
      const ids = [...new Set(v.slots.map((s) => s.resourceId))]
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
        .where(and(eq(resources.tenantId, ctx.tenant.id), inArray(resources.id, ids)))

      const byId = new Map(rows.map((r) => [r.id, r]))
      if (byId.size !== ids.length) throw new Error('One or more resources were not found.')
      for (const r of rows) {
        if (r.branchId !== v.branchId) throw new Error('A resource belongs to a different branch.')
      }

      // Price each slot from a snapshot of the effective rate.
      let subtotal = 0
      const slotRows = v.slots.map((s) => {
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

      const total = Math.max(0, subtotal - v.discount)

      // Attach the booking to the customer directory so it shows on their
      // profile. Same transaction as the booking, so the two commit together.
      // Returns null when there's no usable phone — see resolveBookingCustomer.
      const customerId = await resolveBookingCustomer(tx, ctx.tenant.id, {
        phone: v.customerPhone,
        name: v.customerName,
        email: v.customerEmail,
      })

      // Booking number: BK-YYYYMMDD-NNN, sequential per tenant per creation day.
      const compact = todayInZone(ctx.tenant.timezone).replace(/-/g, '')
      const prefix = `BK-${compact}`
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(bookings)
        .where(and(eq(bookings.tenantId, ctx.tenant.id), like(bookings.bookingNumber, `${prefix}-%`)))
      const bookingNumber = `${prefix}-${String(Number(n) + 1).padStart(3, '0')}`

      const [booking] = await tx
        .insert(bookings)
        .values({
          tenantId: ctx.tenant.id,
          branchId: v.branchId,
          bookingNumber,
          customerName: v.customerName || null,
          customerPhone: v.customerPhone || null,
          customerEmail: v.customerEmail || null,
          customerId,
          status: 'confirmed',
          source: v.source,
          subtotal: subtotal.toFixed(2),
          discount: v.discount.toFixed(2),
          total: total.toFixed(2),
          deposit: v.deposit.toFixed(2),
          notes: v.notes || null,
          createdBy: ctx.membershipId,
        })
        .returning({ id: bookings.id })

      // Insert slots — the exclusion constraint rejects any overlap atomically.
      await tx.insert(bookingSlots).values(
        slotRows.map((s) => ({
          tenantId: ctx.tenant.id,
          bookingId: booking.id,
          ...s,
        })),
      )

      return { id: booking.id, bookingNumber }
    })

    revalidatePath('/bookings')
    return { bookingId: result.id, bookingNumber: result.bookingNumber }
  } catch (e) {
    return fail(e)
  }
}

type BookingStatus = 'confirmed' | 'checked_in' | 'completed' | 'cancelled' | 'no_show'

export async function setBookingStatus(id: string, status: BookingStatus): Promise<Result> {
  try {
    const ctx = await requireContext()
    const now = new Date()
    const set: Partial<typeof bookings.$inferInsert> = { status }
    if (status === 'checked_in') set.checkedInAt = now
    else if (status === 'completed') set.completedAt = now
    else if (status === 'cancelled') set.cancelledAt = now

    await withUser(ctx.user.id, async (tx) => {
      await tx.update(bookings).set(set).where(and(eq(bookings.id, id), eq(bookings.tenantId, ctx.tenant.id)))

      // Cancelling a booking must not leave the kitchen cooking for it, or a
      // food order sitting there waiting to be billed for a booking that
      // never happened — same transaction, so the booking and its orders
      // cancel together or not at all.
      if (status === 'cancelled') {
        await cancelOpenOrdersForBooking(tx, { tenantId: ctx.tenant.id }, id)
      }
    })
    revalidatePath('/bookings')
    revalidatePath('/kitchen')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function cancelBooking(id: string): Promise<Result> {
  return setBookingStatus(id, 'cancelled')
}
