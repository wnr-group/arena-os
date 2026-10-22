'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { bookings } from '@/db/schema'
import { requireContext, requireManager, AuthError } from '@/lib/auth/guard'
import { canManageWalkins } from '@/lib/auth/roles'
import { BookingError } from '@/lib/booking/service'
import { isValidPhone } from '@/lib/customers/phone'
import { sweepTenantHolds } from '@/lib/booking/payment-hold'
import { EntitlementError, hasEntitlement, requireEntitlement } from '@/lib/platform/entitlement-guard'
import {
  createReservationCore,
  freeTablesForWindow,
  getReservationStartOptionsCore,
  lapseNoShowReservationsCore,
  seatReservationCore,
  type FreeTable,
  type StartOption,
} from '@/lib/reservations/service'
import { ReservationConflictError } from '@/lib/reservations/guard'
import { reservationEnd, validateReservationSettings, type ReservationSettings } from '@/lib/reservations/rules'
import { applyReservationSettings } from '@/lib/reservations/settings-write'
import { getReservationSettingsCore } from '@/lib/reservations/settings'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

const MODULE = 'module.table_reservations'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof BookingError || e instanceof EntitlementError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const pg = pgError(e)
  // The exclusion constraint on booking_slots: someone took the table for an
  // overlapping time between our check and our insert.
  if (pg?.code === '23P01') return { error: 'That table was just reserved for an overlapping time. Pick another table or time.' }
  // idx_bookings_open_table_session (0071): another party sits there right now.
  if (pg?.code === '23505' && pg.constraint === 'idx_bookings_open_table_session') {
    return { error: 'That table is occupied right now. Pick another table.' }
  }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

/** Restaurant-only, plan-gated, floor-roles-only — enforced here, not by hiding UI. */
async function requireReservationStaff() {
  const ctx = await requireContext()
  if (ctx.tenant.industry !== 'restaurant') throw new AuthError('Table reservations are for restaurant venues.')
  if (!canManageWalkins(ctx.role)) throw new AuthError('You don’t have permission to manage reservations.')
  await requireEntitlement(ctx, MODULE)
  return ctx
}

const phoneField = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || isValidPhone(v), 'Enter a valid 10-digit phone number.')

const createInput = z.object({
  branchId: z.string().uuid(),
  resourceId: z.string().uuid(),
  startsAt: z.string().datetime(),
  durationMinutes: z.coerce.number().int().optional(),
  partySize: z.coerce.number().int().positive('Party size must be at least 1.'),
  customerName: z.string().trim().min(1, 'Enter the guest’s name.'),
  customerPhone: phoneField,
  notes: z.string().trim().max(500).optional(),
})

export async function createReservation(
  input: z.input<typeof createInput>,
): Promise<Result & { bookingId?: string; bookingNumber?: string }> {
  try {
    const ctx = await requireReservationStaff()
    const v = createInput.parse(input)
    await sweepTenantHolds(ctx.tenant.id)
    const r = await withUser(ctx.user.id, (tx) =>
      createReservationCore(
        tx,
        { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId },
        v,
        'staff',
      ),
    )
    revalidatePath('/reservations')
    revalidatePath('/floor')
    return { bookingId: r.id, bookingNumber: r.bookingNumber }
  } catch (e) {
    return fail(e)
  }
}

const seatInput = z.object({
  bookingId: z.string().uuid(),
  resourceId: z.string().uuid().optional(),
  coverCount: z.coerce.number().int().positive('Guest count must be at least 1.').optional(),
  overrideReservation: z.boolean().optional(),
})

/** One tap on arrival: turn the reservation into a seated table session. */
export async function seatReservation(
  input: z.input<typeof seatInput>,
): Promise<Result & { bookingId?: string; tableName?: string; coverCount?: number; reservationConflict?: boolean }> {
  try {
    const ctx = await requireReservationStaff()
    const v = seatInput.parse(input)
    const r = await withUser(ctx.user.id, (tx) =>
      seatReservationCore(
        tx,
        { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId },
        v,
      ),
    )
    revalidatePath('/reservations')
    revalidatePath('/floor')
    return { bookingId: r.bookingId, tableName: r.tableName, coverCount: r.coverCount }
  } catch (e) {
    if (e instanceof ReservationConflictError) return { error: e.message, reservationConflict: true }
    return fail(e)
  }
}

const cancelInput = z.object({ bookingId: z.string().uuid(), reason: z.string().trim().min(1, 'Please give a reason.').max(300) })

