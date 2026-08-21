'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canBill } from '@/lib/auth/roles'
import {
  PaymentError,
  recordPaymentForInvoice,
  recordPaymentInputSchema,
} from '@/lib/billing/payments'
import { zodErrorMessage } from '@/lib/utils/errors'

type RecordPaymentResult = {
  error?: string
  paymentId?: string
  paid?: number
  balance?: number
  settled?: boolean
}

/** Same shape as lib/actions/billing.ts:fail() — only safe text reaches the till. */
function fail(e: unknown): RecordPaymentResult {
  if (e instanceof AuthError || e instanceof PaymentError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  console.error('[payments] recordPayment failed:', e)
  return { error: 'Could not record the payment. Please try again.' }
}

/**
 * Record one tender against an issued invoice.
 *
 * The client sends an invoice id, a method and an amount — never a total, a
 * balance, a branch, a tenant or a membership. The invoice is re-read and
 * row-locked server-side, and the balance is recomputed from the captured
 * payments actually in the database.
 */
export async function recordPayment(
  input: z.input<typeof recordPaymentInputSchema>,
): Promise<RecordPaymentResult> {
  try {
    const ctx = await requireContext()
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to record payments.')
    }
    const v = recordPaymentInputSchema.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      recordPaymentForInvoice(
        tx,
        { tenantId: ctx.tenant.id, membershipId: ctx.membershipId },
        v,
      ),
    )

    // The POS screen is keyed by booking, so revalidate the invoice's own
    // booking page. bookingId is read server-side from the invoice, never sent.
    if (result.bookingId) revalidatePath(`/pos/${result.bookingId}`)
    revalidatePath('/bookings')

    return {
      paymentId: result.paymentId,
      paid: result.paid,
      balance: result.balance,
      settled: result.settled,
    }
  } catch (e) {
    return fail(e)
  }
}
