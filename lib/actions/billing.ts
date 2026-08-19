'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canBill } from '@/lib/auth/roles'
import { BillingError, issueInvoiceForBooking } from '@/lib/billing/invoice'
import { zodErrorMessage } from '@/lib/utils/errors'

type CreateInvoiceResult = { error?: string; invoiceId?: string; invoiceNumber?: string }

/**
 * Errors a cashier is allowed to read. Anything else is a bug or a driver
 * error, and its text must not reach the till — the same shape as
 * lib/actions/bookings.ts:fail().
 */
function fail(e: unknown): CreateInvoiceResult {
  if (e instanceof AuthError || e instanceof BillingError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  // 23505 = unique_violation on (tenant_id, invoice_number): a number collided
  // despite the atomic counter. Retrying is safe, so say so rather than leaking.
  if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505') {
    return { error: 'That bill was just raised by someone else. Refresh and try again.' }
  }
  console.error('[billing] createInvoiceForBooking failed:', e)
  return { error: 'Could not raise the bill. Please try again.' }
}

const createInvoiceInput = z.object({
  bookingId: z.string().uuid(),
  // Non-negative and finite. priceBill caps it at the subtotal as well, so a
  // discount can never produce a negative total even if this were bypassed.
  discount: z.coerce.number().min(0, 'Discount cannot be negative.').finite().optional(),
  promoCode: z.string().trim().max(64).optional(),
  // Only a COUNT of loyalty points. The rupee value, the cap against what is
  // still owed, and the ledger debit are all decided server-side from the
  // tenant's rule and the customer's balance — never from the browser.
  redeemPoints: z.coerce
    .number()
    .int('Points must be a whole number.')
    .nonnegative('Points cannot be negative.')
    .finite()
    .optional(),
})

/**
 * Raise the invoice for a booking.
 *
 * The browser sends a booking id and (at most) a discount and promo code —
 * never prices, quantities, tax rates or totals. Every line and every rupee is
 * re-read from the database inside the transaction and recomputed by priceBill.
 */
export async function createInvoiceForBooking(
  input: z.input<typeof createInvoiceInput>,
): Promise<CreateInvoiceResult> {
  try {
    const ctx = await requireContext()
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to raise a bill.')
    }
    const v = createInvoiceInput.parse(input)

    const issued = await withUser(ctx.user.id, (tx) =>
      issueInvoiceForBooking(tx, { id: ctx.tenant.id, timezone: ctx.tenant.timezone }, v),
    )

    revalidatePath('/bookings')
    return { invoiceId: issued.invoiceId, invoiceNumber: issued.invoiceNumber }
  } catch (e) {
    return fail(e)
  }
}
