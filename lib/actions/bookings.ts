'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { bookings, bookingSlots } from '@/db/schema'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { createBookingCore, seatTableSessionCore, BookingError } from '@/lib/booking/service'
import { cancelOpenOrdersForBooking } from '@/lib/orders/service'
import { isValidPhone } from '@/lib/customers/phone'
import { findCustomerByRawPhone } from '@/lib/customers/service'
import { zodErrorMessage } from '@/lib/utils/errors'

type CreateResult = { error?: string; bookingId?: string; bookingNumber?: string }
type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof BookingError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  // 23P01 = exclusion_violation: the exclusion constraint caught an overlap.
  if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23P01') {
    return { error: 'That time was just taken for one of the selected resources. Please pick another slot.' }
  }
  // 23505 on idx_bookings_open_table_session = someone else just seated this
  // table (see 0064_table_sessions.sql) — the DB caught the race, not us.
  if (
    e &&
    typeof e === 'object' &&
    'code' in e &&
    (e as { code?: string }).code === '23505' &&
    (e as { constraint?: string }).constraint === 'idx_bookings_open_table_session'
  ) {
    return { error: 'This table was just seated by someone else. Pick another table.' }
  }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

const createInput = z.object({
  branchId: z.string().uuid(),
  customerName: z.string().trim().min(1, 'Customer name is required.'),
  customerPhone: z
    .string()
    .trim()
    .min(1, 'Phone number is required.')
    .refine((v) => isValidPhone(v), 'Enter a valid 10-digit phone number.'),
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

    const result = await withUser(ctx.user.id, (tx) =>
      createBookingCore(tx, { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId }, v),
    )

    revalidatePath('/bookings')
    return { bookingId: result.id, bookingNumber: result.bookingNumber }
  } catch (e) {
    return fail(e)
  }
}

const seatTableInput = z.object({
  branchId: z.string().uuid(),
  resourceId: z.string().uuid(),
  coverCount: z.coerce.number().int().positive('Guest count must be at least 1.'),
  customerName: z.string().trim().optional(),
  customerPhone: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || isValidPhone(v), 'Enter a valid 10-digit phone number.'),
  notes: z.string().trim().optional(),
})

/**
 * Seat a walk-in party at a table (M17 #1) — the restaurant-only sibling of
 * createBooking. Gated at the action layer, not just by hiding the UI: a
 * non-restaurant tenant that somehow reaches this action (a stale tab, a
 * replayed request) gets rejected here regardless of what the client sent,
 * per the epic's "industry-gated" rule.
 */
export async function seatTable(input: z.input<typeof seatTableInput>): Promise<CreateResult> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry !== 'restaurant') {
      throw new AuthError('Table service is not enabled for this business.')
    }
    const v = seatTableInput.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      seatTableSessionCore(
        tx,
        { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId },
        v,
      ),
    )

    revalidatePath('/floor')
    return { bookingId: result.id, bookingNumber: result.bookingNumber }
  } catch (e) {
    return fail(e)
  }
}

/**
 * Flag a table session's bill as requested (M17 #2) — the floor map's
 * "bill_requested" status has no other signal to derive it from (see
 * lib/booking/table-status.ts), so this just stamps the timestamp.
 * Industry-gated like seatTable: the column only means anything for a
 * table session, but the gate is enforced here, not assumed from the column
 * being unused elsewhere.
 */
export async function requestBill(bookingId: string): Promise<Result> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry !== 'restaurant') {
      throw new AuthError('Table service is not enabled for this business.')
    }
    await withUser(ctx.user.id, (tx) =>
      tx
        .update(bookings)
        .set({ billRequestedAt: new Date() })
        .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenant.id))),
    )
    revalidatePath('/floor')
    return {}
  } catch (e) {
    return fail(e)
  }
}

type CustomerLookupResult = { found: boolean; name: string | null }

/**
 * Phone-first walk-in flow: staff enter the phone before the name, and if
 * that number already has a customer profile we skip asking for the name at
 * all. Safe to return the stored name here (unlike the public booking site's
 * lookupPublicCustomerByPhone) — the caller is an authenticated staff member
 * who can already see this in the customer directory.
 */
export async function lookupCustomerByPhone(phone: string): Promise<CustomerLookupResult> {
  try {
    const ctx = await requireContext()
    if (!isValidPhone(phone)) return { found: false, name: null }
    const customer = await withUser(ctx.user.id, (tx) => findCustomerByRawPhone(tx, ctx.tenant.id, phone))
    return { found: Boolean(customer), name: customer?.name ?? null }
  } catch {
    return { found: false, name: null }
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
    revalidatePath('/floor')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function cancelBooking(id: string): Promise<Result> {
  return setBookingStatus(id, 'cancelled')
}

const CONFIRMATION_TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** A scanned QR encodes the full confirmation URL; a keyboard-wedge scanner
 * or manual paste might supply just the bare token. Either way, the
 * confirmation_token is the only UUID in the string. */
function extractConfirmationToken(raw: string): string | null {
  const match = raw.match(CONFIRMATION_TOKEN_RE)
  return match ? match[0].toLowerCase() : null
}

export type CheckInResult = Result & {
  booking?: {
    bookingNumber: string
    customerName: string | null
    resourceName: string | null
    startsAt: string | null
    alreadyCheckedIn: boolean
  }
}

/**
 * Staff check-in scan (components/bookings/ScanCheckIn.tsx): resolves a
 * booking by its confirmation_token — never by bookingNumber, same
 * unguessable-identifier rule as the public confirmation page (see
 * 0026_booking_confirmation_token.sql) — and transitions it to checked_in,
 * the same status write setBookingStatus above does.
 */
export async function checkInBookingByToken(raw: string): Promise<CheckInResult> {
  try {
    const ctx = await requireContext()
    const token = extractConfirmationToken(raw)
    if (!token) return { error: "That doesn't look like a booking QR code." }

    const result = await withUser(ctx.user.id, async (tx) => {
      const [row] = await tx
        .select({
          id: bookings.id,
          bookingNumber: bookings.bookingNumber,
          customerName: bookings.customerName,
          status: bookings.status,
        })
        .from(bookings)
        .where(and(eq(bookings.tenantId, ctx.tenant.id), eq(bookings.confirmationToken, token)))
        .limit(1)
      if (!row) return null

      const [slot] = await tx
        .select({ resourceName: bookingSlots.resourceName, startsAt: bookingSlots.startsAt })
        .from(bookingSlots)
        .where(and(eq(bookingSlots.tenantId, ctx.tenant.id), eq(bookingSlots.bookingId, row.id)))
        .orderBy(bookingSlots.startsAt)
        .limit(1)

      if (row.status === 'checked_in') {
        return { row, slot, alreadyCheckedIn: true }
      }
      if (row.status !== 'confirmed') {
        throw new BookingError(`This booking is ${row.status.replace('_', ' ')} — it can't be checked in.`)
      }

      await tx
        .update(bookings)
        .set({ status: 'checked_in', checkedInAt: new Date() })
        .where(and(eq(bookings.id, row.id), eq(bookings.tenantId, ctx.tenant.id)))

      return { row, slot, alreadyCheckedIn: false }
    })

    if (!result) return { error: 'No booking found for that code.' }

    revalidatePath('/bookings')
    return {
      booking: {
        bookingNumber: result.row.bookingNumber,
        customerName: result.row.customerName,
        resourceName: result.slot?.resourceName ?? null,
        startsAt: result.slot?.startsAt.toISOString() ?? null,
        alreadyCheckedIn: result.alreadyCheckedIn,
      },
    }
  } catch (e) {
    return fail(e)
  }
}