export async function cancelReservation(input: z.input<typeof cancelInput>): Promise<Result> {
  try {
    const ctx = await requireReservationStaff()
    const v = cancelInput.parse(input)
    await withUser(ctx.user.id, async (tx) => {
      const [b] = await tx
        .select({ id: bookings.id, status: bookings.status, reservedFor: bookings.reservedFor, resourceId: bookings.resourceId })
        .from(bookings)
        .where(and(eq(bookings.id, v.bookingId), eq(bookings.tenantId, ctx.tenant.id)))
        .for('update')
        .limit(1)
      if (!b || !b.reservedFor) throw new BookingError('Reservation not found.')
      if (b.resourceId) throw new BookingError('This party is already seated.')
      if (b.status === 'cancelled') return
      if (b.status !== 'confirmed' && b.status !== 'no_show') {
        throw new BookingError(`This reservation is ${b.status.replace('_', ' ')} and can’t be cancelled.`)
      }
      await tx
        .update(bookings)
        .set({ status: 'cancelled', cancelledAt: new Date(), cancellationReason: v.reason })
        .where(and(eq(bookings.id, b.id), eq(bookings.tenantId, ctx.tenant.id)))
    })
    revalidatePath('/reservations')
    revalidatePath('/floor')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/** Mark a reservation a no-show by hand, before the automatic grace elapses. */
export async function markReservationNoShow(bookingId: string): Promise<Result> {
  try {
    const ctx = await requireReservationStaff()
    const id = z.string().uuid().parse(bookingId)
    await withUser(ctx.user.id, async (tx) => {
      const [b] = await tx
        .select({ status: bookings.status, reservedFor: bookings.reservedFor, resourceId: bookings.resourceId })
        .from(bookings)
        .where(and(eq(bookings.id, id), eq(bookings.tenantId, ctx.tenant.id)))
        .for('update')
        .limit(1)
      if (!b || !b.reservedFor) throw new BookingError('Reservation not found.')
      if (b.resourceId || b.status !== 'confirmed') throw new BookingError('Only an upcoming reservation can be marked no-show.')
      await tx
        .update(bookings)
        .set({ status: 'no_show' })
        .where(and(eq(bookings.id, id), eq(bookings.tenantId, ctx.tenant.id)))
    })
    revalidatePath('/reservations')
    revalidatePath('/floor')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/** Sweep overdue no-shows now (also run lazily by the list and the floor). */
export async function lapseNoShows(): Promise<Result & { lapsed?: number }> {
  try {
    const ctx = await requireReservationStaff()
    const r = await withUser(ctx.user.id, (tx) => lapseNoShowReservationsCore(tx, ctx.tenant.id))
    if (r.lapsed > 0) {
      revalidatePath('/reservations')
      revalidatePath('/floor')
    }
    return { lapsed: r.lapsed }
  } catch (e) {
    return fail(e)
  }
}

const dateInput = z.object({ branchId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })

/** Start times with at least one free table, for the staff form's time picker. */
export async function getReservationTimes(
  input: z.input<typeof dateInput>,
): Promise<Result & { options?: StartOption[]; durationMinutes?: number }> {
  try {
    const ctx = await requireReservationStaff()
    const v = dateInput.parse(input)
    const r = await withUser(ctx.user.id, (tx) =>
      getReservationStartOptionsCore(tx, { id: ctx.tenant.id, timezone: ctx.tenant.timezone }, v, 'staff'),
    )
    return r
  } catch (e) {
    return fail(e)
  }
}

const freeTablesInput = z.object({ branchId: z.string().uuid(), startsAt: z.string().datetime() })

/** Tables free for the venue's reservation length from `startsAt`. */
export async function getFreeReservationTables(
  input: z.input<typeof freeTablesInput>,
): Promise<Result & { tables?: FreeTable[] }> {
  try {
    const ctx = await requireReservationStaff()
    const v = freeTablesInput.parse(input)
    const tables = await withUser(ctx.user.id, async (tx) => {
      const s = await getReservationSettingsCore(tx, ctx.tenant.id)
      const start = new Date(v.startsAt)
      return freeTablesForWindow(tx, ctx.tenant.id, v.branchId, start, reservationEnd(start, s.defaultDurationMinutes))
    })
    return { tables }
  } catch (e) {
    return fail(e)
  }
}

const settingsInput = z.object({
  enabled: z.boolean(),
  defaultDurationMinutes: z.coerce.number().int(),
  noShowGraceMinutes: z.coerce.number().int(),
  walkinBufferMinutes: z.coerce.number().int(),
  publicEnabled: z.boolean(),
  maxPartySize: z.coerce.number().int(),
  waitlistEnabled: z.boolean(),
})

/** Turn reservations on/off and set the knobs — owner/manager only. */
export async function saveReservationSettings(input: z.input<typeof settingsInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    if (ctx.tenant.industry !== 'restaurant') throw new AuthError('Table reservations are for restaurant venues.')
    // This screen also hosts the waitlist switch (M20 / 0151), so either plan module opens it.
    if (!(await hasEntitlement(ctx, 'module.waitlist'))) await requireEntitlement(ctx, MODULE)
    const v: ReservationSettings = settingsInput.parse(input)
    const problem = validateReservationSettings(v)
    if (problem) return { error: problem }
    await withUser(ctx.user.id, (tx) =>
      applyReservationSettings(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, v),
    )
    revalidatePath('/settings/reservations')
    revalidatePath('/waitlist')
    revalidatePath('/reservations')
    revalidatePath('/floor')
    revalidatePath('/', 'layout')
    return {}
  } catch (e) {
    return fail(e)
  }
}
