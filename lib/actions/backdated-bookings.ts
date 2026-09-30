'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { BookingError } from '@/lib/booking/service'
import { recordBackdatedBookingCore, previewBackdatedBooking, type BackdatedPreview } from '@/lib/booking/backdated'
import { BillingError } from '@/lib/billing/invoice'
import { PaymentError, POS_PAYMENT_METHODS, MAX_PAYMENT_AMOUNT } from '@/lib/billing/payments'
import { isValidPhone } from '@/lib/customers/phone'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type RecordResult = {
  error?: string
  bookingId?: string
  bookingNumber?: string
  invoiceId?: string
  invoiceNumber?: string
  completed?: boolean
}

const recordBackdatedInput = z.object({
  branchId: z.string().uuid(),
  customerName: z.string().trim().min(1, 'Customer name is required.'),
  customerPhone: z
    .string()
    .trim()
    .min(1, 'Phone number is required.')
    .refine((v) => isValidPhone(v), 'Enter a valid 10-digit phone number.'),
  customerEmail: z.string().trim().email().optional().or(z.literal('')),
  notes: z.string().trim().optional(),
  slots: z
    .array(
      z.object({
        resourceId: z.string().uuid(),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
        setupId: z.string().uuid().optional(),
      }),
    )
    .min(1, 'Add at least one resource slot'),
  headCount: z.coerce.number().int().min(1).optional(),
  amountCollected: z.coerce
    .number({ invalid_type_error: 'Enter a valid amount.' })
    .finite('Enter a valid amount.')
    .min(0, 'Amount collected must be zero or more.')
    .max(MAX_PAYMENT_AMOUNT, 'That amount is too large.'),
  paymentMethod: z.enum(POS_PAYMENT_METHODS, { errorMap: () => ({ message: 'Choose cash, card or UPI.' }) }),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
})

function fail(e: unknown): RecordResult {
  if (e instanceof AuthError || e instanceof BookingError || e instanceof BillingError || e instanceof PaymentError) {
    return { error: e.message }
  }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  // 23P01 = exclusion_violation: the slot overlaps an existing booking.
  if (pgError(e)?.code === '23P01') {
    return { error: 'That time was just taken for one of the selected resources. Please pick another slot.' }
  }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

/**
 * Owner/manager back-fill of a session that already happened (up to 7 days
 * back): creates, bills and settles the booking in one transaction. The window
 * is enforced server-side inside recordBackdatedBookingCore.
 */
export async function recordBackdatedBooking(input: z.input<typeof recordBackdatedInput>): Promise<RecordResult> {
  try {
    const ctx = await requireManager()
    const v = recordBackdatedInput.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      recordBackdatedBookingCore(
        tx,
        { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId },
        { ...v, customerEmail: v.customerEmail || undefined },
      ),
    )

    revalidatePath('/bookings')
    return result
  } catch (e) {
    return fail(e)
  }
}

// The customer is optional for a preview (the form previews before it is
// filled in); a valid phone is still passed so any membership benefit prices in.
const previewBackdatedInput = recordBackdatedInput
  .pick({ branchId: true, slots: true, headCount: true })
  .extend({ customerPhone: z.string().trim().optional() })

/**
 * Live price preview for the "Record a past booking" form. Manager-gated like
 * the action itself; writes nothing (the real create + invoice path runs in a
 * transaction that is rolled back — see previewBackdatedBooking).
 */
export async function quoteBackdatedBooking(
  input: z.input<typeof previewBackdatedInput>,
): Promise<{ error?: string; preview?: BackdatedPreview }> {
  try {
    const ctx = await requireManager()
    const v = previewBackdatedInput.parse(input)
    const preview = await previewBackdatedBooking(
      (fn) => withUser(ctx.user.id, fn),
      { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId },
      { ...v, customerPhone: v.customerPhone && isValidPhone(v.customerPhone) ? v.customerPhone : undefined },
    )
    return { preview }
  } catch (e) {
    return fail(e)
  }
}
